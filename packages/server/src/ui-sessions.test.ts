// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import {
  NON_PROMPTING_PERMISSION_MODES,
  SESSIONS_PATH,
  workerChannelPath,
  workerEventsPath,
  workerRegisterPath,
  type SessionActivity,
} from "@ccctl/core";
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

/** Create a §2 session under `permissionMode` (default: `default`) and return its id. */
async function createSession(server: CcctlServer, permissionMode = "default"): Promise<string> {
  const res = await fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCOUNT_BEARER}` },
    body: JSON.stringify({
      session_context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: permissionMode,
    }),
  });
  return ((await res.json()) as { session_id: string }).session_id;
}

interface SessionSummary {
  readonly id: string;
  readonly status: string;
  readonly activity: SessionActivity;
  readonly notificationsDegraded: boolean;
  readonly cursor: number;
  /** The #264 `AskUserQuestion` decoration — present only while the session is actually blocking. */
  readonly enrichment?: { readonly sequenceNum: number; readonly questions: readonly unknown[] };
}

/** Register `sessionId`'s §4 worker and return its epoch, so its §5 upstream `worker/events` is drivable. */
async function registerWorker(server: CcctlServer, sessionId: string): Promise<number> {
  const res = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { worker_epoch: number }).worker_epoch;
}

/** Drive the §5 upstream leg: POST `count` raw worker events for `sessionId`, advancing its message cursor. */
async function emitEvents(server: CcctlServer, sessionId: string, epoch: number, count: number): Promise<void> {
  const events = Array.from({ length: count }, (_, i) => ({ payload: { seq: i } }));
  const res = await fetch(`${base(server)}${workerEventsPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_epoch: epoch, events }),
  });
  expect(res.status).toBe(200);
}

