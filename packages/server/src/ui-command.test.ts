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

/** The per-session steer-ingress path (#20). */
function commandPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/command`;
}

/** Create a §2 session and return its id. */
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

/** §4 — register the worker so a downstream can attach. */
async function registerWorker(server: CcctlServer, sessionId: string): Promise<void> {
  await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** POST a UI steer to a session; a string body is sent verbatim, anything else is JSON-encoded. */
function postCommand(server: CcctlServer, sessionId: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${commandPath(sessionId)}`, {
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

describe("UI command ingress — per-session fetch POST /api/sessions/{id}/command (#13/#20)", () => {
  it("relays a prompt command as a { type: 'user' } turn (202, the load-bearing turn #130)", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    const res = await postCommand(server, sessionId, { subtype: "prompt", payload: { text: "continue please" } });
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
    const { sessionId, frames } = await readyWorker(server);

    const res = await postCommand(server, sessionId, { subtype: "interrupt", payload: { reason: "stop" } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    expect(payload).toEqual({ type: "control_request", id, subtype: "interrupt", payload: { reason: "stop" } });
  });

  it("mints a fresh correlation id per command (the browser does not choose it)", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    const first = (await (await postCommand(server, sessionId, { subtype: "interrupt" })).json()) as { id: string };
    const second = (await (await postCommand(server, sessionId, { subtype: "interrupt" })).json()) as { id: string };
    expect(first.id).not.toBe(second.id);

    await waitFor(() => frames().length === 2);
    const ids = frames().map((frame) => (frame.data.payload as { id: string }).id);
    expect(ids).toEqual([first.id, second.id]);
  });

  it("forwards a control_request that carries no payload", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    const res = await postCommand(server, sessionId, { subtype: "interrupt" });
    expect(res.status).toBe(202);

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    expect(payload.subtype).toBe("interrupt");
    expect(payload).not.toHaveProperty("payload");
  });

  it("steers ONLY the addressed session — a steer never reaches another session's worker (#20)", async () => {
    const server = await startTestServer();
    const sessionA = await readyWorker(server);
    const sessionB = await readyWorker(server);

    // Steer ONLY session A. Session B's worker must never receive the frame.
    const res = await postCommand(server, sessionA.sessionId, { subtype: "interrupt", payload: { reason: "stop-A" } });
    expect(res.status).toBe(202);

    await waitFor(() => sessionA.frames().length === 1);
    // Give any (erroneous) cross-wired delivery to B a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionA.frames()).toHaveLength(1);
    expect(sessionB.frames()).toHaveLength(0);
    const payloadA = sessionA.frames()[0].data.payload as Record<string, unknown>;
    expect(payloadA).toMatchObject({ type: "control_request", subtype: "interrupt", payload: { reason: "stop-A" } });

    // The converse: steering B reaches only B, leaving A's single frame untouched.
    await postCommand(server, sessionB.sessionId, { subtype: "interrupt", payload: { reason: "stop-B" } });
    await waitFor(() => sessionB.frames().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionB.frames()).toHaveLength(1);
    expect(sessionA.frames()).toHaveLength(1);
    const payloadB = sessionB.frames()[0].data.payload as Record<string, unknown>;
    expect(payloadB).toMatchObject({ payload: { reason: "stop-B" } });
  });

  it("fails closed when the addressed session has no live worker channel (409)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    // Registered, but the worker never opened its downstream: nothing to relay to.
    const res = await postCommand(server, sessionId, { subtype: "prompt", payload: { text: "hi" } });
    expect(res.status).toBe(409);
  });

  it("fails closed when the addressed session id is unknown (404)", async () => {
    const server = await startTestServer();
    const res = await postCommand(server, "00000000-0000-0000-0000-000000000000", { subtype: "interrupt" });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed command body, including a blank prompt (400)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    expect((await postCommand(server, sessionId, "this is not json")).status).toBe(400);
    expect((await postCommand(server, sessionId, { payload: { text: "no subtype" } })).status).toBe(400);
    expect((await postCommand(server, sessionId, { subtype: "" })).status).toBe(400);
    expect((await postCommand(server, sessionId, { subtype: "prompt", payload: "not-an-object" })).status).toBe(400);
    // A prompt with no / blank text is a 400 before any relay is attempted.
    expect((await postCommand(server, sessionId, { subtype: "prompt" })).status).toBe(400);
    expect((await postCommand(server, sessionId, { subtype: "prompt", payload: { text: "   " } })).status).toBe(400);
  });

  it("rejects a non-POST method on a session command path (405)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const res = await fetch(`${base(server)}${commandPath(sessionId)}`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("UI answer verb — POST /api/sessions/{id}/command { subtype: 'answer' } (#264, #78 Option A)", () => {
  it("relays a well-formed AnswerEnvelope as a control_request carrying the normalized envelope", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    const res = await postCommand(server, sessionId, { subtype: "answer", payload: { answers: { q0: ["Yes"] } } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    expect(payload).toEqual({ type: "control_request", id, subtype: "answer", payload: { answers: { q0: ["Yes"] } } });
  });

  it("normalizes the answer at the boundary — no control character rides down to the worker (#261 trust boundary)", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    // A BEL smuggled into a label: the boundary must strip it, so nothing hostile reaches the worker.
    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Ap\u0007prove"] } },
    });
    expect(res.status).toBe(202);

    await waitFor(() => frames().length === 1);
    const relayed = frames()[0].data.payload as { payload: { answers: Record<string, string[]> } };
    expect(relayed.payload.answers.q0[0]).not.toContain("\u0007");
  });

  it("rejects a malformed answer envelope BEFORE any relay (400), and never opens the worker frame", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);

    // A bare-string selection (not the uniform array `AnswerEnvelope` demands) fails the #261 shape guard.
    expect(
      (await postCommand(server, sessionId, { subtype: "answer", payload: { answers: { q0: "Yes" } } })).status,
    ).toBe(400);
    // An empty `answers` map answers nothing.
    expect((await postCommand(server, sessionId, { subtype: "answer", payload: { answers: {} } })).status).toBe(400);
    // A key outside the minted `q<index>` grammar core validates against.
    expect(
      (await postCommand(server, sessionId, { subtype: "answer", payload: { answers: { nope: ["x"] } } })).status,
    ).toBe(400);
    // No payload at all.
    expect((await postCommand(server, sessionId, { subtype: "answer" })).status).toBe(400);

    // A rejected answer is never relayed — nothing reached the worker.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
  });

  it("fails closed when the addressed session has no live worker channel, even for a valid answer (409)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    // Registered, but the worker never opened its downstream: a well-formed answer still cannot land.
    const res = await postCommand(server, sessionId, { subtype: "answer", payload: { answers: { q0: ["Yes"] } } });
    expect(res.status).toBe(409);
  });
});
