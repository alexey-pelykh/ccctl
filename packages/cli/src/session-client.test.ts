// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HostEndpoint } from "@ccctl/core";
import {
  SessionLaunchError,
  startServer,
  XDG_STATE_HOME_ENV,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "@ccctl/server";
import { defaultSessionClient } from "./session-client.js";

/** A REAL directory: the daemon's launch pre-flight (#33) refuses a cwd that does not exist. */
const LAUNCH_CWD = process.cwd();

/**
 * The daemon target for the mis-shaped-body tests, which stub `fetch` before the client ever calls
 * it — so this address is only ever rendered into a URL the stub discards. Deliberately a literal
 * and NOT a real {@link startTestServer} address: no wire is involved in those tests, and starting a
 * server would imply one to the next reader while proving nothing. Port 1 so that a stub which ever
 * stopped interposing fails loudly (connection refused) rather than quietly reaching something.
 */
const UNREACHED_TARGET: HostEndpoint = { host: "127.0.0.1", port: 1 };

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

// The launch/attach verbs' UNIT tests exercise the command tree against a FAKE session client
// (index.test.ts). These tests close the other half: the REAL `defaultSessionClient` (real
// `fetch`) driven against a REAL `startServer`, so the HTTP wire the CLI re-implements is proven
// to AGREE with the daemon's handlers — a status-code or JSON-envelope drift breaks here, which a
// faked client cannot catch. The launcher is a recording FAKE (no tmux / pty spawned); binding an
// ephemeral loopback port keeps the round-trip real but self-contained.

/** A recording fake launcher: resolves with a tagged attachable handle (the tmux backend's shape). */
function fakeLauncher(hint = "tmux attach -t ccctl:1", attachable = true): ISessionLauncher {
  return {
    launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
      return Promise.resolve({
        attachment: { attachable, hint },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
}

const started: CcctlServer[] = [];

/**
 * Start a real loopback server on an ephemeral port, tracked for teardown. `maxSessions` (#36) lowers
 * the launch cap so the at-capacity wire can be reached in two launches rather than nine.
 */
async function startTestServer(launcher: ISessionLauncher | undefined, maxSessions?: number): Promise<CcctlServer> {
  const server = await startServer({
    port: 0,
    ...(launcher === undefined ? {} : { launcher }),
    ...(maxSessions === undefined ? {} : { maxSessions }),
  });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

describe("defaultSessionClient.launch — real POST /api/sessions wire (UC2)", () => {
  it("round-trips a launch against the real handler, returning the session id and the surface's attach info", async () => {
    const server = await startTestServer(fakeLauncher("tmux attach -t ccctl:2"));
    const accepted = await defaultSessionClient.launch(server.address, {
      cwd: LAUNCH_CWD,
      permissionMode: "default",
    });
    // The 201 `{ sessionId, attachable, hint }` body the real handler wrote, decoded by the client.
    // The id (#33) addresses the `registering` row the launch just created — so `ccctl launch` can
    // name the session it started rather than leave the operator to guess which row is theirs.
    expect(accepted.sessionId).toEqual(expect.any(String));
    expect(accepted).toMatchObject({ attachable: true, hint: "tmux attach -t ccctl:2" });
  });

  it("carries the optional project + initialPrompt through a body the real parser accepts", async () => {
    const server = await startTestServer(fakeLauncher());
    // A malformed body would be a real-handler 400 → the client's `else` branch throws; a clean
    // resolve proves the CLI's launch body is exactly what `parseLaunchOptions` accepts. Uses a
    // prompting mode (`default`) so the launch-half guard (#32) accepts it — a non-prompting mode
    // is refused with its own 400 (locked in the server's ui-session-launch tests); this test is
    // about the optional-field body shape, not the permission mode.
    const accepted = await defaultSessionClient.launch(server.address, {
      cwd: LAUNCH_CWD,
      permissionMode: "default",
      project: "oracle",
      initialPrompt: "ship it",
    });
    expect(accepted.attachable).toBe(true);
  });

  // #33: the daemon types every launch failure, and the CLI branches on that CODE rather than the
  // HTTP status — so it can name the operator's next move. These are real-wire locks: the code is
  // the one the real handler actually wrote, not one a fake client made up.
  it("maps a launcher-less daemon's real 501 `launcher-absent` to a clear, actionable error", async () => {
    const server = await startTestServer(undefined);

    await expect(
      defaultSessionClient.launch(server.address, { cwd: LAUNCH_CWD, permissionMode: "default" }),
    ).rejects.toThrow(/no session launcher is configured.*Is this the right server\?/s);
  });

  it("maps a real 429 `at-capacity` to an error naming the cap AND how to see what holds it (#36)", async () => {
    // A cap of 1, so the SECOND launch is the refused one. A real-wire lock like its siblings: 429 is
    // a status the CLI has never seen before #36, and the client branches on the typed `code` rather
    // than the status — this proves that holds for a status nothing else in the launch path answers.
    const server = await startTestServer(fakeLauncher(), 1);
    await defaultSessionClient.launch(server.address, { cwd: LAUNCH_CWD, permissionMode: "default" });

    const error = await defaultSessionClient
      .launch(server.address, { cwd: LAUNCH_CWD, permissionMode: "default" })
      .catch((e: unknown) => e as Error);

    // The daemon's own sentence (which names the numbers) plus the CLI's next-move hint — the CLI
    // knows something the daemon does not: the command that lists who is holding the slots.
    expect(error.message).toMatch(/at capacity.*cap is 1.*ccctl attach/s);
  });

  it("maps a real 400 `invalid-cwd` to an error naming the directory AND the flag that fixes it", async () => {
    const server = await startTestServer(fakeLauncher());
    const missing = join(tmpdir(), "ccctl-cli-does-not-exist-8b41");

    const error = await defaultSessionClient
      .launch(server.address, { cwd: missing, permissionMode: "default" })
      .catch((e: unknown) => e as Error);

    // The daemon's own sentence (which names the bad path) plus the CLI's next-move hint.
    expect(error.message).toContain(missing);
    expect(error.message).toContain("--cwd");
  });

  it("maps a real 502 `backend-unavailable` to an error telling the operator how to get a terminal", async () => {
    const unavailable: ISessionLauncher = {
      launch: () =>
        Promise.reject(new SessionLaunchError("backend-unavailable", "ccctl: no backend could bring up a terminal")),
    };
    const server = await startTestServer(unavailable);

    const error = await defaultSessionClient
      .launch(server.address, { cwd: LAUNCH_CWD, permissionMode: "default" })
      .catch((e: unknown) => e as Error);

    expect(error.message).toContain("Install tmux");
  });

  // Not reachable against ccctl's own ingress, whose handler always writes all three; reachable
  // across a tunnel or proxy that interposes a body of its own — which is what the stubbed `fetch`
  // stands in for. `sessionId` is the half of the answer #33 added on purpose — the daemon mints the
  // id AT launch so the operator can name the session they started rather than guess which of N rows
  // is theirs — so a 201 without it must throw rather than resolve into
  // `ccctl: launched session undefined on …`, the one thing the id exists to prevent.
  //
  // Each field is dropped INDEPENDENTLY, as the stop half below (#77) derives at length: a body
  // missing all three passes while any ONE of the checks is live, so it proves only that *some*
  // validation exists. That caught more here than there — ALL THREE arms were unpinned when this was
  // written (#198 found `sessionId`; `attachable` and `hint` turned out to survive deletion too). The
  // round-trip test above asserts their VALUES, which reads as coverage but is not: a well-formed
  // body never reaches the arm that rejects a mis-shaped one.
  it.each([
    ["sessionId", { attachable: true, hint: "tmux attach -t ccctl:1" }],
    ["attachable", { sessionId: "s-1", hint: "tmux attach -t ccctl:1" }],
    ["hint", { sessionId: "s-1", attachable: true }],
  ])("refuses a 201 whose body is missing `%s` — an unreadable answer is not a launch", async (_field, body) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 201 }))) as typeof fetch;

    try {
      await expect(
        defaultSessionClient.launch(UNREACHED_TARGET, { cwd: LAUNCH_CWD, permissionMode: "default" }),
      ).rejects.toThrow(/did not return a \{ sessionId, attachable, hint \} body/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("defaultSessionClient.list — real GET /api/sessions wire (UC1 on-ramp)", () => {
  it("round-trips the list against the real handler (empty on a fresh daemon — nothing launched or attached)", async () => {
    const server = await startTestServer(fakeLauncher());
    // NOTHING has been launched or attached on this daemon, so its list is empty — proving the
    // `{ sessions: [...] }` envelope round-trips even at zero entries. (A LAUNCH would now put a
    // `registering` session here immediately (#33); this test is deliberately about the empty case.)
    const sessions = await defaultSessionClient.list(server.address);
    expect(sessions).toEqual([]);
  });
});

describe("defaultSessionClient.steer — real POST /api/sessions/{id}/command wire (UC1 completion)", () => {
  // A successful (202) steer needs a session with a LIVE worker channel, which only the fenced
  // live-worker oracle stands up (never an in-repo fake) — so the reachable real-wire locks here are
  // the fail-closed statuses. The unit tests (index.test.ts, fake client) cover the 202 behavior.

  it("maps the real handler's 404 for an unknown session to a clear error", async () => {
    const server = await startTestServer(fakeLauncher());
    // No worker has registered, so any id is unknown → the command handler's 404. The real client
    // maps it to an actionable "no session …" message (which cli.ts turns into a non-zero exit).
    await expect(
      defaultSessionClient.steer(server.address, "nope", { subtype: "prompt", payload: { text: "hi" } }),
    ).rejects.toThrow(/no session nope/);
  });

  it("hits the daemon's command ROUTE, not a route-miss (a matched route rejects a malformed body 400)", async () => {
    const server = await startTestServer(fakeLauncher());
    // Prove the URL the client POSTs to actually resolves to the command handler: a MATCHED route
    // with a malformed body is a 400 ("malformed command"), whereas a wrong URL would fall through
    // to the router's "no route" 404. This is what makes the 404 test above a genuine no-session
    // lock rather than a silently-passing route-miss (both a route-miss and a no-session are 404s,
    // indistinguishable from the client, which sees only the status).
    const res = await fetch(`http://${server.address.host}:${server.address.port}/api/sessions/nope/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("malformed command");
  });

  // The 202's body is the one answer this client cannot get from the real handler here (no live
  // worker channel, per the note above), so — as for launch and stop — the mis-shaped case is driven
  // through an interposed response. `id` is the steer's WHOLE answer: it is the correlation handle
  // the operator matches the worker's reply against on the stream, so a 202 without one must throw
  // rather than confirm `ccctl: the daemon accepted it (correlation undefined).` — an acceptance
  // nothing can be matched against. One field, so #198's independent-drop point is moot here; the
  // guard was unpinned all the same, and for the very reason the 202 has to be interposed at all —
  // nothing in this suite reaches it.
  it("refuses a 202 whose body is missing `id` — an unreadable answer is not a queued command", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({}), { status: 202 }))) as typeof fetch;

    try {
      await expect(
        defaultSessionClient.steer(UNREACHED_TARGET, "s-1", { subtype: "prompt", payload: { text: "hi" } }),
      ).rejects.toThrow(/did not return an \{ id \} body/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// #77/#76: the daemon types every stop refusal, and — as with launch — the CLI branches on that
// CODE rather than the HTTP status. Here that is not a stylistic echo but a necessity: FOUR distinct
// refusals share `409`, so the status alone cannot tell "someone is driving it" (fixed by `--force`)
// from "the backend could not be read" (fixed by nothing this shell can do). Real-wire locks: every
// code below is the one the real handler actually wrote.
//
// The AC-level flow (both surfaces, the verb, the terminal state) is pinned in `@ccctl/e2e`'s
// `web-ui-stop-flow.test.ts`. These tests are narrower on purpose — they pin the decisions this
// CLIENT owns: which refusals earn an added hint, and what it does with an answer it cannot read.

/**
 * A fake launcher whose surface can actually BE stopped: its liveness flips to `exited` once
 * `close()` has run, PER SURFACE.
 *
 * The distinction from {@link fakeLauncher} above is not incidental, and it is worth stating because
 * the difference is invisible until a stop runs: that one reports `alive-server-owned` forever, so a
 * stop against it tears the surface down and then — on the rule's post-close RE-READ — still sees a
 * live terminal and refuses to report the kill (`stop-failed`). That is #76 working exactly as
 * designed ("a stop VERIFIES; a teardown trusts": `close()` resolving is the backend's claim, not a
 * proof, so `stopLaunchedSession` refuses to report a kill it can disprove) — a launcher whose
 * surface never dies is simply not a surface anything can stop. It is fine for the launch tests,
 * which never close anything.
 *
 * `liveness` selects the reading BEFORE the close, so one helper drives both the happy path
 * (`alive-server-owned`) and the `taken-over` refusal that `--force` overrides.
 */
function stoppableLauncher(
  liveness: SurfaceLiveness = "alive-server-owned",
  hint = "tmux attach -t ccctl:1",
): ISessionLauncher {
  return {
    launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
      // Per-surface: closing one session's terminal must not make a sibling's read as `exited`.
      let closed = false;
      return Promise.resolve({
        attachment: { attachable: true, hint },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve(closed ? "exited" : liveness),
        close: (): Promise<void> => {
          closed = true;
          return Promise.resolve();
        },
      });
    },
  };
}

/** Launch one session against `server` through the real handler and return its minted id. */
async function launchSessionId(server: CcctlServer): Promise<string> {
  const accepted = await defaultSessionClient.launch(server.address, { cwd: LAUNCH_CWD, permissionMode: "default" });
  return accepted.sessionId;
}

describe("defaultSessionClient.stop — real POST /api/sessions/{id}/stop wire (#77)", () => {
  it("round-trips a stop against the real handler, returning what it did and the terminal state", async () => {
    const server = await startTestServer(stoppableLauncher());
    const sessionId = await launchSessionId(server);

    const stopped = await defaultSessionClient.stop(server.address, sessionId, { force: false });

    // The 200 `{ sessionId, outcome, status }` body the real handler wrote, decoded by the client.
    expect(stopped).toEqual({ sessionId, outcome: "stopped", status: "closed" });
  });

  it("maps a real 404 `unknown-session` to an error naming the verb that lists what IS there", async () => {
    const server = await startTestServer(stoppableLauncher());

    const error = await defaultSessionClient
      .stop(server.address, "no-such-session", { force: false })
      .catch((e: unknown) => e as Error);

    // The daemon's own sentence plus the CLI's next-move hint.
    expect(error.message).toMatch(/no session no-such-session.*ccctl attach/s);
  });

  it("maps a real 409 `taken-over` to an error naming the SHELL's remedy, not the wire's", async () => {
    const server = await startTestServer(stoppableLauncher("taken-over", "tmux attach -t ccctl:9"));
    const sessionId = await launchSessionId(server);

    const error = await defaultSessionClient
      .stop(server.address, sessionId, { force: false })
      .catch((e: unknown) => e as Error);

    // The daemon's sentence echoes the surface's own attach hint — which only it knows…
    expect(error.message).toContain("tmux attach -t ccctl:9");
    // …and names its remedy in WIRE words (`{ force: true }`), which nobody can type at a shell.
    // `--force` is the CLI translating that remedy for the surface the operator is actually on.
    expect(error.message).toContain("--force");
  });

  it("sends `force` as a literal boolean the real fail-closed parse accepts — and it overrides", async () => {
    const server = await startTestServer(stoppableLauncher("taken-over"));
    const sessionId = await launchSessionId(server);

    // `parseStopOptions` refuses anything that is not exactly a boolean, so a stringified or coerced
    // `force` would be a real-handler 400 here rather than the override the operator asked for.
    await expect(defaultSessionClient.stop(server.address, sessionId, { force: false })).rejects.toThrow(/taken over/);
    await expect(defaultSessionClient.stop(server.address, sessionId, { force: true })).resolves.toMatchObject({
      outcome: "stopped",
    });
  });

  // Not reachable against ccctl's own ingress; reachable across a tunnel or proxy that interposes a
  // body of its own. The shape IS how the client knows what happened to the session, so an
  // unreadable answer must throw rather than resolve — reporting a kill nobody verified is the one
  // answer an emergency-stop must never give.
  //
  // Each field is dropped INDEPENDENTLY, which is the whole point: a single body missing all three
  // passes while any ONE of the three checks is live, so it proves only that *some* validation
  // exists — not that the field a future edit deletes is still checked. (Written that way first;
  // deleting the `outcome` check left it green.)
  it.each([
    ["sessionId", { outcome: "stopped", status: "closed" }],
    ["outcome", { sessionId: "s-1", status: "closed" }],
    ["status", { sessionId: "s-1", outcome: "stopped" }],
  ])(
    "refuses to report a 200 whose body is missing `%s` — an unreadable answer is not a kill",
    async (_field, body) => {
      const server = await startTestServer(stoppableLauncher());
      const sessionId = await launchSessionId(server);
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;

      try {
        await expect(defaultSessionClient.stop(server.address, sessionId, { force: false })).rejects.toThrow(
          /did not return a \{ sessionId, outcome, status \} body/,
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );
});