/** Drive the §5 upstream leg with EXPLICIT payloads (a status frame, an `input_request`, …). */
async function emitPayloads(server: CcctlServer, sessionId: string, epoch: number, payloads: unknown[]): Promise<void> {
  const res = await fetch(`${base(server)}${workerEventsPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_epoch: epoch, events: payloads.map((payload) => ({ payload })) }),
  });
  expect(res.status).toBe(200);
}

/** A §5 `input_request` payload (#261) carrying one well-formed question at `sequenceNum`. */
function inputRequest(sequenceNum: number): unknown {
  return {
    type: "control_event",
    subtype: "input_request",
    payload: {
      sequence_num: sequenceNum,
      questions: [{ question: "Approve?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }],
    },
  };
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

  it("matches a per-session events / command / stop leg and extracts the session id", () => {
    expect(matchUiSessionRoute("/api/sessions/sess-42/events")).toEqual({ kind: "events", sessionId: "sess-42" });
    expect(matchUiSessionRoute("/api/sessions/sess-42/command")).toEqual({ kind: "command", sessionId: "sess-42" });
    expect(matchUiSessionRoute("/api/sessions/sess-42/stop")).toEqual({ kind: "stop", sessionId: "sess-42" });
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
    // A freshly-created session is `connecting` transport-wise and `idle` activity-wise, and
    // — created under `default` (a prompting mode) — carries no notifications-degraded marker.
    // It has emitted nothing on its stream yet, so its message cursor (#80) is 0.
    for (const summary of sessions) {
      expect(summary.status).toBe("connecting");
      expect(summary.activity).toEqual({ kind: "idle" });
      expect(summary.notificationsDegraded).toBe(false);
      expect(summary.cursor).toBe(0);
    }
  });

  it("carries each session's monotonic message cursor — 0 fresh, advancing as its worker emits events (#80)", async () => {
    const server = await startTestServer();
    const busy = await createSession(server);
    const quiet = await createSession(server);

    // Both start at 0 (nothing emitted).
    let sessions = await listSessions(server);
    expect(sessions.find((s) => s.id === busy)?.cursor).toBe(0);
    expect(sessions.find((s) => s.id === quiet)?.cursor).toBe(0);

    // Drive three worker events into `busy`; `quiet` is untouched.
    const epoch = await registerWorker(server, busy);
    await emitEvents(server, busy, epoch, 3);

    sessions = await listSessions(server);
    // `busy`'s cursor advanced to the last emitted event id; `quiet`'s never moved (#20 isolation).
    expect(sessions.find((s) => s.id === busy)?.cursor).toBe(3);
    expect(sessions.find((s) => s.id === quiet)?.cursor).toBe(0);
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

  it("attaches (lists) a non-prompting session and carries the persistent degraded-notification marker (#26)", async () => {
    const server = await startTestServer();
    // A non-prompting session auto-resolves some class of permission decision rather than
    // prompting on it — so it carries the marker, and it attaches anyway (it is not refused).
    // The marker is ADVISORY: it does not mean the session cannot emit `requires_action` (#265).
    // Iterates the whole set so `auto` and `dontAsk` (added #271) are covered on the attach on-ramp.
    for (const mode of NON_PROMPTING_PERMISSION_MODES) {
      const id = await createSession(server, mode);
      const summary = (await listSessions(server)).find((s) => s.id === id);
      expect(summary).toBeDefined(); // the attach on-ramp lists it — not refused
      expect(summary?.notificationsDegraded).toBe(true);
    }
  });

  it("attaches a prompting session with NO degraded marker (#26)", async () => {
    const server = await startTestServer();
    for (const mode of ["default", "plan"] as const) {
      const id = await createSession(server, mode);
      const summary = (await listSessions(server)).find((s) => s.id === id);
      expect(summary?.notificationsDegraded).toBe(false);
    }
  });

  it("keeps the degraded marker persistent as the session runs on — a status update never clears it (#26)", async () => {
    const server = await startTestServer();
    const id = await createSession(server, "bypassPermissions");
    // Drive the worker forward (register + a `running` status) to simulate a long-lived run;
    // the marker is set once at attach and no mid-run path clears it.
    await fetch(`${base(server)}${workerRegisterPath(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const putStatus = await fetch(`${base(server)}${workerChannelPath(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_status: "running", worker_epoch: 1 }),
    });
    expect(putStatus.status).toBe(200);

    const summary = (await listSessions(server)).find((s) => s.id === id);
    expect(summary?.notificationsDegraded).toBe(true);
    expect(summary?.activity).toEqual({ kind: "running" });
  });

  it("serves a blocked session's AskUserQuestion enrichment — and omits it for one that is not blocking (#264)", async () => {
    const server = await startTestServer();
    const blocked = await createSession(server);
    const decorated = await createSession(server);
    const blockedEpoch = await registerWorker(server, blocked);
    const decoratedEpoch = await registerWorker(server, decorated);

    // `blocked` enters requires_action AND is decorated — the read serves the decoration for #87 to render
    // and #86 to validate an answer against.
    await emitPayloads(server, blocked, blockedEpoch, [
      { type: "control_event", subtype: "worker_status", payload: { status: "requires_action", sequence_num: 2 } },
      inputRequest(2),
    ]);
    // `decorated` got the SAME enrichment frame but never entered requires_action — there is no live block
    // to decorate, so the read must not surface it. A decoration is never evidence of needs-you; that is
    // `activity`, and only a `worker_status` moves it (#40).
    await emitPayloads(server, decorated, decoratedEpoch, [inputRequest(9)]);

    const sessions = await listSessions(server);
    const blockedSummary = sessions.find((s) => s.id === blocked);
    const decoratedSummary = sessions.find((s) => s.id === decorated);

    expect(blockedSummary?.activity.kind).toBe("requires_action");
    expect(blockedSummary?.enrichment?.sequenceNum).toBe(2);
    expect(decoratedSummary?.activity).toEqual({ kind: "idle" });
    expect(decoratedSummary?.enrichment).toBeUndefined();
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
