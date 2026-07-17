// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, XDG_STATE_HOME_ENV, type CcctlServer, type SurfaceLiveness } from "@ccctl/server";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "@ccctl/server/src/session-launcher.js";
import { buildProgram } from "@ccctl/cli";
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import {
  describeStopAccepted,
  isForceable,
  sessionStopPath,
  stopFailure,
  stopRequest,
} from "@ccctl/web-ui/src/stop.js";
// The REAL phone decode (#15/#196), so a watcher's view of the terminal frame is asserted through the
// actual UI classifier rather than a re-implemented stand-in of it.
import { processEventData } from "@ccctl/web-ui/src/transcript.js";
import { connectUiClient, waitFor } from "./one-session-harness.js";

// The emergency-stop flow (#77, `UI-B-012` / `CLI-B-004`) driven END TO END against the REAL wired
// ingress (`POST /api/sessions/{id}/stop`, #76) and its REAL typed-refusal branches. The launcher is
// a FAKE — no tmux / pty is spawned — so this needs no live worker and runs on every `test`, exactly
// as `web-ui-launch-flow.test.ts` drives the launch gate without one.
//
// This spec is the yardstick for #77 AC3 ("both paths call the same server-side emergency-stop and
// reflect the resulting terminal state"), and it is the only place that criterion can honestly be
// tested. AC3 is a claim about TWO clients agreeing with ONE server, so no unit test in either
// client package can reach it: each would assert its own copy of the contract against a fixture it
// also owns, and both stay green the day the server changes. Here both REAL readers — the browser's
// `stop.js` and the CLI's `session-client.ts` — are pointed at the same live ingress in the same
// test, so "the same emergency-stop" is a demonstrated fact rather than a claim about two mirrors.
//
// It carries the same load for `stop.js` that `web-ui-launch-flow.test.ts` carries for `launch.js`:
// the browser module MIRRORS the server's contract rather than importing it (it is served unbundled,
// so it must stay dependency-free), and a mirror is only as good as what pins it.
//
// What nothing here pins is the `StopFailureCode` SET's membership, deliberately, for the reason
// `stop.js` gives: the reader passes an unrecognized code through verbatim, so a new code needs no UI
// change to be DISPLAYED. The CLI is the side that DOES gate membership — it narrows with the server's
// OWN `isStopFailureCode` guard rather than a copy — so a drift there is a typecheck failure, not
// something this spec must catch.
//
// That reasoning is about DISPLAY, and #197 showed where it stops: `liveness-indeterminate` was the
// eighth code, and it DID need a UI change — not to be shown, but because `isForceable` had to learn
// that force resolves it. So the rule is narrower than "a new code needs no UI change": a new code
// needs no UI change unless the UI must ACT on it, and then this spec is the only place that pins the
// acting against a real ingress. Every code the UI treats specially is driven here for exactly that
// reason (`taken-over`, and both `liveness-` codes — which are one word apart and opposite in what
// they permit, the drift a shared-prefix shortcut would silently introduce).
//
// `ambiguous-surface` is the one refusal not driven here: #33's `mayHoldLiveWorker` is set only when
// a REAL worker registers over §2 from one of two launches sharing a (cwd, mode), which a fake
// launcher cannot reach. It is exhaustively covered server-side (`ui-session-stop.test.ts`), and
// both clients meet it through the same shared core these tests already pin.
//
// The CLI side is driven through the REAL command tree (`buildProgram()` on its PRODUCTION seams,
// which wire the real `defaultSessionClient`) rather than by importing that client directly. AC2 is
// about the VERB — "`ccctl stop <session>` stops the named session from the command line" — so the
// argv, the flag parsing, and the operator-facing lines are part of what must be true, not just the
// round-trip underneath them. `parseAsync` is the same seam `cli.ts` runs in production.

/**
 * A recording fake launcher whose handle's liveness is steerable per test — the seam #76's stop rule
 * actually decides on. `liveness` drives the refusal table (`taken-over`), and `close` is what a
 * `tear-down` calls; `closed` flips after it, so the rule's post-close re-read (a stop VERIFIES, it
 * does not trust `close()`) sees a surface that is really gone.
 */
