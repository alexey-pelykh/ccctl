// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { SESSIONS_PATH, workerEventsPath, workerRegisterPath, type ControlEvent } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";
import { closeSessionRelay, createSessionEventRelays, relayFor } from "./event-stream.js";

const ACCOUNT_BEARER = "oauth-account-secret-sse-abc123";

// Every started server and SSE stream is tracked and torn down in afterEach so no
// listener or connection leaks across tests.
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

/** The per-session SSE subscription path (#20). */
function eventsPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/events`;
}

/** A session with a registered worker channel: the id + the worker's current epoch. */
interface ReadySession {
  readonly sessionId: string;
  readonly epoch: number;
}

/** Create a §2 session and register its §4 worker so its §5 upstream `worker/events` is drivable. */
async function readySession(server: CcctlServer): Promise<ReadySession> {
  const created = await fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCOUNT_BEARER}` },
    body: JSON.stringify({
      session_context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    }),
  });
  const sessionId = ((await created.json()) as { session_id: string }).session_id;
  const registered = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const epoch = ((await registered.json()) as { worker_epoch: number }).worker_epoch;
  return { sessionId, epoch };
}

/** Drive the §5 upstream leg: POST a batch of raw worker-event `entries` (each `{ payload }` or malformed). */
function emit(server: CcctlServer, ready: ReadySession, entries: unknown[]): Promise<Response> {
  return fetch(`${base(server)}${workerEventsPath(ready.sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_epoch: ready.epoch, events: entries }),
  });
}

/** Wrap payloads as well-formed `{ payload }` upstream entries. */
function payloads(...values: unknown[]): { payload: unknown }[] {
  return values.map((payload) => ({ payload }));
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

/** Open an EventSource-style GET against a session's `…/events` and collect parsed SSE events. */
function openSse(server: CcctlServer, sessionId: string, options: { lastEventId?: string } = {}): Promise<SseClient> {
  const { host, port } = server.address;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }
  return new Promise<SseClient>((resolve, reject) => {
    const req = httpRequest({ host, port, path: eventsPath(sessionId), method: "GET", headers });
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

describe("UI event stream — per-session SSE relay (GET /api/sessions/{id}/events, #13/#20)", () => {
  it("serves the text/event-stream content type", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const sse = await openSse(server, ready.sessionId);
    expect(sse.statusCode).toBe(200);
    expect(sse.contentType).toBe("text/event-stream");
  });

  it("404s a subscribe to an unknown session (never opens a stream onto a non-session)", async () => {
    const server = await startTestServer();
    const res = await fetch(`${base(server)}${eventsPath("00000000-0000-0000-0000-000000000000")}`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    // Drain so the socket does not stall the run.
    await res.text();
  });

  it("relays worker upstream payloads to a subscriber with a monotonic Last-Event-ID", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const sse = await openSse(server, ready.sessionId);

    const first = transcriptEvent("one");
    const second = transcriptEvent("two");
    await emit(server, ready, payloads(first, second));

    await waitFor(() => sse.received().length === 2);
    const events = sse.received();
    expect(events[0].id).toBe("1");
    expect(events[1].id).toBe("2");
    // The payload is relayed VERBATIM, so it round-trips through the SSE `data:` line.
    expect(JSON.parse(events[0].data)).toEqual(first);
    expect(JSON.parse(events[1].data)).toEqual(second);
  });

  it("fans one event out to every connected subscriber of that session", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const a = await openSse(server, ready.sessionId);
    const b = await openSse(server, ready.sessionId);

    await emit(server, ready, payloads(transcriptEvent("hello")));

    await waitFor(() => a.received().length === 1 && b.received().length === 1);
    expect(JSON.parse(a.received()[0].data)).toEqual(transcriptEvent("hello"));
    expect(JSON.parse(b.received()[0].data)).toEqual(transcriptEvent("hello"));
  });

  it("routes a session's events to ONLY that session's subscribers — never cross-wired (#20)", async () => {
    const server = await startTestServer();
    const sessionA = await readySession(server);
    const sessionB = await readySession(server);
    const viewerA = await openSse(server, sessionA.sessionId);
    const viewerB = await openSse(server, sessionB.sessionId);

    // Emit ONLY on session A's upstream. Session B's viewer must never see it.
    await emit(server, sessionA, payloads(transcriptEvent("for-A-only")));

    await waitFor(() => viewerA.received().length === 1);
    // Give any (erroneous) cross-wired delivery to B a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(JSON.parse(viewerA.received()[0].data)).toEqual(transcriptEvent("for-A-only"));
    expect(viewerB.received()).toHaveLength(0);

    // The converse: an emit on B reaches only B, and B's id cursor is INDEPENDENT (also 1).
    await emit(server, sessionB, payloads(transcriptEvent("for-B-only")));
    await waitFor(() => viewerB.received().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(JSON.parse(viewerB.received()[0].data)).toEqual(transcriptEvent("for-B-only"));
    expect(viewerB.received()[0].id).toBe("1"); // per-session cursor, not the server's global count.
    expect(viewerA.received()).toHaveLength(1); // still just A's own single event.
  });

  it("skips a malformed batch entry (no payload) rather than relaying it", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const sse = await openSse(server, ready.sessionId);

    // A garbage entry between two valid payloads must be skipped, not relayed: two
    // events reach the stream for three entries posted.
    const before = transcriptEvent("before");
    const after = transcriptEvent("after");
    await emit(server, ready, [{ payload: before }, { notPayload: "x" }, { payload: after }]);

    await waitFor(() => sse.received().length === 2);
    expect(JSON.parse(sse.received()[0].data)).toEqual(before);
    expect(JSON.parse(sse.received()[1].data)).toEqual(after);
  });

  it("replays only the events after Last-Event-ID on reconnect", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);

    // Three events are relayed (and retained) before the reconnecting client asks to
    // resume from id 1 — it must receive exactly ids 2 and 3.
    await emit(server, ready, payloads(transcriptEvent("e1"), transcriptEvent("e2"), transcriptEvent("e3")));

    const sse = await openSse(server, ready.sessionId, { lastEventId: "1" });
    await waitFor(() => sse.received().length === 2);
    expect(sse.received().map((event) => event.id)).toEqual(["2", "3"]);
    expect(JSON.parse(sse.received()[0].data)).toEqual(transcriptEvent("e2"));
    expect(JSON.parse(sse.received()[1].data)).toEqual(transcriptEvent("e3"));
  });

  it("does not replay the backlog to a fresh connection (no Last-Event-ID)", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);

    await emit(server, ready, payloads(transcriptEvent("old-1"), transcriptEvent("old-2")));

    const sse = await openSse(server, ready.sessionId);
    // A fresh connection starts live: give any (erroneous) replay a chance to land,
    // then confirm the backlog was NOT delivered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sse.received()).toHaveLength(0);

    // A subsequent live event is delivered, and carries the next id after the backlog.
    await emit(server, ready, payloads(transcriptEvent("live")));
    await waitFor(() => sse.received().length === 1);
    expect(sse.received()[0].id).toBe("3");
    expect(JSON.parse(sse.received()[0].data)).toEqual(transcriptEvent("live"));
  });

  it("ends open SSE streams when the server closes", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const sse = await openSse(server, ready.sessionId);
    expect(sse.ended()).toBe(false);

    // Take ownership so afterEach does not double-close the (now closed) server.
    const index = started.indexOf(server);
    if (index !== -1) {
      started.splice(index, 1);
    }
    await server.close();

    await waitFor(() => sse.ended());
  });

  it("rejects a non-GET method on a session events path (405)", async () => {
    const server = await startTestServer();
    const ready = await readySession(server);
    const res = await fetch(`${base(server)}${eventsPath(ready.sessionId)}`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("closeSessionRelay — reap a single session's relay on eviction (#176)", () => {
  it("removes ONLY the target session's relay entry, leaving other sessions' relays intact", () => {
    const relays = createSessionEventRelays();
    relayFor(relays, "sess-A");
    relayFor(relays, "sess-B");

    closeSessionRelay(relays, "sess-A");

    expect(relays.has("sess-A")).toBe(false); // the evicted session's relay is dropped ...
    expect(relays.has("sess-B")).toBe(true); // ... and ONLY it — a sibling session is never cross-reaped.
  });

  it("is a no-op when the session has no relay (never subscribed-to or broadcast-to)", () => {
    const relays = createSessionEventRelays();
    expect(() => closeSessionRelay(relays, "ghost")).not.toThrow();
    expect(relays.has("ghost")).toBe(false);
  });
});
