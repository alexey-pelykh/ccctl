// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  DEFAULT_REQUIRES_ACTION_DETAIL,
  SESSIONS_PATH,
  workerChannelPath,
  workerEventsDeliveryPath,
  workerEventsPath,
  workerEventsStreamPath,
  workerHeartbeatPath,
  workerRegisterPath,
} from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";
import { DEFAULT_WORKER_LIVENESS_INTERVAL_MS } from "./worker-channel.js";

const ACCOUNT_BEARER = "oauth-account-secret-worker-abc123";

const started: CcctlServer[] = [];
const streams: IncomingMessage[] = [];

async function startTestServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (streams.length > 0) {
    streams.pop()?.destroy();
  }
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

function base(server: CcctlServer): string {
  const { host, port } = server.address;
  return `http://${host}:${port}`;
}

/** Create a session over the §2 flow and return its id (no ws_url; §2→§3 auto-enqueue is orthogonal here). */
async function registerSession(server: CcctlServer): Promise<string> {
  const res = await fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCOUNT_BEARER}` },
    body: JSON.stringify({
      session_context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    }),
  });
  return ((await res.json()) as { session_id: string }).session_id;
}

/** GET the browser-facing session list — the surface that projects each session's transport `status` (#172). */
async function listSessions(server: CcctlServer): Promise<{ id: string; status: string }[]> {
  const res = await fetch(`${base(server)}/api/sessions`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: { id: string; status: string }[] }).sessions;
}

/** §4 — POST worker/register `{}` and return the minted worker_epoch. */
async function registerWorker(server: CcctlServer, sessionId: string): Promise<number> {
  const res = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { worker_epoch: number }).worker_epoch;
}

/** §4 — PUT the worker status gate. */
function putStatus(server: CcctlServer, sessionId: string, epoch: number, status: string): Promise<Response> {
  return fetch(`${base(server)}${workerChannelPath(sessionId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_status: status, worker_epoch: epoch, external_metadata: {} }),
  });
}

