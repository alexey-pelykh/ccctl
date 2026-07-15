// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type CcctlServer, type SurfaceLiveness } from "@ccctl/server";
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
// `stop.js` gives: the reader passes an unrecognized code through verbatim, so an eighth code needs
// no UI change. The CLI is the side that DOES gate membership — it narrows with the server's OWN
// `isStopFailureCode` guard rather than a copy — so a drift there is a typecheck failure, not
// something this spec must catch.
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
    // reflected to the one client that asked, in the 200 body the tests above read.
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
    // The web-ui offers its force escalation off exactly this code (and only this one).
    expect(isForceable(browserFailure.code)).toBe(true);

    // The CLI meets the SAME rule at the same reading — not a stricter or looser one of its own.
    await expect(runStop(server, viaCli)).rejects.toThrow(/taken over/);

    // Neither refusal touched its session: both are still exactly as they were, still stoppable.
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
