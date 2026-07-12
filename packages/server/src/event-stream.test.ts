// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { encodeControlFrame, SESSIONS_PATH, type ControlEvent } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

const ACCOUNT_BEARER = "oauth-account-secret-sse-abc123";

// Every started server, client socket, and SSE stream is tracked and torn down in
// afterEach so no listener or connection leaks across tests.
const started: CcctlServer[] = [];
const sockets: Socket[] = [];
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
  while (sockets.length > 0) {
    sockets.pop()?.destroy();
  }
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

/** Create a session over the current §2 flow (`POST /v1/sessions`) and return its id. */
async function registerSession(server: CcctlServer): Promise<string> {
  const { host, port } = server.address;
  const res = await fetch(`http://${host}:${port}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCOUNT_BEARER}` },
    body: JSON.stringify({
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    }),
  });
  const payload = (await res.json()) as { session_id: string };
  return payload.session_id;
}

interface SseEvent {
  readonly id: string | undefined;
  readonly data: string;
}

interface SseClient {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  received(): SseEvent[];
  ended(): boolean;
}

/** Parse one SSE block into an event, or null for a comment/keep-alive-only block. */
function parseSseBlock(block: string): SseEvent | null {
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue; // an SSE comment (the stream opener / keep-alive) — not an event.
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : { id, data: dataLines.join("\n") };
}