/** §5 — POST a batch of raw payloads up worker/events. */
function postWorkerEvents(
  server: CcctlServer,
  sessionId: string,
  epoch: number,
  payloads: unknown[],
): Promise<Response> {
  return fetch(`${base(server)}${workerEventsPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_epoch: epoch, events: payloads.map((payload) => ({ payload })) }),
  });
}

interface ClientEventFrame {
  readonly event: string | undefined;
  readonly id: string | undefined;
  readonly data: Record<string, unknown>;
}

/** Parse one SSE block off the worker downstream into a `client_event` frame, or null for a comment. */
function parseWorkerSseBlock(block: string): ClientEventFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0
    ? null
    : { event, id, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

interface WorkerStream {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  received(): ClientEventFrame[];
}

/** §4 — open the held-open worker downstream (`GET worker/events/stream`) and collect its frames. */
function openWorkerStream(server: CcctlServer, sessionId: string): Promise<WorkerStream> {
  const { host, port } = server.address;
  return new Promise<WorkerStream>((resolve, reject) => {
    const req = httpRequest(
      { host, port, path: workerEventsStreamPath(sessionId), method: "GET", headers: { Accept: "text/event-stream" } },
      (res: IncomingMessage) => {
        streams.push(res);
        res.setEncoding("utf8");
        res.on("error", () => {}); // swallow a reset when the server ends the stream on shutdown.
        const frames: ClientEventFrame[] = [];
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const parsed = parseWorkerSseBlock(buffer.slice(0, boundary));
            if (parsed !== null) {
              frames.push(parsed);
            }
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        });
        resolve({
          statusCode: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          received: () => frames,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("§4 worker register — POST /v1/code/sessions/{id}/worker/register", () => {
  it("mints a positive worker_epoch and re-register supersedes it (monotonic)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const first = await registerWorker(server, sessionId);
    expect(first).toBeGreaterThan(0);
    const second = await registerWorker(server, sessionId);
    expect(second).toBeGreaterThan(first);
  });

  it("fails closed on an unknown session (404) and a wrong method (405)", async () => {
    const server = await startTestServer();
    const missing = await fetch(`${base(server)}${workerRegisterPath("no-such-session")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
    const sessionId = await registerSession(server);
    const wrongMethod = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("§4 worker events stream — GET …/worker/events/stream (held-open downstream)", () => {
  it("holds open a text/event-stream once the worker has registered", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);
    expect(stream.statusCode).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
  });

  it("fails closed before register (409), on an unknown session (404), and on a wrong method (405)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    // Not registered yet → 409.
    const early = await fetch(`${base(server)}${workerEventsStreamPath(sessionId)}`, { method: "GET" });
    expect(early.status).toBe(409);
    // Unknown session → 404.
    const missing = await fetch(`${base(server)}${workerEventsStreamPath("no-such-session")}`, { method: "GET" });
    expect(missing.status).toBe(404);
    // Wrong method → 405.
    await registerWorker(server, sessionId);
    const wrongMethod = await fetch(`${base(server)}${workerEventsStreamPath(sessionId)}`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("§4 session.status connecting→ready — the worker downstream attach advances the transport lifecycle (#172)", () => {
  it("lists a fresh session as `connecting` and reports `ready` once the worker holds its downstream open", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    // A freshly-created session is born `connecting` — no worker downstream has attached yet.
    const before = await listSessions(server);
    expect(before.find((s) => s.id === sessionId)?.status).toBe("connecting");

    // The worker registers and opens (attaches) its held-open downstream.
    await registerWorker(server, sessionId);
    await openWorkerStream(server, sessionId);

    // Attaching the downstream advanced the transport lifecycle to `ready`; GET /api/sessions
    // reports it verbatim, so `ccctl attach` renders `[ready] …` (AC2/AC3).
    const after = await listSessions(server);
    expect(after.find((s) => s.id === sessionId)?.status).toBe("ready");
  });
});

describe("§4 worker status gate — PUT /v1/code/sessions/{id}/worker", () => {
  it("derives session activity from worker_status and MUST 200", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);

    expect((await putStatus(server, sessionId, epoch, "idle")).status).toBe(200);
    expect(server.sessions.get(sessionId)?.activity.kind).toBe("idle");

    expect((await putStatus(server, sessionId, epoch, "running")).status).toBe(200);
    expect(server.sessions.get(sessionId)?.activity.kind).toBe("running");
  });

  it("derives `requires_action` (with the default detail) from the status gate — the third tri-state (#21)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);

    // The PUT gate carries a BARE status (`external_metadata: {}`), so the derived activity
    // takes the core default detail; the rich human `requires_action` detail rides the
    // transcript stream and is decoded UI-side (web-ui), not folded into the session model.
    expect((await putStatus(server, sessionId, epoch, "requires_action")).status).toBe(200);
    expect(server.sessions.get(sessionId)?.activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
  });

  it("fails closed on a superseded epoch (409), an unknown status (400), and an unknown session (404)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    // Re-register supersedes `epoch`.
    await registerWorker(server, sessionId);
    expect((await putStatus(server, sessionId, epoch, "idle")).status).toBe(409);
    // A fresh epoch works, but an unknown status (drift) fails closed.
    const fresh = await registerWorker(server, sessionId);
    expect((await putStatus(server, sessionId, fresh, "on-fire")).status).toBe(400);
    // Unknown session.
    expect((await putStatus(server, "no-such-session", fresh, "idle")).status).toBe(404);
  });
});

describe("§4 worker-state restore — GET /v1/code/sessions/{id}/worker (method-multiplexed with PUT, #154)", () => {
  /** GET the bare `…/worker` path — the worker-state restore leg. */
  function getWorkerState(server: CcctlServer, sessionId: string): Promise<Response> {
    return fetch(`${base(server)}${workerChannelPath(sessionId)}`, { method: "GET" });
  }

  it("answers an empty 200 `{ worker: null }` — the child's state restore, no longer a 405 retry", async () => {
    // Regression: GET on the bare `…/worker` path used to 405 (PUT-only), which the
    // child retried in a loop; it now restores empty worker state with a 200 (#154).
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const res = await getWorkerState(server, sessionId);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(405);
    expect(await res.json()).toEqual({ worker: null });
  });

  it("restores empty even before the worker registers — the leg is epoch-independent", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    // No worker/register first: there is no persisted state to restore yet, so an empty 200.
    const res = await getWorkerState(server, sessionId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worker: null });
  });

  it("fails closed on an unknown session (404)", async () => {
    const server = await startTestServer();
    expect((await getWorkerState(server, "no-such-session")).status).toBe(404);
  });

  it("multiplexes with PUT on the identical bare path — GET restores, PUT still gates status (200)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    // Both methods hit `…/worker`: GET → restore, PUT → status gate. Adding GET must not
    // have broken the PUT status gate.
    expect((await getWorkerState(server, sessionId)).status).toBe(200);
    expect((await putStatus(server, sessionId, epoch, "idle")).status).toBe(200);
    expect(server.sessions.get(sessionId)?.activity.kind).toBe("idle");
  });
});

