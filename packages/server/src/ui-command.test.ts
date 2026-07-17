// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { SESSIONS_PATH, workerEventsPath, workerEventsStreamPath, workerRegisterPath } from "@ccctl/core";
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

/** §4 — register the worker so a downstream can attach; returns the minted worker_epoch (for §5 posts). */
async function registerWorker(server: CcctlServer, sessionId: string): Promise<number> {
  const res = await fetch(`${base(server)}${workerRegisterPath(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { worker_epoch: number }).worker_epoch;
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
async function readyWorker(
  server: CcctlServer,
): Promise<{ sessionId: string; epoch: number; frames: () => ClientEventFrame[] }> {
  const sessionId = await registerSession(server);
  const epoch = await registerWorker(server, sessionId);
  const frames = await openWorkerStream(server, sessionId);
  return { sessionId, epoch, frames };
}

/** A §5 `worker_status` frame carrying its #201 `sequence_num`. */
function statusFrame(status: string, sequenceNum: number): unknown {
  return { type: "control_event", subtype: "worker_status", payload: { status, sequence_num: sequenceNum } };
}

/** A §5 `input_request` frame (#261) decorating a `requires_action` block, correlated by `sequence_num`. */
function inputRequestFrame(sequenceNum: number, questions: unknown[]): unknown {
  return { type: "control_event", subtype: "input_request", payload: { sequence_num: sequenceNum, questions } };
}

/** POST a §5 upstream `worker/events` batch (the leg that buffers an enrichment + folds status). */
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

/**
 * Buffer an `AskUserQuestion` enrichment at `sequenceNum` — the outstanding decision an `answer` is
 * validated against (#86). One §5 batch: the `requires_action` block plus its decorating `input_request`,
 * correlated by `sequence_num` (mirrors the #264 transport buffering).
 */
async function bufferEnrichment(
  server: CcctlServer,
  sessionId: string,
  epoch: number,
  sequenceNum: number,
  questions: unknown[],
): Promise<void> {
  const res = await postWorkerEvents(server, sessionId, epoch, [
    statusFrame("requires_action", sequenceNum),
    inputRequestFrame(sequenceNum, questions),
  ]);
  expect(res.status).toBe(200);
  expect(server.hasBufferedEnrichment(sessionId)).toBe(true);
}

/** One well-formed enrichment question, off ADR-005's observed AskUserQuestion shape (single-select Yes/No). */
const APPROVE_QUESTION = {
  question: "Approve the edit to foo.ts?",
  header: "File edit",
  options: [{ label: "Yes", description: "apply it" }, { label: "No" }],
  multiSelect: false,
};

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

describe("UI answer verb — stateful gate against the buffered decision (#264 transport, #86 freshness)", () => {
  it("relays a well-formed answer to the OUTSTANDING decision as a normalized control_request (202), stripping the decision-id", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 5 },
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    await waitFor(() => frames().length === 1);
    const payload = frames()[0].data.payload as Record<string, unknown>;
    // The relayed payload carries the envelope ONLY — the `sequence_num` decision-id is a server-side
    // freshness token, never forwarded to the worker (which resolves its OWN AskUserQuestion).
    expect(payload).toEqual({ type: "control_request", id, subtype: "answer", payload: { answers: { q0: ["Yes"] } } });
  });

  it("round-trips ALL chosen labels of a multi-select decision (AC: multi-select)", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 2, [
      {
        question: "Which checks?",
        options: [{ label: "lint" }, { label: "test" }, { label: "build" }],
        multiSelect: true,
      },
    ]);

    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["lint", "build"] }, sequence_num: 2 },
    });
    expect(res.status).toBe(202);
    await waitFor(() => frames().length === 1);
    const relayed = frames()[0].data.payload as { payload: { answers: Record<string, string[]> } };
    expect(relayed.payload.answers.q0).toEqual(["lint", "build"]);
  });

  it("is SINGLE-USE — the decision is consumed on the accepted answer, so a replay is refused (409)", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    const answer = { subtype: "answer", payload: { answers: { q0: ["Yes"] }, sequence_num: 5 } };
    expect((await postCommand(server, sessionId, answer)).status).toBe(202);
    expect(server.hasBufferedEnrichment(sessionId)).toBe(false); // consumed
    // A duplicate tap of the same rendered decision now finds nothing outstanding.
    expect((await postCommand(server, sessionId, answer)).status).toBe(409);

    // Only the FIRST answer reached the worker.
    await waitFor(() => frames().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(1);
  });

  it("REFUSES a stale-turn tap — a sequence_num that no longer matches the outstanding block (409, #86 anti-phantom)", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    // The phone rendered turn-5's options but the answer is tagged turn-4 — a superseded decision.
    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 4 },
    });
    expect(res.status).toBe(409);
    expect(server.hasBufferedEnrichment(sessionId)).toBe(true); // a stale answer does NOT consume the decision
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
  });

  it("REFUSES an answer that carries NO decision-id (absent sequence_num → 409), never relaying it", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    const res = await postCommand(server, sessionId, { subtype: "answer", payload: { answers: { q0: ["Yes"] } } });
    expect(res.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
  });

  it("REFUSES a label the worker never offered — a fresh answer is still not free-form (409 unoffered-label)", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["rm -rf /"] }, sequence_num: 5 },
    });
    expect(res.status).toBe(409);
    expect(server.hasBufferedEnrichment(sessionId)).toBe(true); // not consumed
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
  });

  it("REFUSES any answer when the session has NO outstanding AskUserQuestion (409) — the approve/deny path stays separate", async () => {
    const server = await startTestServer();
    const { sessionId, frames } = await readyWorker(server);
    // No enrichment buffered: the session is not blocking on a decorated decision. A plain approval would
    // ride the `approve` / `interrupt` verbs (the base AC's own path), untouched by this gate.
    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 5 },
    });
    expect(res.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
  });

  it("normalizes the answer at the boundary — a smuggled control character is neutralized before it reaches the worker (#261 trust boundary)", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    // The outstanding decision offers "Ap prove" (a space in the label). `displayableDetail` turns any
    // control character into a space, so a phone that smuggles a BEL where the space is normalizes to the
    // SAME offered label — it matches, and the relayed answer is clean. (A control char that normalized to
    // a NON-offered label would instead be refused by the bounded-selection gate — either way, nothing
    // hostile reaches the worker.)
    await bufferEnrichment(server, sessionId, epoch, 8, [
      { question: "Proceed?", options: [{ label: "Ap prove" }, { label: "Reject" }], multiSelect: false },
    ]);

    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Ap\u0007prove"] }, sequence_num: 8 },
    });
    expect(res.status).toBe(202);

    await waitFor(() => frames().length === 1);
    const relayed = frames()[0].data.payload as { payload: { answers: Record<string, string[]> } };
    expect(relayed.payload.answers.q0[0]).toBe("Ap prove");
    expect(relayed.payload.answers.q0[0]).not.toContain("\u0007");
  });

  it("rejects a malformed answer envelope BEFORE the stateful gate (400 shape), never relaying or consuming", async () => {
    const server = await startTestServer();
    const { sessionId, epoch, frames } = await readyWorker(server);
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    // A bare-string selection (not the uniform array `AnswerEnvelope` demands) fails the #261 shape guard.
    expect(
      (
        await postCommand(server, sessionId, {
          subtype: "answer",
          payload: { answers: { q0: "Yes" }, sequence_num: 5 },
        })
      ).status,
    ).toBe(400);
    // An empty `answers` map answers nothing.
    expect(
      (await postCommand(server, sessionId, { subtype: "answer", payload: { answers: {}, sequence_num: 5 } })).status,
    ).toBe(400);
    // A key outside the minted `q<index>` grammar core validates against.
    expect(
      (
        await postCommand(server, sessionId, {
          subtype: "answer",
          payload: { answers: { nope: ["x"] }, sequence_num: 5 },
        })
      ).status,
    ).toBe(400);
    // No payload at all.
    expect((await postCommand(server, sessionId, { subtype: "answer" })).status).toBe(400);

    // A shape-rejected answer is never relayed, and 400 does not consume the outstanding decision.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames()).toHaveLength(0);
    expect(server.hasBufferedEnrichment(sessionId)).toBe(true);
  });

  it("fails closed when the addressed session has no live worker channel, even for an otherwise-valid answer (409)", async () => {
    const server = await startTestServer();
    const sessionId = await registerSession(server);
    const epoch = await registerWorker(server, sessionId);
    // Buffer a decision but NEVER open the downstream: the answer passes the gate, then cannot land.
    await bufferEnrichment(server, sessionId, epoch, 5, [APPROVE_QUESTION]);

    const res = await postCommand(server, sessionId, {
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 5 },
    });
    expect(res.status).toBe(409);
    // The relay failed, so the decision is NOT consumed — it stays outstanding for a retry.
    expect(server.hasBufferedEnrichment(sessionId)).toBe(true);
  });
});