function fakeLauncher({
  liveness = "alive-server-owned" as SurfaceLiveness,
  hint = "tmux attach -t ccctl:1",
}: { liveness?: SurfaceLiveness; hint?: string } = {}) {
  const launches: SessionLaunchOptions[] = [];
  const launcher: ISessionLauncher = {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launches.push(options);
      // PER-SURFACE, not per-launcher: each launch owns its own terminal, so closing one must not
      // make a sibling read as `exited`. (Hoisting this into the closure made stopping session A
      // report session B as `already-exited` — a fake that quietly answered for the wrong surface.)
      let closed = false;
      return {
        attachment: { attachable: true, hint },
        // Once torn down THIS surface reads `exited` whatever the test asked for — the rule re-reads
        // after `close()` and must see the kill it just made.
        liveness: async () => (closed ? "exited" : liveness),
        close: async () => {
          closed = true;
        },
      };
    },
  };
  return { launcher, launches };
}

/**
 * A disposable directory THIS FILE's `AskUserQuestion` hook installs are routed to, via
 * `XDG_STATE_HOME` (#262) — mirrors `ui-session-launch.test.ts`'s own fixture. Every launch driven
 * below runs through the REAL, wired `launchSession`, which installs a REAL hook (synchronous,
 * best-effort, never mocked out); without this override every run of this suite would write
 * settings/handoff files under the developer's own `~/.local/state/ccctl/hooks`.
 */
let hookStateRoot = "";
let previousXdgStateHome: string | undefined;

beforeAll(() => {
  hookStateRoot = mkdtempSync(join(tmpdir(), "ccctl-hook-state-"));
  previousXdgStateHome = process.env[XDG_STATE_HOME_ENV];
  process.env[XDG_STATE_HOME_ENV] = hookStateRoot;
});

afterAll(() => {
  if (previousXdgStateHome === undefined) {
    Reflect.deleteProperty(process.env, XDG_STATE_HOME_ENV);
  } else {
    process.env[XDG_STATE_HOME_ENV] = previousXdgStateHome;
  }
  rmSync(hookStateRoot, { recursive: true, force: true });
});

const started: CcctlServer[] = [];