describe("§4 per-session status isolation — N sessions never confuse status (#21)", () => {
  it("tracks each of two sessions independently across interleaved tri-state transitions", async () => {
    const server = await startTestServer();
    const s1 = await registerSession(server);
    const s2 = await registerSession(server);
    const e1 = await registerWorker(server, s1);
    const e2 = await registerWorker(server, s2);

    // Both freshly created → idle.
    expect(server.sessions.get(s1)?.activity).toEqual({ kind: "idle" });
    expect(server.sessions.get(s2)?.activity).toEqual({ kind: "idle" });

    // s1 → running; s2 is untouched and keeps its own idle.
    expect((await putStatus(server, s1, e1, "running")).status).toBe(200);
    expect(server.sessions.get(s1)?.activity).toEqual({ kind: "running" });
    expect(server.sessions.get(s2)?.activity).toEqual({ kind: "idle" });

    // s2 → requires_action; s1 keeps its own running (a transition on s2 never moves s1).
    expect((await putStatus(server, s2, e2, "requires_action")).status).toBe(200);
    expect(server.sessions.get(s2)?.activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
    expect(server.sessions.get(s1)?.activity).toEqual({ kind: "running" });

    // Cross their states — s1 → requires_action, s2 → running — so a shared-status bug
    // (one map cell, last write wins) would surface as a session wearing the other's status.
    expect((await putStatus(server, s1, e1, "requires_action")).status).toBe(200);
    expect((await putStatus(server, s2, e2, "running")).status).toBe(200);
    expect(server.sessions.get(s1)?.activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
    expect(server.sessions.get(s2)?.activity).toEqual({ kind: "running" });

    // s1 → idle; s2 keeps its own running. Each reported ONLY its own status at every step.
    expect((await putStatus(server, s1, e1, "idle")).status).toBe(200);
    expect(server.sessions.get(s1)?.activity).toEqual({ kind: "idle" });
    expect(server.sessions.get(s2)?.activity).toEqual({ kind: "running" });
  });

  it("carries three concurrent sessions each in a DISTINCT tri-state simultaneously", async () => {
    const server = await startTestServer();
    const running = await registerSession(server);
    const waiting = await registerSession(server);
    const quiet = await registerSession(server);
    const runningEpoch = await registerWorker(server, running);
    const waitingEpoch = await registerWorker(server, waiting);
    const quietEpoch = await registerWorker(server, quiet);

    // Drive the three workers to three different statuses over their OWN channels.
    expect((await putStatus(server, running, runningEpoch, "running")).status).toBe(200);
    expect((await putStatus(server, waiting, waitingEpoch, "requires_action")).status).toBe(200);
    expect((await putStatus(server, quiet, quietEpoch, "idle")).status).toBe(200);

    // All three tri-states co-exist, one per session — never confused across sessions.
    expect(server.sessions.get(running)?.activity).toEqual({ kind: "running" });
    expect(server.sessions.get(waiting)?.activity).toEqual({
      kind: "requires_action",
      detail: DEFAULT_REQUIRES_ACTION_DETAIL,
    });
    expect(server.sessions.get(quiet)?.activity).toEqual({ kind: "idle" });
  });
});

describe("§5 worker events + delivery — upstream POSTs", () => {
  it("accepts a batched worker/events POST under the current epoch (200)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    const res = await postWorkerEvents(server, sessionId, epoch, [{ type: "result", subtype: "success" }]);
    expect(res.status).toBe(200);
  });

  it("fails closed on a superseded epoch (409) and a malformed events batch (400)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    await registerWorker(server, sessionId); // supersede `epoch`.
    expect((await postWorkerEvents(server, sessionId, epoch, [{ type: "result" }])).status).toBe(409);

    const fresh = await registerWorker(server, sessionId);
    const malformed = await fetch(`${base(server)}${workerEventsPath(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_epoch: fresh, events: "not-an-array" }),
    });
    expect(malformed.status).toBe(400);
  });

  it("accepts worker/events/delivery acks under the current epoch (200), rejecting a bad shape (400)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    const acked = await fetch(`${base(server)}${workerEventsDeliveryPath(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_epoch: epoch, updates: [{ event_id: "e-1", status: "delivered" }] }),
    });
    expect(acked.status).toBe(200);
    const bad = await fetch(`${base(server)}${workerEventsDeliveryPath(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_epoch: epoch, updates: {} }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("§4 worker heartbeat — POST …/worker/heartbeat", () => {
  it("refreshes liveness (200) and fails closed on an unknown session (404)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const before = server.sessions.get(sessionId)?.lastActivityAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const beat = await fetch(`${base(server)}${workerHeartbeatPath(sessionId)}`, { method: "POST" });
    expect(beat.status).toBe(200);
    expect(server.sessions.get(sessionId)?.lastActivityAt).toBeGreaterThanOrEqual(before);

    const missing = await fetch(`${base(server)}${workerHeartbeatPath("no-such-session")}`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("turn injection — server.injectTurn pushes a client_event down the downstream", () => {
  it("pushes a { type: 'user' } client_event carrying the prompt (the load-bearing turn, #130)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);

    server.injectTurn(sessionId, "run the migration");
    await waitFor(() => stream.received().length === 1);
    const frame = stream.received()[0];

    // The event NAME is `client_event`; the demux payload is a user message.
    expect(frame.event).toBe("client_event");
    expect(frame.data.event_type).toBe("message");
    expect(typeof frame.data.sequence_num).toBe("number");
    const payload = frame.data.payload as Record<string, unknown>;
    expect(payload.type).toBe("user");
    expect(payload.session_id).toBe(sessionId);
    expect(typeof payload.uuid).toBe("string");
    const message = payload.message as { role: string; content: { type: string; text: string }[] };
    expect(message.role).toBe("user");
    expect(message.content[0]).toEqual({ type: "text", text: "run the migration" });
  });

  it("fails closed (throws) when the session has no live downstream", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    // Registered a session, but no worker downstream is open.
    expect(() => server.injectTurn(sessionId, "hi")).toThrow(/no live worker channel/);
    // Unknown session likewise.
    expect(() => server.injectTurn("no-such-session", "hi")).toThrow(/no live worker channel/);
  });
});

describe("worker liveness — server.hasLiveWorker reflects a held-open downstream (not mere session existence)", () => {
  it("is false for an unknown session and for a session whose worker has not opened its downstream", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    // Unknown session — no channel at all.
    expect(server.hasLiveWorker("no-such-session")).toBe(false);
    // Session EXISTS but no worker registered/opened a downstream — the exact case that must
    // NOT read as live (the injectTurn precondition is unmet, so a turn would fail closed).
    expect(server.hasLiveWorker(sessionId)).toBe(false);
    await registerWorker(server, sessionId);
    // Registered an epoch but still no held-open downstream → still not live.
    expect(server.hasLiveWorker(sessionId)).toBe(false);
  });

  it("is true once the worker holds its downstream open — exactly when injectTurn would NOT throw", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    await openWorkerStream(server, sessionId);

    expect(server.hasLiveWorker(sessionId)).toBe(true);
    // Corroboration: the injectTurn precondition hasLiveWorker gates is now met.
    expect(() => server.injectTurn(sessionId, "go")).not.toThrow();
  });
});

// --- #166: downstream liveness frames ---

/** Start a server whose #166 liveness interval is SHORT, so the timer fires within a test window. */
async function startLivenessServer(workerLivenessIntervalMs: number): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST, workerLivenessIntervalMs });
  started.push(server);
  return server;
}

/** One UI-transcript SSE event read off `GET /api/sessions/{id}/events`. */
interface UiSseEvent {
  readonly id: string | undefined;
  readonly data: string;
}

/** Parse one UI-transcript SSE block into `{ id, data }` (raw string `data`), or null for a comment
 *  — the string-`data` sibling of `parseWorkerSseBlock`; these frames exist only to prove none arrive. */
function parseUiSseBlock(block: string): UiSseEvent | null {
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : { id, data: dataLines.join("\n") };
}

/**
 * Subscribe a UI client to a session's transcript stream (`GET /api/sessions/{id}/events`) and
 * collect its data events — used to prove a downstream liveness frame surfaces NOTHING to the UI
 * (the transcript is fed only by the upstream `worker/events` leg).
 */
function openUiEventStream(server: CcctlServer, sessionId: string): Promise<{ received(): UiSseEvent[] }> {
  const { host, port } = server.address;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port,
        path: `/api/sessions/${sessionId}/events`,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res: IncomingMessage) => {
        streams.push(res);
        res.setEncoding("utf8");
        res.on("error", () => {}); // swallow a reset when the server ends the stream on shutdown.
        const events: UiSseEvent[] = [];
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const parsed = parseUiSseBlock(buffer.slice(0, boundary));
            if (parsed !== null) {
              events.push(parsed);
            }
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        });
        resolve({ received: () => events });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The `payload.type` of a received downstream frame, or `undefined` if it has none. */
function framePayloadType(frame: ClientEventFrame): unknown {
  return (frame.data.payload as { type?: unknown }).type;
}

describe("§4 worker downstream liveness — periodic no-op client_event frames hold an idle stream open (#166)", () => {
  const INTERVAL_MS = 25;

  it("keeps a held-open downstream alive with periodic `client_event` liveness frames at the configured interval (AC2)", async () => {
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);

    // Two+ frames prove PERIODIC emission (not a single opening push); the worker resets its
    // ~45s liveness timeout on each `client_event` it reads.
    await waitFor(() => stream.received().length >= 2);
    const frames = stream.received();
    for (const frame of frames) {
      expect(frame.event).toBe("client_event"); // the event NAME the worker counts toward liveness.
      expect(frame.data.event_type).toBe("message"); // identical envelope to a turn frame.
      expect(typeof frame.data.sequence_num).toBe("number");
    }
    // Monotonic, gap-free, unique sequence numbers — the worker sees an ordered stream.
    const seqs = frames.map((frame) => frame.data.sequence_num as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("the liveness frame is a proven no-op: not a user turn, nothing surfaced to the UI transcript, worker_status unchanged (AC3)", async () => {
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    // Idle first — the liveness frames must NOT move the session off idle.
    expect((await putStatus(server, sessionId, epoch, "idle")).status).toBe(200);
    const ui = await openUiEventStream(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);

    await waitFor(() => stream.received().length >= 2);

    for (const frame of stream.received()) {
      expect(framePayloadType(frame)).not.toBe("user"); // no turn injected.
      expect(framePayloadType(frame)).toBe("ccctl_liveness"); // the inert no-op payload.
    }
    // The transcript is fed ONLY by the upstream worker/events leg — a downstream liveness push
    // never reaches it, so the subscribed UI client sees nothing.
    expect(ui.received()).toEqual([]);
    // Derived activity (from worker_status) is untouched — still idle.
    expect(server.sessions.get(sessionId)?.activity).toEqual({ kind: "idle" });
  });

  it("does NOT disturb turn injection down the same client_event channel — the turn still lands as a `{ type: 'user' }` frame (AC5)", async () => {
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);

    server.injectTurn(sessionId, "run the migration");
    // The user turn lands, interleaved with liveness frames but present and well-formed.
    await waitFor(() => stream.received().some((frame) => framePayloadType(frame) === "user"));
    const userFrame = stream.received().find((frame) => framePayloadType(frame) === "user");
    expect(userFrame?.event).toBe("client_event");
    const payload = userFrame?.data.payload as { message?: { content?: { text?: string }[] } };
    expect(payload?.message?.content?.[0]?.text).toBe("run the migration");
  });

  it("clears the per-session timer when the downstream closes — the reap nulls the live channel and the server stays healthy (AC4)", async () => {
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stream = await openWorkerStream(server, sessionId);
    await waitFor(() => stream.received().length >= 1);
    expect(server.hasLiveWorker(sessionId)).toBe(true);

    // The worker disconnects: the close handler clears the interval and reaps the downstream.
    streams.pop()?.destroy();
    await waitFor(() => server.hasLiveWorker(sessionId) === false);
    // The server stays healthy after the reap — a dangling interval writing to a dead stream
    // would otherwise throw; a fresh register still works.
    const epoch2 = await registerWorker(server, sessionId);
    expect(epoch2).toBeGreaterThan(0);
  });

  it("supersede (re-register) clears the stale timer and ends its stream — no frames to a reaped stream, a fresh downstream re-arms (AC4)", async () => {
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const stale = await openWorkerStream(server, sessionId);
    await waitFor(() => stale.received().length >= 1);

    // Re-register bumps the epoch and supersedes: the stale downstream is ended and its timer
    // cleared synchronously.
    await registerWorker(server, sessionId);
    const frozen = stale.received().length;
    // Give a leaked interval several chances to fire against the reaped stream; it must not.
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * 4));
    expect(stale.received().length).toBe(frozen); // no dangling timer wrote to the reaped stream.

    // A fresh downstream on the new epoch re-arms its own liveness timer.
    const fresh = await openWorkerStream(server, sessionId);
    await waitFor(() => fresh.received().length >= 2);
    expect(fresh.received().every((frame) => frame.event === "client_event")).toBe(true);
  });

  it("supersede while the stale stream stays open still ends it and stops its liveness frames (AC4)", async () => {
    // A duplicate/late open on the SAME record must not orphan a liveness interval: a second
    // `events/stream` on the same epoch supersedes the first, ending it and clearing its timer.
    const server = await startLivenessServer(INTERVAL_MS);
    const sessionId = await registerSession(server);
    await registerWorker(server, sessionId);
    const first = await openWorkerStream(server, sessionId);
    await waitFor(() => first.received().length >= 1);

    // Re-open on the same session/epoch (no re-register): the first stream is superseded.
    const second = await openWorkerStream(server, sessionId);
    const firstFrozen = first.received().length;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * 4));
    expect(first.received().length).toBe(firstFrozen); // the first stream's timer was cleared, not orphaned.

    // The second (current) stream carries the live liveness timer.
    await waitFor(() => second.received().length >= 2);
    expect(second.received().every((frame) => frame.event === "client_event")).toBe(true);
    expect(server.hasLiveWorker(sessionId)).toBe(true);
  });

  it("defaults the liveness interval comfortably below the worker's ~45s timeout (AC2)", () => {
    // The default must sit in the AC's stated 20–30s band — below the worker's ~45s liveness
    // window with margin for jitter — so an idle session holds without a hand-tuned config.
    expect(DEFAULT_WORKER_LIVENESS_INTERVAL_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEFAULT_WORKER_LIVENESS_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});
