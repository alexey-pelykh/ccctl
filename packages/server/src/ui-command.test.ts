// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { SESSIONS_PATH } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

const ACCOUNT_BEARER = "oauth-account-secret-cmd-abc123";

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

/** POST a UI command; a string body is sent verbatim, anything else is JSON-encoded. */
function postCommand(server: CcctlServer, body: unknown): Promise<Response> {
  const { host, port } = server.address;
  return fetch(`http://${host}:${port}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
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

/**
 * Decode the server→client text frames a fake worker receives. Server frames are
 * UNMASKED (RFC 6455 §5.1); the two shorter §5.2 length forms cover the control
 * lines this suite drives. Returns the UTF-8 payload of each complete Text frame.
 */
function readServerTextFrames(buffer: Buffer): string[] {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer.readUInt8(offset);
    const b1 = buffer.readUInt8(offset + 1);
    const opcode = b0 & 0x0f;
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

/** Accumulate a fake worker socket's inbound bytes and expose the decoded text frames. */
function collectServerTextFrames(socket: Socket): () => string[] {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  return () => readServerTextFrames(buffer);
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

describe("UI command ingress — fetch POST /api/command (#13)", () => {
  it("relays a UI command to the worker channel as a control_request (202, AC#1)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const frames = collectServerTextFrames(socket);

    const res = await postCommand(server, { subtype: "prompt", payload: { text: "continue please" } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // The command lands on the worker channel as the NDJSON control_request the
    // core codec emits, carrying the server-minted id and the forwarded payload.
    await waitFor(() => frames().length === 1);
    const relayed = JSON.parse(frames()[0].trimEnd()) as Record<string, unknown>;
    expect(relayed).toEqual({
      type: "control_request",
      id,
      subtype: "prompt",
      payload: { text: "continue please" },
    });
  });

  it("mints a fresh control_request id per command (the browser does not choose it)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const frames = collectServerTextFrames(socket);

    const first = (await (await postCommand(server, { subtype: "interrupt" })).json()) as { id: string };
    const second = (await (await postCommand(server, { subtype: "interrupt" })).json()) as { id: string };
    expect(first.id).not.toBe(second.id);

    await waitFor(() => frames().length === 2);
    const ids = frames().map((frame) => (JSON.parse(frame.trimEnd()) as { id: string }).id);
    expect(ids).toEqual([first.id, second.id]);
  });

  it("forwards a command that carries no payload", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const socket = await openWorkerChannel(server, sessionId);
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    const frames = collectServerTextFrames(socket);

    const res = await postCommand(server, { subtype: "interrupt" });
    expect(res.status).toBe(202);

    await waitFor(() => frames().length === 1);
    const relayed = JSON.parse(frames()[0].trimEnd()) as Record<string, unknown>;
    expect(relayed.subtype).toBe("interrupt");
    expect(relayed).not.toHaveProperty("payload");
  });

  it("fails closed when the session has no live worker channel (409)", async () => {
    const server = await startTestServer();
    await registerSession(server);
    // Registered, but the worker never opened its channel: nothing to relay to.
    const res = await postCommand(server, { subtype: "prompt", payload: { text: "hi" } });
    expect(res.status).toBe(409);
  });

  it("fails closed when no session is registered (404)", async () => {
    const server = await startTestServer();
    const res = await postCommand(server, { subtype: "prompt" });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed command body (400)", async () => {
    const server = await startTestServer();
    await registerSession(server);
    expect((await postCommand(server, "this is not json")).status).toBe(400);
    expect((await postCommand(server, { payload: { text: "no subtype" } })).status).toBe(400);
    expect((await postCommand(server, { subtype: "" })).status).toBe(400);
    expect((await postCommand(server, { subtype: "prompt", payload: "not-an-object" })).status).toBe(400);
  });

  it("rejects a non-POST method on /api/command (405)", async () => {
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/api/command`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