async function serve(config: Parameters<typeof startServer>[0]): Promise<CcctlServer> {
  const server = await startServer(config);
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

function origin(server: CcctlServer): string {
  return `http://${server.address.host}:${server.address.port}`;
}

/** Launch one session through the REAL ingress and return the id the 201 minted. */
async function launchOne(server: CcctlServer): Promise<string> {
  const res = await fetch(`${origin(server)}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(launchRequest({ cwd: process.cwd() })),
  });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/**
 * POST a stop exactly as the browser does: the REAL `sessionStopPath` it would fetch, carrying
 * whatever the REAL `stopRequest` built.
 *
 * The path comes from the module rather than being spelled here, and that is load-bearing rather
 * than tidy: `sessionStopPath` is `stop.js`'s copy of a route the server owns, and the only other
 * thing checking it is a web-ui unit test asserting that copy against a hand-written copy in the
 * same package — green on both sides the day the route moves. Driving the real path against the real
 * matcher is what makes this spec the yardstick for the WHOLE browser-side stop contract (path +
 * body + reading) rather than two-thirds of it. (Written hardcoded first; re-pointing the module's
 * path at `/command` left this spec green.)
 */
function postStop(server: CcctlServer, sessionId: string, body: unknown): Promise<Response> {
  return fetch(`${origin(server)}${sessionStopPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The picker's own view — `GET /api/sessions`, where a stopped session's terminal state shows. */
async function listSessions(server: CcctlServer): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${origin(server)}/api/sessions`);
  return ((await res.json()) as { sessions: Array<Record<string, unknown>> }).sessions;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything the verb printed this run, joined — the operator's actual view of what happened. */
function printed(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

/**
 * Run `ccctl stop <id>` against `server` exactly as the operator's shell does — the REAL command
 * tree on its PRODUCTION seams (so the real `defaultSessionClient` makes the real round-trip),
 * parsed from the real argv shape.
 */
function runStop(server: CcctlServer, sessionId: string, ...flags: string[]): Promise<unknown> {
  return buildProgram().parseAsync(
    ["stop", sessionId, "--host", server.address.host, "--port", String(server.address.port), ...flags],
    { from: "user" },
  );
}

describe("the web-ui stop control stops a session (#77 AC1)", () => {
  it("is accepted by the REAL ingress — the mirrored body shape is faithful — and reports the terminal state", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    const res = await postStop(server, sessionId, stopRequest());
    const accepted = await res.json();

    expect(res.status).toBe(200);
    // The REAL 200 body, read by the REAL accept-reader the status line shows. `closed` is what the
    // server's terminal transition RETURNED — the reader carries it rather than asserting it.
    expect(describeStopAccepted(accepted)).toBe(`stopped ${sessionId} — closed`);
  });

  it("reports an already-exited surface as the distinct success it is, not as a kill", async () => {
    const { launcher } = fakeLauncher({ liveness: "exited" });
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    const accepted = await (await postStop(server, sessionId, stopRequest())).json();

    // "I killed it" and "it was already dead" are different facts; both satisfy the operator.
    expect((accepted as { outcome: string }).outcome).toBe("already-exited");
    expect(describeStopAccepted(accepted)).toBe(`${sessionId} had already exited — closed`);
  });

  it("really ends the session — the row LEAVES the list, so nothing lingers that could still be steered", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    await postStop(server, sessionId, stopRequest());

    // The operator's own list is the yardstick: a stop that answered 200 while the row stayed live
    // would satisfy "the response says closed" and fail "the session is over".
    //
    // The row LEAVING is the list's reflection of the terminal state — not a `closed` row lingering
    // in it (`session-close.ts` is explicit about why: `maxSessions` (#36) counts `sessions.size`,
    // so a retained terminal row would hold its slot forever and stopping eight sessions would leave
    // the server permanently `at-capacity` with nothing running in it — the emergency-stop's own
    // promise, end one and free a slot, would be the first thing it broke). The terminal STATUS is
    // reflected to the client that asked in the 200 body the tests above read, and to everyone
    // WATCHING in the terminal frame the last describe here drives (#196).
    expect(await listSessions(server)).toEqual([]);
  });

  it("frees the slot it held — the cap (#36) the stop's own promise rests on", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher, maxSessions: 1 });
    const sessionId = await launchOne(server);

    // At the cap: the next launch is refused, which is what makes the stop below load-bearing rather
    // than cosmetic — this is the operator stopping a runaway so they can start the real work.
    const refused = await fetch(`${origin(server)}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(launchRequest({ cwd: process.cwd() })),
    });
    expect(refused.status).toBe(429);

    expect((await postStop(server, sessionId, stopRequest())).status).toBe(200);

    // …and now it launches, with no new plumbing: the slot came back because the row left.
    await expect(launchOne(server)).resolves.toEqual(expect.any(String));
  });

  it("builds a force body the REAL fail-closed parse reads as force — and a bare one it reads as absent", async () => {
    const { launcher } = fakeLauncher({ liveness: "taken-over" });
    const server = await serve({ port: 0, launcher });

    // `parseStopOptions` refuses anything but a literal boolean, so this pins that the escalation's
    // body really IS force rather than merely truthy (`"true"` / 1 would be `malformed-request`),
    // and that the default body genuinely does not force.
    const sessionId = await launchOne(server);
    expect((await postStop(server, sessionId, stopRequest())).status).toBe(409);
    expect((await postStop(server, sessionId, stopRequest({ force: true }))).status).toBe(200);
  });
});

