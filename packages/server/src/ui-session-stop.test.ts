// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SESSIONS_PATH, workerEventsStreamPath, workerRegisterPath } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer, type ServerConfig } from "./index.js";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions, SurfaceLiveness } from "./session-launcher.js";
import { isStopFailureCode, STOP_FAILURE_CODES } from "./ui-session-stop.js";

// The EMERGENCY-STOP path (#76), exercised END TO END through the wired server: a real HTTP
// `POST /api/sessions/{id}/stop` (routing + handler + the addressing that finds the named session's
// terminal + the safety envelope + the terminal transition), plus the programmatic
// `CcctlServer.stopSession`. The launcher is a recording FAKE — no tmux / pty is spawned — and each
// handle reports whatever liveness its scenario needs, which is how "the operator took it over" is
// expressed. The rule itself is unit-tested in isolation (`session-release.test.ts`); the terminal
// transition in `session-close.test.ts`. The launched worker's own §2 registration is DRIVEN directly
// against the bridge leg here, exactly as `ui-session-launch.test.ts` does — which is what a real
// worker does.

/** Two REAL directories — the launch pre-flight rejects a cwd that does not exist, so a test cwd must. */
const CWD = process.cwd();
const OTHER_CWD = tmpdir();

/**
 * A recording fake launcher. Every handle it hands out reports the launcher's CURRENT `liveness`, so a
 * test flips it to stage what happened to a surface AFTER it was launched (`setLiveness("taken-over")`
 * IS "the operator attached at their desk"). `closeCount` is the assertion that a surface was — or,
 * far more often here, was NOT — killed: `close()` is the only destructive verb a handle has.
 */
function fakeLauncher({ hint = "tmux select-window -t @3 ; attach -t ccctl", closeError = null as unknown } = {}) {
  let closes = 0;
  const state = { liveness: "alive-server-owned" as SurfaceLiveness };
  const launcher: ISessionLauncher = {
    launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
      // PER-SURFACE, deliberately not per-launcher: one launcher hands out many surfaces over its
      // life, and closing one says nothing about the others. `setLiveness` stays shared (it is the
      // knob a test uses to say "the operator took it over"), but being CLOSED is a fact about one
      // terminal — a launcher-wide flag would report a freshly relaunched session as already dead,
      // which is precisely the stop-then-relaunch case this suite has to be able to see.
      let exited = false;
      return Promise.resolve({
        attachment: { attachable: true, hint },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve(exited ? "exited" : state.liveness),
        close: (): Promise<void> => {
          closes += 1;
          if (closeError !== null) {
            return Promise.reject(closeError);
          }
          // A close that RESOLVES leaves the surface gone, so the next probe must say so. Both real
          // backends do exactly this (the pty flips its `exited` flag; tmux's window stops being
          // listed), and modelling it is not garnish: `stopLaunchedSession` re-reads the surface after
          // a close precisely to catch a backend whose close resolves over a live surface. A fake that
          // answered `alive-server-owned` forever would be asserting that bug is fine.
          exited = true;
          return Promise.resolve();
        },
      });
    },
  };
  return {
    launcher,
    closeCount: (): number => closes,
    setLiveness: (liveness: SurfaceLiveness): void => {
      state.liveness = liveness;
    },
  };
}

/**
 * The window the one ghost-reaper case below arms (#33), and why it is not the 20ms it used to be.
 *
 * That case acts INSIDE the window it arms — its refusal has to be read while the row still exists —
 * and an armed window is a budget spent in WALL-CLOCK on a loaded host, not in test-steps. Two loopback
 * round-trips do not fit in 20ms under full-suite load, so the reaper took the row first and the stop
 * answered 404 `unknown-session` rather than the 409 the case is about: a "flake" that was the timer
 * doing its job. #231 measured such round-trips at ~34ms apiece under full-suite CPU contention, so
 * 500ms clears this case's two by ~7x. Named for the work that has to fit inside it, as the sibling
 * `ui-session-launch.test.ts` names its own — that file carries the full rule and the rest of this
 * shape's cases.
 */
const REFUSAL_WINDOW_MS = 500;
/** Margin past the window, for the reaper's asynchronous terminal half (#35's probe) to have run. */
const PAST_WINDOW_MS = 100;

