// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import {
  startServer,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
} from "@ccctl/server";
import { defaultSessionClient } from "./session-client.js";

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
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
}

const started: CcctlServer[] = [];

/** Start a real loopback server on an ephemeral port, tracked for teardown. */
async function startTestServer(launcher: ISessionLauncher | undefined): Promise<CcctlServer> {
  const server = await startServer(launcher === undefined ? { port: 0 } : { port: 0, launcher });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

describe("defaultSessionClient.launch — real POST /api/sessions wire (UC2)", () => {
  it("round-trips a launch against the real handler, returning the surface's attach info", async () => {
    const server = await startTestServer(fakeLauncher("tmux attach -t ccctl:2"));
    const accepted = await defaultSessionClient.launch(server.address, {
      cwd: "/work/repo",
      permissionMode: "default",
    });
    // The 201 `{ attachable, hint }` body the real handler wrote, decoded by the client.
    expect(accepted).toEqual({ attachable: true, hint: "tmux attach -t ccctl:2" });
  });

  it("carries the optional project + initialPrompt through a body the real parser accepts", async () => {
    const server = await startTestServer(fakeLauncher());
    // A malformed body would be a real-handler 400 → the client's `else` branch throws; a clean
    // resolve proves the CLI's launch body is exactly what `parseLaunchOptions` accepts.
    const accepted = await defaultSessionClient.launch(server.address, {
      cwd: "/work/repo",
      permissionMode: "acceptEdits",
      project: "oracle",
      initialPrompt: "ship it",
    });
    expect(accepted.attachable).toBe(true);
  });

  it("maps a launcher-less daemon's real 501 to a clear 'no launcher configured' error", async () => {
    const server = await startTestServer(undefined);
    await expect(
      defaultSessionClient.launch(server.address, { cwd: "/work/repo", permissionMode: "default" }),
    ).rejects.toThrow(/no session launcher configured/);
  });
});

describe("defaultSessionClient.list — real GET /api/sessions wire (UC1 on-ramp)", () => {
  it("round-trips the list against the real handler (empty on a fresh daemon — no worker has registered)", async () => {
    const server = await startTestServer(fakeLauncher());
    // A launch confirms a terminal came up but registers NO session (that is the launched worker's
    // job, a later wave), so the fresh daemon's list is empty — proving the `{ sessions: [...] }`
    // envelope round-trips even at zero entries.
    const sessions = await defaultSessionClient.list(server.address);
    expect(sessions).toEqual([]);
  });
});