describe("`ccctl stop <session>` stops a session (#77 AC2)", () => {
  it("stops the named session from the command line and reports the terminal state it reached", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    await runStop(server, sessionId);

    // What the operator is told — the id they named, and the state the server's transition produced.
    expect(printed()).toContain(`stopped session ${sessionId}`);
    expect(printed()).toContain("closed");
    // …and it is a REAL stop, not merely an accepted request: the session is gone from the shared list.
    expect(await listSessions(server)).toEqual([]);
  });

  it("reports an already-exited surface honestly rather than claiming a kill it did not make", async () => {
    const { launcher } = fakeLauncher({ liveness: "exited" });
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    await runStop(server, sessionId);

    expect(printed()).toContain("had already exited");
  });

  it("surfaces the REAL typed refusal on a taken-over session — and `--force` overrides exactly it", async () => {
    const { launcher } = fakeLauncher({ liveness: "taken-over", hint: "tmux attach -t ccctl:7" });
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    // A refusal is a REJECTED parse (which `cli.ts` turns into a non-zero exit), never a quiet 0 —
    // `ccctl stop X && echo done` must not print `done`. The sentence is the SERVER's, echoing the
    // attach hint only it knows; the CLI adds the one thing the daemon cannot know — the flag name.
    await expect(runStop(server, sessionId)).rejects.toThrow(/tmux attach -t ccctl:7/);
    await expect(runStop(server, sessionId)).rejects.toThrow(/--force/);

    // A refused stop touches NO state, which is what makes the retry below a real second attempt
    // rather than a second go at a half-torn-down session.
    expect((await listSessions(server))[0]?.status).toBe("registering");

    await runStop(server, sessionId, "--force");
    expect(printed()).toContain(`stopped session ${sessionId}`);
    expect(await listSessions(server)).toEqual([]);
  });

  it("surfaces the REAL `unknown-session` refusal, naming the verb that lists what IS there", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    await expect(runStop(server, "no-such-session")).rejects.toThrow(/ccctl attach/);
  });
});