/** Await roughly `ms` of real time — the eviction timers are real one-shots, as in the #173 suite. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const started: CcctlServer[] = [];

async function startTestServer(config: ServerConfig): Promise<CcctlServer> {
  const server = await startServer(config);
  started.push(server);
  return server;
}

afterEach(async () => {
  while (streams.length > 0) {
    streams.pop()?.destroy();
  }
  while (started.length > 0) {
    const server = started.pop();
    if (server) {
      await server.close();
    }
  }
});

function base(server: CcctlServer): string {
  return `http://${server.address.host}:${server.address.port}`;
}

/** `POST /api/sessions/{id}/stop` — the emergency-stop the #77 button and `ccctl stop` will both drive. */
function postStop(server: CcctlServer, sessionId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base(server)}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Launch a session through the wired ingress and hand back the id the server minted for it. */
async function launch(server: CcctlServer, cwd = CWD): Promise<string> {
  const res = await fetch(`${base(server)}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, permissionMode: "default" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/**
 * Drive the §2 registration a launched worker performs — rooted at the cwd it was launched at, under
 * the mode it was launched with, which is the pair the server claims its pending launch on (#33). This
 * is what turns a `registering` row into a LIVE session, and it is also what CONSUMES the only
 * session-keyed record that used to hold a terminal handle — so a stop that works after this has
 * genuinely found the surface by id rather than by the pending record.
 */
function registerWorker(server: CcctlServer, cwd = CWD, permissionMode = "default"): Promise<Response> {
  return fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer acct-token" },
    body: JSON.stringify({
      session_context: { model: "claude-opus-4-8", cwd },
      source: "ui",
      permission_mode: permissionMode,
    }),
  });
}

const streams: IncomingMessage[] = [];

/**
 * §4 — bring a session's WORKER CHANNEL up: register the channel, then hold its downstream open.
 * Together those are what make `hasLiveWorker` true — a record with a live downstream is exactly the
 * precondition a steer is pushed down. Distinct from the §2 leg {@link registerWorker} drives above:
 * that one makes the SESSION real; this one makes its worker reachable.
 */
async function bringWorkerChannelUp(server: CcctlServer, sessionId: string): Promise<void> {
  const registered = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(registered.status).toBe(200);
  await openWorkerStream(server, sessionId);
}

/**
 * §4 — open the held-open downstream. Frames are drained and discarded: this suite observes the
 * CHANNEL's lifetime, not its traffic — `worker-channel.test.ts` owns the frames.
 */
function openWorkerStream(server: CcctlServer, sessionId: string): Promise<void> {
  const { host, port } = server.address;
  return new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port,
        path: workerEventsStreamPath(sessionId),
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res: IncomingMessage) => {
        streams.push(res);
        res.on("error", () => {}); // swallow the reset when the server ends the stream.
        res.resume();
        resolve();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The sessions `GET /api/sessions` currently lists — the operator's own view, the AC's yardstick. */
async function listSessions(server: CcctlServer): Promise<Array<{ id: string; status: string }>> {
  const res = await fetch(`${base(server)}/api/sessions`);
  return ((await res.json()) as { sessions: Array<{ id: string; status: string }> }).sessions;
}

describe("POST /api/sessions/{id}/stop (emergency-stop)", () => {
  // Rule: The server can terminate a specific session's worker/pty on request.
  //
  //   Scenario: The operator stops a running session from their phone
  //     Given a launched session whose worker has registered
  //     When the operator stops it by id
  //     Then that session's terminal is killed and its child reaped
  //     And the session has reached its terminal state
  //     And it is no longer listed
  it("kills a LIVE session's terminal and reports the terminal state it reached (AC1, AC2, AC4)", async () => {
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    // The worker checks in — which CONSUMES the pending record that held this session's handle. Before
    // #76 the terminal was, from this instant, an anonymous member of a set: findable by shutdown and
    // by nothing else. This assertion is the whole point of the addressing.
    expect((await registerWorker(server)).status).toBe(201);
    expect(server.sessions.get(sessionId)?.status).toBe("connecting");

    const res = await postStop(server, sessionId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId, outcome: "stopped", status: "closed" });
    // AC2: the ONE destructive verb a handle has was reached — for the owned pty that closes the fd
    // and AWAITS the child's reaping, which is that backend's own contract (`session-launcher-pty.ts`).
    expect(closeCount()).toBe(1);
    // AC4 "reflected to clients": the row is gone from the operator's list.
    expect(await listSessions(server)).toEqual([]);
    expect(server.hasSessionRelay(sessionId)).toBe(false);
  });

  //   Scenario: The operator stops a launch that hung before its worker ever checked in
  //     Given a session that is still registering
  //     When the operator stops it
  //     Then its terminal is killed
  it("kills a still-`registering` session's terminal — the launch that never came up (AC1)", async () => {
    // The sharpest case for why a stop is NOT a `/command` subtype: this session has no worker channel
    // at all, so every steer verb — `interrupt` included — fails closed 409 against it. A stop built on
    // the command leg would be unable to fire in one of the two situations it exists for.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    expect(server.sessions.get(sessionId)?.status).toBe("registering");
    expect(server.hasLiveWorker(sessionId)).toBe(false);

    const res = await postStop(server, sessionId);

    expect(res.status).toBe(200);
    expect(closeCount()).toBe(1);
    expect(await listSessions(server)).toEqual([]);
  });

  //   Scenario: One of several sessions is stopped
  //     Given two launched sessions
  //     When the operator stops the first
  //     Then only the first is stopped and the second is untouched
  it("stops ONLY the session named in the URL — never a sibling (#20 never cross-wired)", async () => {
    // The addressing itself, pinned. A stop that resolved the WRONG handle would kill the wrong
    // operator's conversation, and every other assertion in this file would still pass — each one
    // stops the only session there is, so none of them can tell "found the named session's surface"
    // from "found the only surface". This one can: two sessions, and the survivor has to survive.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const targetId = await launch(server);
    const survivorId = await launch(server, OTHER_CWD);

    const res = await postStop(server, targetId);

    expect(res.status).toBe(200);
    expect(closeCount()).toBe(1); // exactly ONE surface was killed, not both.
    // The registry is the yardstick: the survivor is still listed, the target is gone. (`closeCount`
    // alone cannot say WHICH surface died — both handles come from one launcher — so the list is what
    // discriminates a correctly-addressed stop from a lucky one.)
    expect((await listSessions(server)).map((session) => session.id)).toEqual([survivorId]);
    expect(server.sessions.has(targetId)).toBe(false);
  });

  it("drops the stopped session's handle — shutdown will not re-close a dead terminal (AC2)", async () => {
    // A handle left behind names a surface that no longer exists. Shutdown would probe and re-close it
    // — harmless today only because `close()` is idempotent, and NOT harmless the moment an id is
    // reused. The count is the assertion: one stop, one close, and the server's own teardown adds none.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    expect((await postStop(server, sessionId)).status).toBe(200);
    expect(closeCount()).toBe(1);

    await server.close();
    started.length = 0; // already closed; keep afterEach from double-closing it.

    expect(closeCount()).toBe(1);
  });

  // Rule: A session the operator has taken over is not killed without an explicit force.
  //
  //   Scenario: The operator asks to stop a session they are driving at their desk
  //     Given a launched session the operator has attached to and taken over
  //     When they stop it WITHOUT force
  //     Then it is not killed
  //     And they are told where it is and how to force it
  it("REFUSES to kill a taken-over session, and tells the operator where it is (AC3)", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher({ hint: "tmux select-window -t @7 ; attach -t ccctl" });
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("taken-over"); // the operator attached at their desk and is driving it by hand.

    const res = await postStop(server, sessionId);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("taken-over");
    // The refusal carries the surface's OWN attach hint, which turns "no" into an instruction: the
    // operator is told WHERE the session they asked to stop actually is. Both of their moves are named.
    expect(body.error).toContain("tmux select-window -t @7 ; attach -t ccctl");
    expect(body.error).toContain("force");
    // "it is not killed": the operator keeps working in it.
    expect(closeCount()).toBe(0);
    // And a refusal changes NOTHING — the session is still there, still live, still theirs. That is
    // what makes it safe to retry, and it is why a refusal must not be a 200 with a sad body.
    expect(server.sessions.get(sessionId)?.status).toBe("registering");
  });

  //   Scenario: The operator forces a stop on a session they took over
  //     Given a launched session the operator has taken over
  //     When they stop it WITH an explicit force
  //     Then it is killed
  it("kills a taken-over session when the operator explicitly forces it — the safety valve (AC3)", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("taken-over");

    const res = await postStop(server, sessionId, { force: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId, outcome: "stopped", status: "closed" });
    expect(closeCount()).toBe(1);
    expect(await listSessions(server)).toEqual([]);
  });

  it("does NOT force on anything but a literal `true` — a string cannot kill a session (AC3)", async () => {
    // `"true"`, `1` and `"yes"` are all truthy in JavaScript and none of them is an operator saying
    // yes; they are a client with a bug, a form serializer, or a hand-written curl. Everywhere else a
    // fail-closed parse protects the SERVER from a malformed request — here it protects a session the
    // operator is working in from being killed by a coercion. The failure direction is what makes this
    // safe: not-exactly-`true` is not force, so the worst a wrong spelling does is refuse.
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    setLiveness("taken-over");

    for (const force of ["true", 1, "yes", {}, [], "force"]) {
      const sessionId = await launch(server);
      const res = await postStop(server, sessionId, { force });

      // Refused as MALFORMED rather than quietly read as `false`: a caller who wrote `force: "true"`
      // believes they forced it, and answering the refusal they did not ask about would teach them
      // their spelling works — right up until the day it silently does not.
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("malformed-request");
    }
    expect(closeCount()).toBe(0);
  });

  it("refuses a session whose liveness could not be READ — even forced, and says so precisely", async () => {
    // Distinct from `taken-over` on purpose. Both refuse, but they are different news and only one of
    // them is the operator's doing — telling them "you have this open at your desk" when the truth is
    // "tmux could not be reached" fabricates a claim they would act on. And force deliberately does not
    // reach here: on the pty this reading is unreachable, and on tmux it means the CLI could not be
    // reached at all — so `close()` would travel the same failed runner, swallow its error, and report a
    // kill that never happened. See `session-release.ts` § FORCED_STOP_BY_LIVENESS.
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("host-unreachable");

    const res = await postStop(server, sessionId, { force: true });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("liveness-unknown");
    // No force to OFFER: it would not work here. The sentence may explain that forcing is futile, but it
    // must never read as an invitation — `\`{ force: true }\`` is the invitation this ingress writes for
    // the refusals force resolves, and it must not appear on the one it does not.
    expect(body.error).not.toContain("{ force: true }");
    expect(closeCount()).toBe(0);
    // Untouched — the session stays exactly as it was.
    expect(server.sessions.has(sessionId)).toBe(true);
  });

  // Rule: An indeterminate surface refuses UNFORCED and names the move that resolves it (#197).
  //
  //   Scenario: The operator stops a session whose reachable backend will not describe its surface
  //     Given a launched session whose backend reached its host and got no usable answer back
  //     When a stop is requested WITHOUT force
  //     Then the stop is refused with its own typed code
  //     And the refusal offers force, because force is what resolves it
  it("refuses an indeterminate surface unforced, with its OWN code, and offers force (#197)", async () => {
    // The wire half of #197. This reading and `host-unreachable` are one refusal to anything reading the
    // status (both 409) and opposites to the operator: this one they can end from here. Sharing
    // `liveness-unknown` would put a forceable refusal in the not-forceable bucket, and every client
    // switching on the code — #77's stop button via `isForceable`, `ccctl stop`'s `--force` hint —
    // would faithfully hide the one move that works.
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("surface-indeterminate");

    const res = await postStop(server, sessionId, {});

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("liveness-indeterminate");
    // The remedy, named in the wire words this ingress's own clients translate.
    expect(body.error).toContain("{ force: true }");
    expect(closeCount()).toBe(0);
    expect(server.sessions.has(sessionId)).toBe(true);
  });

  // Rule: An explicit force kills a surface whose reachable backend would not report on it (#197).
  it("KILLS an indeterminate surface when forced, and ends the session (#197)", async () => {
    // The end-to-end of the flipped cell, through the real ingress: the host is reachable, so the kill
    // really travels — and everything the session owned is retired, exactly as on any other stop that
    // leaves the surface gone.
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("surface-indeterminate");

    const res = await postStop(server, sessionId, { force: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; outcome: string; status: string };
    expect(body).toMatchObject({ sessionId, outcome: "stopped" });
    expect(closeCount()).toBe(1);
    expect(server.sessions.has(sessionId)).toBe(false);
  });

  //   Scenario: The session already exited on its own
  //     Given a launched session whose surface has already gone
  //     When the operator stops it
  //     Then the stop succeeds without killing anything
  //     And says the session was already gone rather than that it stopped it
  it("succeeds WITHOUT killing anything on an already-exited surface, and says which it was (AC4)", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("exited"); // the worker exited, or the operator closed the window.

    const res = await postStop(server, sessionId);

    // A SUCCESS: the operator asked for the session to be stopped and the session is stopped. That is
    // the whole of what they wanted, and an error here would send them chasing a non-problem.
    expect(res.status).toBe(200);
    // But "I killed it" and "it was already dead" are not the same sentence, and the second is worth
    // knowing — so the outcome distinguishes them even though both satisfy the request.
    expect(await res.json()).toEqual({ sessionId, outcome: "already-exited", status: "closed" });
    expect(closeCount()).toBe(0);
    expect(await listSessions(server)).toEqual([]);
  });

  it("answers 404 for a session that does not exist", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postStop(server, "no-such-session");

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("unknown-session");
  });

  //   Scenario: The operator stops a session ccctl did not launch
  //     Given a session that registered itself over the bridge (a UC1 attach)
  //     When the operator stops it
  //     Then it is refused, honestly, and nothing is stopped
  it("REFUSES a session this server never launched — it holds no handle to kill (AC1)", async () => {
    // A UC1 attach is real, listed and steerable, and its process is not ours: the operator started it
    // themselves and ccctl has no handle to it. Reporting "stopped" here would be the worst lie this
    // ingress could tell — it would end the operator's attention on a session that is still running.
    // Forgetting the row instead ("stop tracking it") would be worse still: it would take away the one
    // lever that DOES work on a UC1 session (an `interrupt` down its live worker channel) and offer the
    // broken one in its place.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const registered = await registerWorker(server, OTHER_CWD);
    expect(registered.status).toBe(201);
    const sessionId = ((await registered.json()) as { session_id: string }).session_id;

    const res = await postStop(server, sessionId);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("no-surface");
    expect(body.error).toContain("interrupt"); // names the lever that still works.
    expect(closeCount()).toBe(0);
    // The session is untouched: still listed, still steerable, still the operator's.
    expect(server.sessions.has(sessionId)).toBe(true);
  });

  //   Scenario: The operator stops a session whose terminal may hold a DIFFERENT session's worker
  //     Given two launches that shared a directory and mode, and a worker that registered from one
  //     When the operator force-stops the survivor
  //     Then it is refused, and no terminal is killed
  it("REFUSES an ambiguous-group survivor — and not even `force` overrides it (#33, #20)", async () => {
    // The subtlest guard in the item, and the one a stop path would most plausibly forget. Two launches
    // shared a (cwd, mode), so #33's rule refused to lend either's id to the registration that arrived
    // — it minted a fresh one and marked the survivor `mayHoldLiveWorker`. The survivor's id→surface
    // mapping is EXACT; what is unknown is which terminal the live worker is sitting in. So killing
    // this one may kill the OTHER session's worker — the coin flip #33 explicitly refused.
    //
    // Force does not reach it, and that is not timidity: force is the operator consenting to destroy
    // THE SESSION THEY NAMED. They cannot consent on behalf of a session they did not name, and #20's
    // never-cross-wired invariant is not theirs to spend. They can close the window by hand.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const first = await launch(server, CWD);
    const second = await launch(server, CWD); // same (cwd, mode) → both ambiguous.
    expect((await registerWorker(server, CWD)).status).toBe(201);
    // #33: the claim consumed `first`'s record and dropped its row (its id could not be lent), so the
    // registration minted a fresh id. `second` survives as a `registering` row that may hold the worker.
    expect(server.sessions.has(first)).toBe(false);
    expect(server.sessions.has(second)).toBe(true);

    const res = await postStop(server, second, { force: true });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("ambiguous-surface");
    expect(closeCount()).toBe(0);
  });

  it("404s a stop on an ambiguous group's CONSUMED launch — its handle outlives its row, unreachably", async () => {
    // The other half of the addressing argument. `first`'s handle stays in the surface map (shutdown
    // still owns it) under an id whose row #33 dropped — so the map genuinely holds an entry keyed by a
    // dead id. It is unreachable for free: a stop resolves the SESSION first and never gets as far as
    // the surface. That is why the map needs no rule about ambiguity of its own — the rule that already
    // refused to lend the id did the work.
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const first = await launch(server, CWD);
    await launch(server, CWD);
    expect((await registerWorker(server, CWD)).status).toBe(201);
    expect(server.sessions.has(first)).toBe(false);

    const res = await postStop(server, first, { force: true });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("unknown-session");
    expect(closeCount()).toBe(0);
  });

  it("answers 502 `stop-failed` when the teardown itself fails — never a false `stopped` (AC2, AC4)", async () => {
    // The one answer an emergency-stop must never give is a success it did not earn. `close()` rejecting
    // is exactly where a stop would drift into one — the swallow that is correct for ccctl's own
    // teardown (a timer has nobody to answer) would here resolve "stopped" over a session that is still
    // running, ending the operator's attention on the one session that needed it.
    const { launcher, closeCount } = fakeLauncher({ closeError: new Error("kill: operation not permitted") });
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    const res = await postStop(server, sessionId);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("stop-failed");
    expect(closeCount()).toBe(1); // we DID try — and we say we failed.
    // The session stays: a stop that could not stop must not tidy the row away, or the operator loses
    // the handle to the very session that is still running.
    expect(server.sessions.has(sessionId)).toBe(true);
  });

  //   Scenario: A stopped session frees its slot
  //     Given a server at its maxSessions cap
  //     When the operator stops one session
  //     Then a further launch succeeds
  it("frees a slot under the `maxSessions` cap — end one, launch another (#36 AC3)", async () => {
    // The cap counts `sessions.size`, and its contract is that the size "falls with every session that
    // ends … which is why a slot frees with no new plumbing". This is that contract, held by the new
    // way a session can end — and it is the test that would have caught the tempting alternative for
    // AC4: leaving the stopped session in the registry AS a readable `closed` row would hold its slot
    // forever, so stopping every session would leave a server permanently at-capacity with nothing
    // running in it. The emergency-stop's own promise would be the first thing it broke.
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, maxSessions: 2 });
    const first = await launch(server);
    await launch(server, OTHER_CWD);

    const refused = await fetch(`${base(server)}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: CWD, permissionMode: "default" }),
    });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe("at-capacity");

    expect((await postStop(server, first)).status).toBe(200);

    // The slot is free — the identical launch now succeeds, unchanged.
    await launch(server);
  });

  it("STOP then RELAUNCH in the same directory — the relaunched session comes up clean (#33 correlation)", async () => {
    // THE emergency-stop workflow, and the one this suite was blind to. Stopping a runaway is half of
    // what an operator does; the other half is starting it again, in the same directory, seconds later.
    //
    // The stop must therefore CONSUME the session's pending launch, not just its row — because a
    // pending record's `(cwd, mode)` IS #33's correlation key. Left behind, the corpse groups with the
    // relaunch, `markAmbiguousGroup` marks BOTH `ambiguous` (a mark nothing ever lifts), and the
    // relaunched worker's own registration is then refused its id: the operator's row never leaves
    // `registering`, a second anonymous row appears beside it, and the session they are watching is
    // unstoppable FOR LIFE — refused `ambiguous-surface`, with a message telling them to go end a
    // terminal by hand that this very server already killed.
    //
    // Note what this test does that the cap test above does NOT: it REGISTERS. The corruption is
    // invisible at launch (a poisoned relaunch still answers 201) and surfaces only when the worker
    // comes up — which is exactly how the cap test performed this whole sequence and asserted green.
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const first = await launch(server);
    expect((await postStop(server, first)).status).toBe(200);

    const relaunched = await launch(server);
    expect((await registerWorker(server)).status).toBe(201);

    // The relaunched session advanced IN PLACE — its worker claimed the id the operator was handed,
    // exactly as it would have if the first session had never existed. One row, and it is theirs.
    expect((await listSessions(server)).map((session) => [session.id, session.status])).toEqual([
      [relaunched, "connecting"],
    ]);

    // And it is still stoppable — the mark that would have made it immortal was never set.
    const stopped = await postStop(server, relaunched);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ sessionId: relaunched, outcome: "stopped", status: "closed" });
  });

  it("reaps the stopped session's worker channel — a stopped session cannot be steered (#173)", async () => {
    // The channel record is the thing a steer is pushed down (`injectUserTurn`'s precondition is
    // exactly `hasLiveWorker`). Left behind by a stop, it is not merely a leak that grows one inert
    // record per stopped session — it is the server still answering "yes, there is a live worker
    // there" about a session the operator just killed, with a held-open stream and whatever timers it
    // had still armed against it.
    //
    // Nothing else would ever come back for it, either: the #173 eviction check that owns the other
    // reap bails the moment a session's row is gone, and a stop's whole job is to drop that row.
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    expect((await registerWorker(server)).status).toBe(201);
    await bringWorkerChannelUp(server, sessionId);
    expect(server.hasLiveWorker(sessionId)).toBe(true);

    expect((await postStop(server, sessionId)).status).toBe(200);

    expect(server.hasLiveWorker(sessionId)).toBe(false);
  });

  it("a REFUSED stop leaves the ghost-reaper armed — a refusal changes nothing, including the timer", async () => {
    // The mirror of the test above, and the reason the retirement block sits AFTER the last refusal
    // rather than before the guards. A stop that consumed the pending launch on its way in would
    // disarm the reaper and THEN refuse — leaving a taken-over ghost that nothing will ever reap,
    // having broken #33 in order to not break #35.
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: REFUSAL_WINDOW_MS,
    });
    const sessionId = await launch(server);
    setLiveness("taken-over");

    // Read while the row still EXISTS — the refusal below is what this case is about, and it is only a
    // refusal for as long as there is something to refuse.
    expect((await postStop(server, sessionId)).status).toBe(409);
    expect(closeCount()).toBe(0);

    // The reaper still fires on schedule. It finds the surface taken over and leaves it running (#35),
    // which is the whole point — but the ROW goes, proving the timer was still armed and still ran.
    // Waited out rather than awaited into: "the surface was NOT closed" is a negative, so there is no
    // state to poll for — the wait has to outlast the window AND the reaper's asynchronous terminal
    // half, or a closeCount still at 0 would only mean the probe had not run yet.
    await sleep(REFUSAL_WINDOW_MS + PAST_WINDOW_MS);
    expect(await listSessions(server)).toEqual([]);
    expect(closeCount()).toBe(0);
  });

  it("fails closed 405 on a non-POST method", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    const res = await fetch(`${base(server)}/api/sessions/${sessionId}/stop`, { method: "GET" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("fails closed 400 on a body that is not a JSON object", async () => {
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    for (const body of ["not json at all", "[]", '"a string"', "null", ""]) {
      const res = await postStop(server, sessionId, body);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("malformed-request");
    }
    // A malformed stop kills nothing — the parse is what stands between arbitrary bytes and a `close()`.
    expect(closeCount()).toBe(0);
  });

  it("accepts a bare `{}` — force is opt-in, so the non-destructive stop is the one you get for free", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    expect((await postStop(server, sessionId, {})).status).toBe(200);
  });
});

describe("CcctlServer.stopSession (programmatic)", () => {
  it("drives the SAME core as the HTTP ingress — the two cannot drift on what is stoppable", async () => {
    // #77 adds a `ccctl stop` CLI verb alongside the web-ui's button. A rule enforced at the HTTP
    // handler is a rule the CLI walks around — the same argument `launchSession` makes at the other end
    // of a session's life ("a cap a caller can walk around by picking the other entry point bounds
    // nothing").
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);

    const { outcome, session } = await server.stopSession(sessionId);

    expect(outcome).toBe("stopped");
    expect(session.status).toBe("closed");
    expect(closeCount()).toBe(1);
    expect(server.sessions.has(sessionId)).toBe(false);
  });

  it("defaults to NOT forcing — a caller who did not ask to force does not force", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("taken-over");

    await expect(server.stopSession(sessionId)).rejects.toMatchObject({ code: "taken-over" });
    expect(closeCount()).toBe(0);
  });

  it("rejects with the typed code a programmatic caller branches on", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await expect(server.stopSession("no-such-session")).rejects.toMatchObject({
      name: "SessionStopError",
      code: "unknown-session",
    });
  });

  it("forces when asked — the same `taken-over` flipped cell, through the programmatic door", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });
    const sessionId = await launch(server);
    setLiveness("taken-over");

    const { outcome } = await server.stopSession(sessionId, { force: true });

    expect(outcome).toBe("stopped");
    expect(closeCount()).toBe(1);
  });
});

describe("StopFailureCode", () => {
  it("narrows the pinned set and fails closed on anything else", () => {
    for (const code of STOP_FAILURE_CODES) {
      expect(isStopFailureCode(code)).toBe(true);
    }
    for (const value of ["taken_over", "TAKEN-OVER", "", 409, null, undefined, {}]) {
      expect(isStopFailureCode(value)).toBe(false);
    }
  });
});