/** Open an EventSource-style GET against /api/events and collect parsed SSE events. */
function openSse(server: CcctlServer, options: { lastEventId?: string } = {}): Promise<SseClient> {
  const { host, port } = server.address;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }
  return new Promise<SseClient>((resolve, reject) => {
    const req = httpRequest({ host, port, path: "/api/events", method: "GET", headers });
    req.on("response", (res) => {
      streams.push(res);
      res.setEncoding("utf8");
      const events: SseEvent[] = [];
      let ended = false;
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const parsed = parseSseBlock(buffer.slice(0, boundary));
          if (parsed !== null) {
            events.push(parsed);
          }
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      });
      res.on("end", () => {
        ended = true;
      });
      resolve({
        statusCode: res.statusCode ?? 0,
        contentType: res.headers["content-type"],
        received: () => events,
        ended: () => ended,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Encode `text` as a single masked (client → server, RFC 6455 §5.1) text frame. */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const b0 = 0x81; // FIN + text opcode.
  const header =
    payload.length < 126
      ? Buffer.from([b0, 0x80 | payload.length])
      : (() => {
          const h = Buffer.alloc(4);
          h.writeUInt8(b0, 0);
          h.writeUInt8(0x80 | 126, 1);
          h.writeUInt16BE(payload.length, 2);
          return h;
        })();
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/** Send a control frame over the worker channel as a masked NDJSON text frame. */
function sendFrame(socket: Socket, frame: Parameters<typeof encodeControlFrame>[0]): void {
  socket.write(maskedTextFrame(encodeControlFrame(frame)));
}

/** Open the worker channel over a raw upgrade and return the connected socket. */
function openWorkerChannel(server: CcctlServer, sessionId: string): Promise<Socket> {
  const { host, port } = server.address;
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    "Sec-WebSocket-Version": "13",
    Authorization: `Bearer ${ACCOUNT_BEARER}`,
  };
  return new Promise<Socket>((resolve, reject) => {
    const req = httpRequest({ host, port, path: `${SESSIONS_PATH}/${sessionId}/ws`, method: "GET", headers });
    req.on("upgrade", (_res, socket) => {
      sockets.push(socket);
      resolve(socket);
    });
    req.on("response", (res) => {
      reject(new Error(`expected an upgrade, got HTTP ${res.statusCode ?? 0}`));
    });
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

const transcriptEvent = (text: string): ControlEvent => ({
  type: "control_event",
  subtype: "message",
  payload: { text },
});

describe("UI event stream — SSE relay (GET /api/events, #13)", () => {
  it("serves the text/event-stream content type", async () => {
    const server = await startTestServer();
    const sse = await openSse(server);
    expect(sse.statusCode).toBe(200);
    expect(sse.contentType).toBe("text/event-stream");
  });

  it("relays broadcast events to a subscriber with a monotonic Last-Event-ID (AC#2)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const sse = await openSse(server);

    const first = transcriptEvent("one");
    const second = transcriptEvent("two");
    server.broadcast(sessionId, first);
    server.broadcast(sessionId, second);

    await waitFor(() => sse.received().length === 2);
    const events = sse.received();
    expect(events[0].id).toBe("1");
    expect(events[1].id).toBe("2");
    expect(JSON.parse(events[0].data)).toEqual(first);
    expect(JSON.parse(events[1].data)).toEqual(second);
  });

  it("fans one event out to every connected subscriber", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const a = await openSse(server);
    const b = await openSse(server);

    server.broadcast(sessionId, transcriptEvent("hello"));

    await waitFor(() => a.received().length === 1 && b.received().length === 1);
    expect(JSON.parse(a.received()[0].data)).toEqual(transcriptEvent("hello"));
    expect(JSON.parse(b.received()[0].data)).toEqual(transcriptEvent("hello"));
  });

  it("relays a worker control_event end-to-end (worker channel → SSE, AC#1)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const sse = await openSse(server);

    const event = transcriptEvent("hi from the worker");
    sendFrame(socket, event);

    await waitFor(() => sse.received().length === 1);
    expect(JSON.parse(sse.received()[0].data)).toEqual(event);
    expect(sse.received()[0].id).toBe("1");
  });

  it("relays worker_status while still driving session activity (coexists with the #11 read path)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const sse = await openSse(server);

    const statusEvent: ControlEvent = {
      type: "control_event",
      subtype: "worker_status",
      payload: { status: "running" },
    };
    sendFrame(socket, statusEvent);

    // The frame both surfaces on the UI stream AND advances the derived activity.
    await waitFor(() => sse.received().length === 1);
    expect(JSON.parse(sse.received()[0].data)).toEqual(statusEvent);
    expect(server.sessions.get(sessionId)?.activity.kind).toBe("running");
  });

  it("does not emit an SSE event for a malformed worker line", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const sse = await openSse(server);

    // A garbage line between two valid events must be skipped, not relayed: two
    // events reach the stream for three lines written.
    const before = transcriptEvent("before");
    const after = transcriptEvent("after");
    sendFrame(socket, before);
    socket.write(maskedTextFrame("this is not json\n"));
    sendFrame(socket, after);

    await waitFor(() => sse.received().length === 2);
    expect(JSON.parse(sse.received()[0].data)).toEqual(before);
    expect(JSON.parse(sse.received()[1].data)).toEqual(after);
  });

  it("replays only the events after Last-Event-ID on reconnect (AC#2)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    // Three events are relayed (and retained) before the reconnecting client asks
    // to resume from id 1 — it must receive exactly ids 2 and 3.
    server.broadcast(sessionId, transcriptEvent("e1"));
    server.broadcast(sessionId, transcriptEvent("e2"));
    server.broadcast(sessionId, transcriptEvent("e3"));

    const sse = await openSse(server, { lastEventId: "1" });
    await waitFor(() => sse.received().length === 2);
    expect(sse.received().map((event) => event.id)).toEqual(["2", "3"]);
    expect(JSON.parse(sse.received()[0].data)).toEqual(transcriptEvent("e2"));
    expect(JSON.parse(sse.received()[1].data)).toEqual(transcriptEvent("e3"));
  });

  it("does not replay the backlog to a fresh connection (no Last-Event-ID)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    server.broadcast(sessionId, transcriptEvent("old-1"));
    server.broadcast(sessionId, transcriptEvent("old-2"));

    const sse = await openSse(server);
    // A fresh connection starts live: give any (erroneous) replay a chance to land,
    // then confirm the backlog was NOT delivered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sse.received()).toHaveLength(0);

    // A subsequent live event is delivered, and carries the next id after the backlog.
    server.broadcast(sessionId, transcriptEvent("live"));
    await waitFor(() => sse.received().length === 1);
    expect(sse.received()[0].id).toBe("3");
    expect(JSON.parse(sse.received()[0].data)).toEqual(transcriptEvent("live"));
  });

  it("ends open SSE streams when the server closes", async () => {
    const server = await startTestServer();
    const sse = await openSse(server);
    expect(sse.ended()).toBe(false);

    // Take ownership so afterEach does not double-close the (now closed) server.
    const index = started.indexOf(server);
    if (index !== -1) {
      started.splice(index, 1);
    }
    await server.close();

    await waitFor(() => sse.ended());
  });

  it("rejects a non-GET method on /api/events (405)", async () => {
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/api/events`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