describe("both paths drive the SAME server-side emergency-stop (#77 AC3)", () => {
  it("agree on the terminal state a stop produces — one ingress, one answer, two readers", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const viaBrowser = await launchOne(server);
    const viaCli = await launchOne(server);

    // The browser's reader against the raw 200…
    const browserAccepted = await (await postStop(server, viaBrowser, stopRequest())).json();
    // …and the REAL `ccctl stop` verb against the same route on the same daemon.
    await runStop(server, viaCli);

    // Same outcome vocabulary, same terminal status — neither client invented or re-derived either.
    expect(browserAccepted).toEqual({ sessionId: viaBrowser, outcome: "stopped", status: "closed" });
    expect(describeStopAccepted(browserAccepted)).toBe(`stopped ${viaBrowser} — closed`);
    expect(printed()).toContain(`stopped session ${viaCli}`);
    expect(printed()).toContain("closed");

    // …and both sessions are equally over in the one list both surfaces read — the same stop, twice.
    expect(await listSessions(server)).toEqual([]);
  });

  it("are refused ALIKE where the rule refuses — a refusal is the core's, not a surface's local policy", async () => {
    const { launcher } = fakeLauncher({ liveness: "taken-over" });
    const server = await serve({ port: 0, launcher });
    const viaBrowser = await launchOne(server);
    const viaCli = await launchOne(server);

    const browserRes = await postStop(server, viaBrowser, stopRequest());
    const browserFailure = stopFailure(browserRes.status, await browserRes.json());

    expect(browserRes.status).toBe(409);
    expect(browserFailure.code).toBe("taken-over");
    // The web-ui offers its force escalation off this code (one of the two it offers it for — see the
    // `liveness-indeterminate` spec below for the other).
    expect(isForceable(browserFailure.code)).toBe(true);

    // The CLI meets the SAME rule at the same reading — not a stricter or looser one of its own.
    await expect(runStop(server, viaCli)).rejects.toThrow(/taken over/);

    // Neither refusal touched its session: both are still exactly as they were, still stoppable.
    expect((await listSessions(server)).map((row) => row.status)).toEqual(["registering", "registering"]);
  });

  it("agree that `liveness-indeterminate` is forceable — the OTHER refusal force resolves (#197)", async () => {
    // #197 split the old `unknown` into an unreachable-host reading and an indeterminate-surface one,
    // and gave the second its own wire code precisely because force RESOLVES it while its near-namesake
    // `liveness-unknown` is beyond force. That distinction lives in the server; both readers must meet
    // it, and neither may re-derive it. This is the spec that pins it against the REAL ingress — which
    // matters more than usual here, because `stop.test.js`'s hand-copied `SERVER_FAILURE_CODES` fixture
    // explicitly defers to THIS file for the codes' real behavior (`stop.js` itself mirrors no copy of
    // the set at all), and because the two `liveness-` codes are one word apart and opposite in what
    // they permit.
    const { launcher } = fakeLauncher({ liveness: "surface-indeterminate" });
    const server = await serve({ port: 0, launcher });
    const viaBrowser = await launchOne(server);
    const viaCli = await launchOne(server);

    const browserRes = await postStop(server, viaBrowser, stopRequest());
    const browserFailure = stopFailure(browserRes.status, await browserRes.json());

    expect(browserRes.status).toBe(409);
    expect(browserFailure.code).toBe("liveness-indeterminate");
    // The whole point of the new code: the UI offers the escalation. Under the old shared
    // `liveness-unknown` this would be `false` and the operator would have no way through.
    expect(isForceable(browserFailure.code)).toBe(true);

    // The CLI meets the same rule and translates the same remedy for ITS surface (`--force`, not
    // `{ force: true }`).
    await expect(runStop(server, viaCli)).rejects.toThrow(/--force/);

    // And the escalation the UI just offered actually works — a forceable refusal that force cannot
    // resolve would be the button-that-cannot-work this UI refuses to render.
    const forced = await postStop(server, viaBrowser, stopRequest({ force: true }));
    expect(await forced.json()).toEqual({ sessionId: viaBrowser, outcome: "stopped", status: "closed" });
  });

  it("keeps `liveness-unknown` NOT forceable — the sibling one word away, and beyond force (#197)", async () => {
    // The other half of the split, and the one a `startsWith("liveness-")` shortcut would break: here
    // the backend could not REACH its host, so a kill would travel the same dead channel and be
    // confirmed by nobody. Both readers must decline to offer the escalation, and the server must
    // refuse it even if one did.
    const { launcher } = fakeLauncher({ liveness: "host-unreachable" });
    const server = await serve({ port: 0, launcher });
    const viaBrowser = await launchOne(server);
    const viaCli = await launchOne(server);

    const browserRes = await postStop(server, viaBrowser, stopRequest({ force: true }));
    const browserFailure = stopFailure(browserRes.status, await browserRes.json());

    expect(browserRes.status).toBe(409);
    expect(browserFailure.code).toBe("liveness-unknown");
    expect(isForceable(browserFailure.code)).toBe(false);

    // The CLI is told the same thing, and — the property that matters — is NOT handed a `--force` hint
    // it could not act on (`session-client.ts` § STOP_FAILURE_HINTS: "a hint that names a remedy which
    // does not work is worse than the silence").
    //
    // Asserted on `--force`'s ABSENCE, and anchored on a clause only THIS refusal has. Both liveness
    // sentences open `…'s terminal could not be read — `, and `stopError` APPENDS its hint to the
    // daemon's sentence — so a `/could not be read/` match would pass whether or not the forbidden hint
    // were there, and would pass against the sibling refusal too. It would gate nothing.
    const unforceable = await runStop(server, viaCli, "--force").catch((error: unknown) => error as Error);
    expect(unforceable.message).toMatch(/could not reach the host/);
    expect(unforceable.message).not.toMatch(/--force/);

    // Refused even WITH force, and untouched — a refusal changes nothing, which is what makes it safe
    // to retry.
    expect((await listSessions(server)).map((row) => row.status)).toEqual(["registering", "registering"]);
  });

  it("degrades the ingress's 405 — the ONE failure answered with no `code` — instead of throwing", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);

    const res = await fetch(`${origin(server)}${sessionStopPath(sessionId)}`, { method: "GET" });
    const failure = stopFailure(res.status, await res.json());

    expect(res.status).toBe(405);
    // No stop was attempted, so there is no stop failure to type: the reader must not invent a code,
    // and must still carry the server's prose.
    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("not allowed");
    // …and nothing is forceable off a code that does not exist.
    expect(isForceable(failure.code)).toBe(false);
  });
});

