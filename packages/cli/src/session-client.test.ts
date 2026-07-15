// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionLaunchError,
  startServer,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "@ccctl/server";
import { defaultSessionClient } from "./session-client.js";

/** A REAL directory: the daemon's launch pre-flight (#33) refuses a cwd that does not exist. */
const LAUNCH_CWD = process.cwd();

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
});
