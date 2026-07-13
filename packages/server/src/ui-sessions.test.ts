// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { SESSIONS_PATH, workerChannelPath, workerRegisterPath, type SessionActivity } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";
import { matchUiSessionRoute } from "./ui-sessions.js";

const ACCOUNT_BEARER = "oauth-account-secret-list-abc123";

const started: CcctlServer[] = [];

async function startTestServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

function base(server: CcctlServer): string {
  const { host, port } = server.address;
  return `http://${host}:${port}`;
}

/** Create a §2 session and return its id. */
async function createSession(server: CcctlServer): Promise<string> {
  const res = await fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCOUNT_BEARER}` },
    body: JSON.stringify({
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    }),
  });
  return ((await res.json()) as { session_id: string }).session_id;
}

interface SessionSummary {
  readonly id: string;
  readonly status: string;
  readonly activity: SessionActivity;
}

async function listSessions(server: CcctlServer): Promise<SessionSummary[]> {
  const res = await fetch(`${base(server)}/api/sessions`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

describe("matchUiSessionRoute — the /api/sessions namespace seam (#20)", () => {
  it("matches the collection path as a list", () => {
    expect(matchUiSessionRoute("/api/sessions")).toEqual({ kind: "list" });
    expect(matchUiSessionRoute("/api/sessions/")).toEqual({ kind: "list" });
  });

  it("matches a per-session events / command leg and extracts the session id", () => {
    expect(matchUiSessionRoute("/api/sessions/sess-42/events")).toEqual({ kind: "events", sessionId: "sess-42" });
    expect(matchUiSessionRoute("/api/sessions/sess-42/command")).toEqual({ kind: "command", sessionId: "sess-42" });
  });

  it("fails to match a foreign path, an unknown leg, or a bare session id", () => {
    expect(matchUiSessionRoute("/api/other")).toBeNull();
    expect(matchUiSessionRoute("/v1/sessions")).toBeNull(); // the §2 create collection, a different namespace.
    expect(matchUiSessionRoute("/api/sessionsX")).toBeNull();
    expect(matchUiSessionRoute("/api/sessions/sess-42")).toBeNull(); // no leg — nothing to serve.
    expect(matchUiSessionRoute("/api/sessions/sess-42/status")).toBeNull(); // unknown leg.
    expect(matchUiSessionRoute("/api/sessions/sess-42/events/extra")).toBeNull(); // over-long.
  });
});

describe("GET /api/sessions — session list (#20)", () => {
  it("lists no sessions on a fresh server", async () => {
    const server = await startTestServer();
    expect(await listSessions(server)).toEqual([]);
  });

  it("lists every created session with its id, status, and activity, in creation order", async () => {
    const server = await startTestServer();
    const first = await createSession(server);
    const second = await createSession(server);

    const sessions = await listSessions(server);
    expect(sessions.map((s) => s.id)).toEqual([first, second]);
    // A freshly-created session is `connecting` transport-wise and `idle` activity-wise.
    for (const summary of sessions) {
      expect(summary.status).toBe("connecting");
      expect(summary.activity).toEqual({ kind: "idle" });
    }
  });

  it("surfaces each session's OWN activity — a status update on one never moves the other (#20)", async () => {
    const server = await startTestServer();
    const busy = await createSession(server);
    const quiet = await createSession(server);

    // Register `busy`'s worker and drive it to `running`; `quiet` is untouched.
    await fetch(`${base(server)}${workerRegisterPath(busy)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const putStatus = await fetch(`${base(server)}${workerChannelPath(busy)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_status: "running", worker_epoch: 1 }),
    });
    expect(putStatus.status).toBe(200);

    const sessions = await listSessions(server);
    const busySummary = sessions.find((s) => s.id === busy);
    const quietSummary = sessions.find((s) => s.id === quiet);
    expect(busySummary?.activity).toEqual({ kind: "running" });
    // The untouched session keeps its own idle activity — status is never confused across sessions.
    expect(quietSummary?.activity).toEqual({ kind: "idle" });
  });

  it("rejects an unsupported method on /api/sessions (405)", async () => {
    // GET lists and POST launches (#31); a method the collection serves neither with falls
    // through to the list handler's fail-closed 405. (POST-specific launch routing is covered
    // in ui-session-launch.test.ts.)
    const server = await startTestServer();
    const res = await fetch(`${base(server)}/api/sessions`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