describe("a WATCHING client learns the terminal state too, not just the initiator (#196)", () => {
  // #76's AC4 — "the stopped session transitions to a terminal state, reflected to clients" — was true
  // for whoever ASKED: they read it in the 200 body the first describe drives. A client merely WATCHING
  // the session's stream got a bare `res.end()`, which is also what a dropped link looks like, so it
  // could only learn by re-polling the session list — and even then learned the row's ABSENCE, never the
  // status. #77's stop button is what makes two clients on one session the normal case rather than the
  // exotic one, so this is the case, not an edge of it.
  //
  // This is the spec that can hold BOTH halves of a deliberately coordinated change honest, and neither
  // package's own tests can. `session-close.test.ts` proves the server broadcasts a frame; `transcript.
  // test.js` proves the browser decodes one — each against a fixture it also writes, so both stay green
  // the day the two shapes drift apart. Here the REAL server's bytes are read by the REAL browser
  // decoder, so "the watcher learns" is demonstrated rather than asserted twice in two places.

  it("delivers the terminal frame to a watcher, decoded by the REAL browser decoder (AC6)", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);
    // A second client, watching — it never asked for a stop, so it has no response to read.
    const watcher = await connectUiClient({ server, sessionId });

    const res = await postStop(server, sessionId, stopRequest());
    expect(res.status).toBe(200);

    await waitFor(() => watcher.viewed().length > 0);
    // Grounded in the WATCHER's OWN received bytes (never the stopper's self-report), read through the
    // same `processEventData` the page runs. `closed` is what the server's transition produced — the
    // same fact the initiator's 200 carried, now told to someone who did not ask.
    expect(processEventData(watcher.viewed()[0].data)).toEqual({
      kind: "closed",
      status: "closed",
      text: "Session ended.",
    });
  });

  it("delivers it as the LAST thing on the stream — told on the way out, not into a closed pipe (AC1)", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const sessionId = await launchOne(server);
    const watcher = await connectUiClient({ server, sessionId });

    await postStop(server, sessionId, stopRequest());
    await waitFor(() => watcher.viewed().length > 0);

    // Exactly one frame, and the stream is over: the relay was reaped right behind it. A farewell
    // broadcast after the reap would leave this at zero forever — the watcher would wait out the
    // timeout above and learn nothing, which is the bug in its original form.
    expect(watcher.viewed()).toHaveLength(1);
    expect(processEventData(watcher.viewed()[0].data).kind).toBe("closed");
    // It carried a real `Last-Event-ID` like every frame before it (#80's cursor never skips).
    expect(watcher.viewed()[0].id).toBe("1");
  });

  it("tells the watcher of the stopped session ONLY — a sibling's watcher is untouched (AC3, #20)", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const doomedId = await launchOne(server);
    const liveId = await launchOne(server);
    const doomedWatcher = await connectUiClient({ server, sessionId: doomedId });
    const bystander = await connectUiClient({ server, sessionId: liveId });

    await postStop(server, doomedId, stopRequest());
    await waitFor(() => doomedWatcher.viewed().length > 0);

    // A terminal frame on the wrong stream is worse than none: the page ACTS on that word by closing its
    // own stream and telling the operator a live session is over.
    expect(bystander.viewed()).toEqual([]);
    // …and the sibling is genuinely still there to be watched, so the silence is correctness, not a
    // second session that also died.
    expect((await listSessions(server)).map((row) => row.id)).toEqual([liveId]);
  });
});
