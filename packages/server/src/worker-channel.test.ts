// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import {
  DEFAULT_REQUIRES_ACTION_DETAIL,
  encodeControlFrame,
  SESSIONS_PATH,
  type ControlEvent,
  type ControlRequest,
  type WorkerStatus,
} from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

const ACCOUNT_BEARER = "oauth-account-secret-ws-abc123";

// Every started server and opened client socket is tracked and torn down in
// afterEach so no listener or connection leaks across tests.
const started: CcctlServer[] = [];
const sockets: Socket[] = [];

async function startTestServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  started.push(server);
  return server;
}

afterEach(async () => {
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

/** Create a session over the CURRENT §2 flow (`POST /v1/sessions`) and return its id + minted ws path. */
async function createBridgeSession(server: CcctlServer): Promise<{ sessionId: string; wsPath: string }> {
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
  const payload = (await res.json()) as { session_id: string; ws_url: string };
  return { sessionId: payload.session_id, wsPath: new URL(payload.ws_url).pathname };
}

type UpgradeOutcome =
  { readonly kind: "upgrade"; readonly socket: Socket } | { readonly kind: "response"; readonly status: number };

/**
 * Drive a raw WebSocket upgrade against the worker-channel path. `node:http`
 * (not the native `WebSocket`) so the `Authorization` header can be set — the
 * WHATWG client cannot. Resolves `upgrade` on the 101 handshake, or `response`
 * with the status when the server fails the upgrade closed.
 */
function openWorkerChannel(
  server: CcctlServer,
  path: string,
  options: { authorization?: string | null; upgradeHeader?: string } = {},
): Promise<UpgradeOutcome> {
  const { authorization = `Bearer ${ACCOUNT_BEARER}`, upgradeHeader = "websocket" } = options;
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: upgradeHeader,
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    "Sec-WebSocket-Version": "13",
  };
  if (authorization !== null) {
    headers.Authorization = authorization;
  }
  const { host, port } = server.address;
  return new Promise<UpgradeOutcome>((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: "GET", headers });
    req.on("upgrade", (_res, socket) => {
      sockets.push(socket);
      resolve({ kind: "upgrade", socket });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ kind: "response", status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Send one worker_status frame (masked, per RFC 6455 §5.1) over the client socket. */
function sendWorkerStatus(socket: Socket, status: WorkerStatus, detail?: string): void {
  const event: ControlEvent = {
    type: "control_event",
    subtype: "worker_status",
    payload: detail === undefined ? { status } : { status, detail },
  };
  socket.write(maskedTextFrame(encodeControlFrame(event)));
}

/**
 * Encode a single masked (client → server, RFC 6455 §5.1) frame with `opcode` and
 * `payload`; FIN is always set — the client helpers send whole messages. Hand-rolled
 * on purpose, independent of the server codec it exercises.
 */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const b0 = 0x80 | opcode; // FIN + opcode.
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

/** Encode `text` as a single masked WebSocket text frame (opcode 0x1). */
function maskedTextFrame(text: string): Buffer {
  return maskedFrame(0x1, Buffer.from(text, "utf8"));
}

/** Encode a masked WebSocket Close frame (opcode 0x8) carrying `code` (RFC 6455 §5.5.1). */
function maskedCloseFrame(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return maskedFrame(0x8, payload);
}

/**
 * Encode an UNMASKED text frame — a deliberate RFC 6455 §5.1 violation (client
 * frames MUST be masked) — to exercise the server's fail-closed teardown.
 */
function unmaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/**
 * Decode the server→client text frames a fake worker receives — the read-path mirror
 * of `maskedTextFrame`. Server frames are UNMASKED (RFC 6455 §5.1), so there is no
 * mask key; all three §5.2 length forms are handled. Hand-rolled and independent of
 * the server codec it exercises. Returns the UTF-8 payload of each complete Text
 * frame; a partial trailing frame is left for the next chunk.
 */
function readServerTextFrames(buffer: Buffer): string[] {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer.readUInt8(offset);
    const b1 = buffer.readUInt8(offset + 1);
    const opcode = b0 & 0x0f;
    if ((b1 & 0x80) !== 0) {
      throw new Error("server→client frame is masked (RFC 6455 §5.1 requires server frames to be unmasked)");
    }
    let length = b1 & 0x7f;
    let dataOffset = offset + 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      dataOffset = offset + 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      dataOffset = offset + 10;
    }
    if (dataOffset + length > buffer.length) break; // payload not yet fully buffered.
    if (opcode === 0x1) {
      texts.push(buffer.subarray(dataOffset, dataOffset + length).toString("utf8"));
    }
    offset = dataOffset + length;
  }
  return texts;
}

/** Accumulate a fake worker socket's inbound bytes and expose the decoded server text frames. */
function collectServerTextFrames(socket: Socket): () => string[] {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  return () => readServerTextFrames(buffer);
}

/** Poll `predicate` until it holds or the timeout lapses (the receiver-grounded wait). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("worker channel — WebSocket at ws_url", () => {
  it("opens the channel at the §2-minted /v1/sessions/{id}/ws and reaches ready with the account Bearer (AC#1, current flow)", async () => {
    const server = await startTestServer();
    const { sessionId, wsPath } = await createBridgeSession(server);
    // The current flow mints the worker channel under /v1/sessions/{id}/ws.
    expect(wsPath).toBe(`${SESSIONS_PATH}/${sessionId}/ws`);
    expect(server.sessions.get(sessionId)?.status).toBe("connecting");

    // The account Bearer is ACCEPTED on the §4 upgrade over the current-flow path, and
    // the session moves connecting → ready — the §2→§4 seam end to end.
    const outcome = await openWorkerChannel(server, wsPath);
    expect(outcome.kind).toBe("upgrade");
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    // A worker_status frame derives activity over the current-flow channel too.
    if (outcome.kind === "upgrade") {
      sendWorkerStatus(outcome.socket, "running");
      await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "running");
    }
  });

  it("reads worker_status frames and surfaces the tri-state activity (AC#2)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }

    // A fresh session is idle until the first frame.
    expect(server.sessions.get(sessionId)?.activity).toEqual({ kind: "idle" });

    sendWorkerStatus(outcome.socket, "running");
    await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "running");

    sendWorkerStatus(outcome.socket, "requires_action", "Approve the edit?");
    await waitFor(() => {
      const activity = server.sessions.get(sessionId)?.activity;
      return activity?.kind === "requires_action" && activity.detail === "Approve the edit?";
    });

    sendWorkerStatus(outcome.socket, "idle");
    await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "idle");

    // The account Bearer presented on the WS connect is never persisted (§4).
    expect(JSON.stringify([...server.sessions.values()])).not.toContain(ACCOUNT_BEARER);
  });

  it("supplies the default detail for a requires_action frame that carries none", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }

    sendWorkerStatus(outcome.socket, "requires_action");
    await waitFor(() => {
      const activity = server.sessions.get(sessionId)?.activity;
      return activity?.kind === "requires_action" && activity.detail === DEFAULT_REQUIRES_ACTION_DETAIL;
    });
  });

  it("skips a malformed line and keeps reading the channel", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }

    sendWorkerStatus(outcome.socket, "running");
    await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "running");

    // A garbage line and a non-worker_status frame are both no-ops that must NOT
    // tear the channel down: a following valid frame still lands.
    outcome.socket.write(maskedTextFrame("this is not json\n"));
    outcome.socket.write(
      maskedTextFrame(encodeControlFrame({ type: "control_event", subtype: "message", payload: {} })),
    );
    sendWorkerStatus(outcome.socket, "idle");

    await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "idle");
    expect(server.sessions.get(sessionId)?.status).toBe("ready");
  });

  it("fails closed when the account Bearer is missing on the WS connect (AC#3 / §4)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`, { authorization: null });
    expect(outcome).toEqual({ kind: "response", status: 401 });
    // The channel never opened: the session stays in its pre-connect lifecycle.
    expect(server.sessions.get(sessionId)?.status).toBe("connecting");
  });

  it("fails closed on an unknown session id (404)", async () => {
    const server = await startTestServer();
    await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/does-not-exist/ws`);
    expect(outcome).toEqual({ kind: "response", status: 404 });
  });

  it("fails closed on a non-worker-channel path (404)", async () => {
    const server = await startTestServer();
    const outcome = await openWorkerChannel(server, "/v1/nope");
    expect(outcome).toEqual({ kind: "response", status: 404 });
  });

  it("fails closed on a non-websocket upgrade (400)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);

    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`, {
      upgradeHeader: "h2c",
    });
    expect(outcome).toEqual({ kind: "response", status: 400 });
    // The channel never opened: the session stays in its pre-connect lifecycle.
    expect(server.sessions.get(sessionId)?.status).toBe("connecting");
  });

  it("moves the session to closed when the worker sends a WebSocket Close frame", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    outcome.socket.write(maskedCloseFrame(1000));
    await waitFor(() => server.sessions.get(sessionId)?.status === "closed");
  });

  it("reaps the channel on an unclean disconnect (TCP FIN, no Close frame) and frees the slot", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const first = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (first.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${first.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    // A bare half-close (FIN) with NO WebSocket Close frame must still be reaped —
    // otherwise the session stays `ready` and its one-channel slot is held forever.
    first.socket.end();
    await waitFor(() => server.sessions.get(sessionId)?.status === "closed");

    // The slot is freed: a reconnect for the same session is accepted, not 409'd.
    const second = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    expect(second.kind).toBe("upgrade");
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
  });

  it("refuses a second concurrent worker channel for the same session (409)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const first = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (first.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${first.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    // The first channel is still live: a second upgrade for the same session fails
    // closed rather than racing two channels over one session's state.
    const second = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    expect(second).toEqual({ kind: "response", status: 409 });
    // The live channel is untouched.
    expect(server.sessions.get(sessionId)?.status).toBe("ready");
  });

  it("tears the channel down on a framing protocol error (an unmasked client frame)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    // RFC 6455 §5.1 requires client frames to be masked; an unmasked frame is a
    // protocol error → the server closes with 1002 and reaps the channel.
    outcome.socket.write(unmaskedTextFrame("this frame is not masked\n"));
    await waitFor(() => server.sessions.get(sessionId)?.status === "closed");
  });
});

// The steer verbs the UI can send (issue #12 AC). The transport is subtype-agnostic —
// each verb is just a control_request with its own subtype/payload — so the three
// share one delivery assertion, parametrized to pin the AC's exact wording.
const STEERS: ReadonlyArray<{ verb: string; request: ControlRequest }> = [
  {
    verb: "send",
    request: { type: "control_request", id: "s1", subtype: "prompt", payload: { text: "continue please" } },
  },
  {
    verb: "approve",
    request: { type: "control_request", id: "a1", subtype: "approve", payload: { toolUseId: "tool-42" } },
  },
  {
    verb: "redirect",
    request: { type: "control_request", id: "r1", subtype: "interrupt", payload: { reason: "stop, do X instead" } },
  },
];

describe("worker channel — steer relay (UI → worker, §2)", () => {
  it.each(STEERS)("writes a $verb steer to the correct session's worker WebSocket (AC#1)", async ({ request }) => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const frames = collectServerTextFrames(outcome.socket);

    server.dispatch(sessionId, request);

    // The steer lands on the worker channel as exactly the NDJSON control_request
    // line the core codec emits — same encoder the read path decodes.
    await waitFor(() => frames().length === 1);
    expect(frames()[0]).toBe(encodeControlFrame(request));
    expect(JSON.parse(frames()[0]?.trimEnd() ?? "null")).toEqual(request);
  });

  it("delivers the steer over the live channel of a running session — the turn continues (AC#2)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    const frames = collectServerTextFrames(outcome.socket);

    // Drive the session to `running`, then steer it: the steer rides the SAME open
    // worker channel the worker is streaming on, so it reaches the in-flight turn.
    sendWorkerStatus(outcome.socket, "running");
    await waitFor(() => server.sessions.get(sessionId)?.activity.kind === "running");

    const request: ControlRequest = {
      type: "control_request",
      id: "t1",
      subtype: "prompt",
      payload: { text: "keep going" },
    };
    server.dispatch(sessionId, request);

    await waitFor(() => frames().length === 1);
    expect(JSON.parse(frames()[0]?.trimEnd() ?? "null")).toEqual(request);
    // The channel stays live after steering — the turn continues, not torn down.
    expect(server.sessions.get(sessionId)?.status).toBe("ready");
  });

  it("writes a large steer that needs an extended-length frame (>126 bytes)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const frames = collectServerTextFrames(outcome.socket);

    // A realistic "send" steer whose prompt alone pushes the NDJSON line well past
    // the 126-byte 7-bit length form — the frame the pre-#12 encoder refused.
    const request: ControlRequest = {
      type: "control_request",
      id: "big-1",
      subtype: "prompt",
      payload: { text: "x".repeat(500) },
    };
    expect(encodeControlFrame(request).length).toBeGreaterThan(126);

    server.dispatch(sessionId, request);

    await waitFor(() => frames().length === 1);
    expect(frames()[0]).toBe(encodeControlFrame(request));
    expect(JSON.parse(frames()[0]?.trimEnd() ?? "null")).toEqual(request);
  });

  it("fails closed when steering a session with no live worker channel", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const request: ControlRequest = { type: "control_request", id: "x", subtype: "prompt" };

    // Registered, but the worker has not opened its channel yet: no socket to write to.
    expect(() => server.dispatch(sessionId, request)).toThrow(/no live worker channel/);
    // An unknown session id likewise fails closed — the steer is keyed to THE
    // session's channel, never broadcast.
    expect(() => server.dispatch("does-not-exist", request)).toThrow(/no live worker channel/);
  });

  it("stops delivering steers once the channel is reaped (fail-closed after close)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const outcome = await openWorkerChannel(server, `${SESSIONS_PATH}/${sessionId}/ws`);
    if (outcome.kind !== "upgrade") {
      throw new Error(`expected an upgrade, got ${outcome.kind}`);
    }
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");

    outcome.socket.write(maskedCloseFrame(1000));
    await waitFor(() => server.sessions.get(sessionId)?.status === "closed");

    const request: ControlRequest = { type: "control_request", id: "late", subtype: "prompt" };
    expect(() => server.dispatch(sessionId, request)).toThrow(/no live worker channel/);
  });
});
