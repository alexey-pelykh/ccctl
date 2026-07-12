// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  SESSIONS_PATH,
  workerChannelPath,
  workerEventsDeliveryPath,
  workerEventsPath,
  workerEventsStreamPath,
  workerHeartbeatPath,
  workerRegisterPath,
} from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

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
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    }),
  });
  return ((await res.json()) as { session_id: string }).session_id;
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
