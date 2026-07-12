// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { SESSIONS_PATH, workerEventsStreamPath, workerRegisterPath } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

const ACCOUNT_BEARER = "oauth-account-secret-cmd-abc123";

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

/** Create a §2 session and return its id. */
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

/** §4 — register the worker so a downstream can attach. */
async function registerWorker(server: CcctlServer, sessionId: string): Promise<void> {
  await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** POST a UI command; a string body is sent verbatim, anything else is JSON-encoded. */
function postCommand(server: CcctlServer, body: unknown): Promise<Response> {
  return fetch(`${base(server)}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface ClientEventFrame {
  readonly event: string | undefined;
  readonly data: Record<string, unknown>;
}

/** Parse one SSE block off the worker downstream into a `client_event` frame, or null for a comment. */
function parseWorkerSseBlock(block: string): ClientEventFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

/** Open the held-open worker downstream and expose the `client_event` frames it receives. */
function openWorkerStream(server: CcctlServer, sessionId: string): Promise<() => ClientEventFrame[]> {
  const { host, port } = server.address;
  return new Promise<() => ClientEventFrame[]>((resolve, reject) => {
    const req = httpRequest(
      { host, port, path: workerEventsStreamPath(sessionId), method: "GET", headers: { Accept: "text/event-stream" } },
      (res: IncomingMessage) => {
        streams.push(res);
        res.setEncoding("utf8");
        res.on("error", () => {});
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
        resolve(() => frames);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Register a session + worker and open its downstream — everything a relay needs to land. */
async function readyWorker(server: CcctlServer): Promise<{ sessionId: string; frames: () => ClientEventFrame[] }> {
  const sessionId = await registerSession(server);
  await registerWorker(server, sessionId);
  const frames = await openWorkerStream(server, sessionId);
  return { sessionId, frames };
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
  it("relays a prompt command as a { type: 'user' } turn (202, the load-bearing turn #130)", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    const res = await postCommand(server, { subtype: "prompt", payload: { text: "continue please" } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    await waitFor(() => frames().length === 1);
    const frame = frames()[0];
    expect(frame.event).toBe("client_event");
    const payload = frame.data.payload as Record<string, unknown>;
    expect(payload.type).toBe("user");
    expect(payload.session_id).toBe(sessionId);
    const message = payload.message as { content: { text: string }[] };
    expect(message.content[0].text).toBe("continue please");
  });

  it("relays a non-prompt verb as a control_request carrying the server-minted id", async () => {
    const server = await startTestServer();
    const { frames } = await readyWorker(server);

    const res = await postCommand(server, { subtype: "interrupt", payload: { reason: "stop" } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    expect(payload).toEqual({ type: "control_request", id, subtype: "interrupt", payload: { reason: "stop" } });
  });

  it("mints a fresh correlation id per command (the browser does not choose it)", async () => {
    const server = await startTestServer();
    const { frames } = await readyWorker(server);

    const first = (await (await postCommand(server, { subtype: "interrupt" })).json()) as { id: string };
    const second = (await (await postCommand(server, { subtype: "interrupt" })).json()) as { id: string };
    expect(first.id).not.toBe(second.id);

    await waitFor(() => frames().length === 2);
    const ids = frames().map((frame) => (frame.data.payload as { id: string }).id);
    expect(ids).toEqual([first.id, second.id]);
  });

  it("forwards a control_request that carries no payload", async () => {
    const server = await startTestServer();
    const { frames } = await readyWorker(server);

    const res = await postCommand(server, { subtype: "interrupt" });
    expect(res.status).toBe(202);

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    expect(payload.subtype).toBe("interrupt");
    expect(payload).not.toHaveProperty("payload");
  });

  it("fails closed when the session has no live worker channel (409)", async () => {
    const server = await startTestServer();
    await registerSession(server);
    // Registered, but the worker never opened its downstream: nothing to relay to.
    const res = await postCommand(server, { subtype: "prompt", payload: { text: "hi" } });
    expect(res.status).toBe(409);
  });

  it("fails closed when no session is registered (404)", async () => {
    const server = await startTestServer();
    const res = await postCommand(server, { subtype: "interrupt" });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed command body, including a blank prompt (400)", async () => {
    const server = await startTestServer();
    await registerSession(server);
    expect((await postCommand(server, "this is not json")).status).toBe(400);
    expect((await postCommand(server, { payload: { text: "no subtype" } })).status).toBe(400);
    expect((await postCommand(server, { subtype: "" })).status).toBe(400);
    expect((await postCommand(server, { subtype: "prompt", payload: "not-an-object" })).status).toBe(400);
    // A prompt with no / blank text is a 400 before any relay is attempted.
    expect((await postCommand(server, { subtype: "prompt" })).status).toBe(400);
    expect((await postCommand(server, { subtype: "prompt", payload: { text: "   " } })).status).toBe(400);
  });

  it("rejects a non-POST method on /api/command (405)", async () => {
    const server = await startTestServer();
    const res = await fetch(`${base(server)}/api/command`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
