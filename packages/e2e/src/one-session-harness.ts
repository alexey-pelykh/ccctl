// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The one-session control-plane flow harness — the SSE stand-in (issue #131,
 * traces E2E-B-002).
 *
 * It drives the whole one-session round-trip the walking skeleton ships over the
 * current environments-bridge flow, conformed to the worker's OBSERVED wire (#130)
 * — register → session-create → work-poll → per-session **HTTP + SSE** worker
 * channel → phone view + steer — end-to-end against the REAL {@link CcctlServer},
 * hermetically (loopback only; a stand-in worker and a stand-in phone, no patched
 * Claude Code worker, no credentials, no egress):
 *
 *   1. **Environment register** (§1) — the bridge registers with the local server
 *      (`POST /v1/environments/bridge`, account Bearer); the response is asserted
 *      against the pinned `{ environment_id }` wire (NO work-poll token, #130) via
 *      {@link registerEnvironment}.
 *   2. **Session create** (§2) — a session is created (`POST /v1/sessions`, account
 *      Bearer); the response is asserted against the `{ session_id }` wire (NO
 *      `ws_url`, #130) via {@link createSession}. The server AUTO-ENQUEUES this
 *      session's `session` work item — no explicit enqueue by the harness.
 *   3. **Work poll** (§3) — the bridge polls `GET …/work/poll` carrying NO
 *      credential and receives the auto-enqueued SINGLE item, whose `secret` decodes
 *      to the per-session ingress token + control base, via {@link pollWork}.
 *   4. **Worker channel** (§4/§5) — a stand-in worker opens the channel: `POST
 *      …/worker/register` mints a `worker_epoch`, a held-open `GET
 *      …/worker/events/stream` is the server→worker downstream, and `PUT …/worker`
 *      reports `idle` ("ready for a turn"). The account Bearer does NOT ride this
 *      channel — the two-credential boundary (#130).
 *   5. **Phone view (SSE)** — a stand-in phone subscribes over Server-Sent Events
 *      (`GET /api/sessions/{id}/events`); the worker POSTs a transcript event UPSTREAM
 *      (`POST …/worker/events`) and the server relays its payload to the phone, which
 *      VIEWS it — grounded in the phone's OWN received record.
 *   6. **Phone steer** — the phone POSTs one steer (`POST /api/sessions/{id}/command`); a `prompt`
 *      steer is INJECTED as a `{ type: "user" }` turn pushed down the worker's
 *      held-open downstream as a `client_event`, where the worker READS it — grounded
 *      in the worker's OWN received frames — and acks it (`POST …/worker/events/delivery`).
 *
 * Every "reached X" verdict is RECEIVER-grounded — read from the endpoint that
 * actually took the traffic (the server's session/environment maps, the poll body
 * the bridge received, the phone's SSE log, the worker's inbound `client_event`
 * frames), never from a sender's self-report — the same posture `traffic-harness.ts`
 * holds for the inference legs. The flow it drives produces a control-leg
 * {@link ObservedConnection}: the fixture the inference-untouched assertion (#18,
 * `assertInferenceUntouched`) runs against. The later credentialed wave swaps the
 * stand-in worker + phone for a real patched worker + browser and a real egress to
 * api.anthropic.com; the assertion the fixture feeds does not change.
 *
 * The worker end is an SSE CLIENT of the downstream (`…/worker/events/stream`) and an
 * HTTP POSTer of the upstream legs (`…/worker/events`, `…/worker/events/delivery`,
 * `PUT …/worker`) — NOT a WebSocket peer (the current `--sdk-url` control path is
 * SSE, #130). The §4/§5 channel paths are pinned in `bridge-wire-conformance.ts` and
 * reused here, never re-derived from server internals.
 */

import { request, type IncomingMessage } from "node:http";
import { formatAuthority, type ControlEvent, type HostEndpoint, type JsonValue, type WorkerStatus } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import {
  assertWorkerRegister,
  createSession,
  pollWork,
  putWorkerStatus,
  registerEnvironment,
  workerChannelBase,
  type DecodedWorkSecret,
  type WorkItemWire,
} from "./bridge-wire-conformance.js";
import type { ObservedConnection } from "./inference-guarantee.js";
import type { InferenceStandIn } from "./traffic-harness.js";

/** The same-origin per-session SSE subscription path the phone reads (#13, session-addressed #20). */
function sessionEventsPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/events`;
}

/** The same-origin per-session steer-ingress path the phone POSTs to (#13, session-addressed #20). */
function sessionCommandPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/command`;
}

/** The downstream SSE event name every server→worker turn-injection frame carries (§4/§5). */
const CLIENT_EVENT_NAME = "client_event";

/** How long a receiver-grounded wait polls before it treats the flow as hung. */
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/** How long a harness HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The transcript event the worker emits upstream when a flow does not supply one —
 * a plain message `control_event`, the shape the SSE relay fans out to the phone and
 * the real UI decode classifies as a transcript line (#13).
 */
export const DEFAULT_TRANSCRIPT_EVENT: ControlEvent = {
  type: "control_event",
  subtype: "message",
  payload: { text: "hi from the worker" },
};

/** The steer the phone sends when a flow does not supply one — a "send input" prompt (#16). */
export const DEFAULT_STEER: UiSteerCommand = {
  subtype: "prompt",
  payload: { text: "continue please" },
};

/** One `client_event` frame the worker read off its held-open downstream (§4/§5 turn injection). */
export interface ReceivedClientEvent {
  /** The frame's `event_id` — the handle the worker acks over `…/worker/events/delivery`. */
  readonly eventId: string;
  /** The frame's monotonic `sequence_num`. */
  readonly sequenceNum: number;
  /** The demux payload (`payload.type` ∈ `user` | `control_request` | `control_response`). */
  readonly payload: JsonValue;
}

/**
 * A stand-in patched worker — the SSE CLIENT of the server→worker downstream plus the
 * HTTP POSTer of the upstream legs. It reads the `client_event` frames the server
 * pushes (so "the turn reached the worker" is grounded in its own receipt), emits
 * transcript events upstream, acks downstream deliveries, and reports status.
 */
export interface FakeWorker {
  /** The `worker_epoch` minted at register — carried on every epoch-gated upstream POST. */
  readonly epoch: number;
  /** The `client_event` frames this worker read off its downstream, in arrival order. */
  received(): readonly ReceivedClientEvent[];
  /** Emit one control event UPSTREAM (`POST …/worker/events`) for the server to relay to the phone. */
  emitEvent(event: ControlEvent): Promise<void>;
  /** Ack one downstream `client_event` delivery (`POST …/worker/events/delivery`). */
  acknowledge(eventId: string): Promise<void>;
  /** Report a worker status (`PUT …/worker`); the server derives the session's activity from it. */
  putStatus(status: WorkerStatus): Promise<void>;
  /** Close the held-open downstream, releasing the channel. */
  close(): Promise<void>;
}

/** Inputs to open the stand-in worker's channel. */
export interface FakeWorkerOptions {
  /** The real local ccctl server the worker channel points at. */
  readonly server: CcctlServer;
  /** The session id the §2 create minted (the channel is rooted under it). */
  readonly sessionId: string;
}

/**
 * Open the worker channel as a stand-in worker and resolve a {@link FakeWorker}:
 * register (mint the `worker_epoch`), then hold open the downstream SSE stream,
 * buffering every `client_event` frame. Rejects if the stream open is refused (a
 * non-200) so a broken connect cannot masquerade as an open channel. No account
 * Bearer rides the channel — the §4/§5 credential boundary (#130).
 */
export async function connectFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
  const { server, sessionId } = options;
  const base = workerChannelBase(sessionId);
  // §4 — register first; the events stream 409s until the worker has an epoch.
  const epoch = await assertWorkerRegister(server, sessionId);

  const received: ReceivedClientEvent[] = [];
  const stream = await openSseStream(server.address, `${base}/events/stream`, (event) => {
    // The downstream carries ONLY `client_event` turn-injection frames; a keep-alive
    // comment parses to null and never reaches here. Decode each frame's demux payload.
    if (event.event !== CLIENT_EVENT_NAME) {
      return;
    }
    const frame = parseClientEventData(event.data);
    if (frame !== null) {
      received.push(frame);
    }
  });

  return {
    epoch,
    received: (): readonly ReceivedClientEvent[] => received,
    emitEvent: (event: ControlEvent): Promise<void> =>
      postJsonExpect(
        server,
        `${base}/events`,
        { worker_epoch: epoch, events: [{ payload: event }] },
        200,
        "worker/events",
      ),
    acknowledge: (eventId: string): Promise<void> =>
      postJsonExpect(
        server,
        `${base}/events/delivery`,
        { worker_epoch: epoch, updates: [{ event_id: eventId, status: "delivered" }] },
        200,
        "worker/events/delivery",
      ),
    putStatus: async (status: WorkerStatus): Promise<void> => {
      const res = await putWorkerStatus(server, sessionId, epoch, status);
      if (res.status !== 200) {
        throw new Error(`ccctl e2e: PUT worker status ${status} expected 200, got ${res.status}`);
      }
    },
    close: (): Promise<void> => stream.close(),
  };
}

/** One SSE event line the phone received off the stream, with its `Last-Event-ID`. */
export interface ViewedSseEvent {
  /** The SSE `id:` field (the `Last-Event-ID` cursor), or `undefined` if absent. */
  readonly id: string | undefined;
  /** The SSE `data:` payload — one `JSON.stringify(payload)` the server relayed. */
  readonly data: string;
}

/** A UI steer command the phone POSTs — a verb (`subtype`) plus its optional payload. */
export interface UiSteerCommand {
  readonly subtype: string;
  readonly payload?: Record<string, unknown>;
}

/** The server's ack for a POSTed steer: the HTTP status and the server-minted request id. */
export interface UiSteerAck {
  readonly status: number;
  /** The correlation id the server minted (empty string when the POST was refused). */
  readonly id: string;
}

/**
 * A stand-in phone — the SSE subscriber that VIEWS the session and the `fetch`
 * POSTer that STEERS it. The two browser-facing legs (#15/#16) the walking
 * skeleton's UI drives, without a browser.
 */
export interface UiClient {
  /** The event lines this phone has viewed over SSE, in arrival order. */
  viewed(): readonly ViewedSseEvent[];
  /** POST one steer to `/api/command`; resolves with the server's ack. */
  steer(command: UiSteerCommand): Promise<UiSteerAck>;
  /** Close the SSE stream. */
  close(): Promise<void>;
}

/** Inputs to subscribe the stand-in phone. */
export interface UiClientOptions {
  /** The local server whose SSE relay + steer ingress the phone talks to. */
  readonly server: CcctlServer;
  /** The session the phone views + steers (the UI transport is per session, #20). */
  readonly sessionId: string;
}

/**
 * Subscribe the stand-in phone to the SESSION's SSE stream and resolve a
 * {@link UiClient}. Resolves once the response headers arrive — at which point the
 * server has synchronously registered the subscriber — so a subsequent worker emit is
 * delivered live rather than missed (a fresh SSE connection is not replayed the
 * backlog). The phone views + steers exactly the one session it is bound to (#20).
 */
export async function connectUiClient(options: UiClientOptions): Promise<UiClient> {
  const { server, sessionId } = options;
  const events: ViewedSseEvent[] = [];
  const stream = await openSseStream(server.address, sessionEventsPath(sessionId), (event) => {
    events.push({ id: event.id, data: event.data });
  });
  return {
    viewed: (): readonly ViewedSseEvent[] => events,
    steer: (command: UiSteerCommand): Promise<UiSteerAck> =>
      postSteer(server.address, sessionCommandPath(sessionId), command),
    close: (): Promise<void> => stream.close(),
  };
}

/** Inputs to drive the whole one-session flow. */
export interface OneSessionFlowOptions {
  /** The real local ccctl server the flow runs against. */
  readonly server: CcctlServer;
  /** The account Bearer presented on the §1/§2 control POSTs ONLY (never the §3/§4/§5 legs). */
  readonly bearer: string;
  /** The Anthropic stand-in, used to prove control-plane traffic never leaks to it. */
  readonly standIn: InferenceStandIn;
  /** The transcript event the worker emits upstream for the phone to view. Defaults to {@link DEFAULT_TRANSCRIPT_EVENT}. */
  readonly transcriptEvent?: ControlEvent;
  /** The steer the phone sends (a `prompt`, injected as a user turn). Defaults to {@link DEFAULT_STEER}. */
  readonly steer?: UiSteerCommand;
}

/** The receiver-grounded outcome of one full one-session flow. */
export interface OneSessionFlow {
  /** The server-assigned environment id from the §1 environment-register response. */
  readonly environmentId: string;
  /** The server-assigned session id from the §2 session-create response. */
  readonly sessionId: string;
  /** The SINGLE session-dispatch work item the bridge received over the §3 poll (#130). */
  readonly workItem: WorkItemWire;
  /** The decoded §3 work-secret (the per-session ingress token + control base). */
  readonly workSecret: DecodedWorkSecret;
  /**
   * The control-leg observation the whole flow grounds — the fixture the
   * inference-untouched assertion (#18) consumes: control traffic reached the
   * local server (and only it).
   */
  readonly control: ObservedConnection;
  /**
   * The `client_event` payload the worker read off its downstream when the phone
   * steered — the injected `{ type: "user" }` turn (grounded in the worker's own record).
   */
  readonly injectedTurn: JsonValue;
  /** The steer command the phone sent. */
  readonly steer: UiSteerCommand;
  /** The server-minted correlation id the steer was acked with. */
  readonly steerId: string;
  /** The control event the worker emitted upstream (equals the decoded {@link OneSessionFlow.viewed} data). */
  readonly transcriptEvent: ControlEvent;
  /** The SSE event the phone viewed (grounded in the phone's own record). */
  readonly viewed: ViewedSseEvent;
  /** The stand-in worker (open until {@link OneSessionFlow.close}). */
  readonly worker: FakeWorker;
  /** The stand-in phone (open until {@link OneSessionFlow.close}). */
  readonly ui: UiClient;
  /** Tear down the stand-in phone and worker (the server + stand-in are the caller's to close). */
  close(): Promise<void>;
}

/**
 * Drive the one-session flow end-to-end and return a receiver-grounded
 * {@link OneSessionFlow}. Every hop is grounded in the receiver's OWN record and
 * throws if a ground is not met — so a broken flow cannot masquerade as a pass — and
 * after every control-plane hop it asserts nothing leaked to the api.anthropic.com
 * stand-in. On any failure it closes whatever it already opened before rethrowing, so
 * a serial e2e run never leaks a socket. The supplied {@link OneSessionFlowOptions.steer}
 * must be a `prompt` (the turn-injection path this flow exercises).
 */
export async function driveOneSessionFlow(options: OneSessionFlowOptions): Promise<OneSessionFlow> {
  const { server, bearer, standIn } = options;
  const transcriptEvent = options.transcriptEvent ?? DEFAULT_TRANSCRIPT_EVENT;
  const steer = options.steer ?? DEFAULT_STEER;
  const authority = formatAuthority(server.address.host, server.address.port);

  let worker: FakeWorker | undefined;
  let ui: UiClient | undefined;
  try {
    // 1. Environment register (§1) — grounded in the server's own environments record.
    const { environmentId } = await registerEnvironment(server, bearer);
    if (!server.environments.has(environmentId)) {
      throw new Error("ccctl e2e: the local server did not record the registered environment");
    }
    assertNoAnthropicLeak(standIn, "environment registration");

    // 2. Session create (§2) — grounded in the server's own session record; the create
    //    AUTO-ENQUEUES the §3 work item (no explicit enqueue here).
    const { sessionId } = await createSession(server, bearer);
    if (server.sessions.size !== 1 || !server.sessions.has(sessionId)) {
      throw new Error("ccctl e2e: the local server did not record the created session");
    }
    assertNoAnthropicLeak(standIn, "session creation");

    // 3. Work poll (§3) — the bridge polls UNCREDENTIALED and receives the SINGLE
    //    session-dispatch item, whose secret decodes with both inner fields. Grounded
    //    in the poll body the bridge got back.
    const delivered = await pollWork(server, environmentId);
    if (delivered.item.data.type !== "session" || delivered.item.data.id !== sessionId) {
      throw new Error(`ccctl e2e: §3 poll did not deliver the session-dispatch item for ${sessionId}`);
    }
    assertNoAnthropicLeak(standIn, "work poll");

    // 4. Worker channel (§4/§5) — register, hold open the downstream, and report idle.
    //    The server derives the session's activity from the PUT status.
    const activeWorker = await connectFakeWorker({ server, sessionId });
    worker = activeWorker;
    await activeWorker.putStatus("idle");
    if (server.sessions.get(sessionId)?.activity.kind !== "idle") {
      throw new Error("ccctl e2e: the server did not derive `idle` activity from the worker status");
    }
    assertNoAnthropicLeak(standIn, "worker-channel register + status");

    // 5. Phone subscribes over SSE — BEFORE the worker emits, so the relayed event is
    //    delivered live (a fresh SSE connection is not replayed the backlog).
    const activeUi = await connectUiClient({ server, sessionId });
    ui = activeUi;

    // 6. Phone steer — POST a `prompt`; the server injects it as a `{ type: "user" }`
    //    turn down the worker's downstream, where the worker READS it (its own record).
    const ack = await activeUi.steer(steer);
    if (ack.status !== 202) {
      throw new Error(
        `ccctl e2e: the phone's steer expected 202 from ${sessionCommandPath(sessionId)}, got ${ack.status}`,
      );
    }
    await waitFor(() => activeWorker.received().length >= 1);
    const injected = activeWorker.received()[0];
    if (injected === undefined) {
      throw new Error("ccctl e2e: the worker did not receive the injected turn over its downstream");
    }
    // The relayed steer is the phone's `prompt` re-framed as a `{ type: "user" }` turn
    // carrying the steer text (the worker demuxes on payload.type, #130).
    const injectedText = userTurnText(injected.payload);
    const expectedText = typeof steer.payload?.text === "string" ? steer.payload.text : undefined;
    if (injectedText === null || injectedText !== expectedText) {
      throw new Error(
        `ccctl e2e: the worker read ${JSON.stringify(injected.payload)}, expected a { type: "user" } turn carrying ${JSON.stringify(expectedText)}`,
      );
    }
    // Ack the downstream delivery (§5) — exercising the delivery leg, grounded in its 200.
    await activeWorker.acknowledge(injected.eventId);
    assertNoAnthropicLeak(standIn, "turn injection");

    // 7. Worker emits a transcript event UPSTREAM; the server relays it and the phone
    //    VIEWS it (grounded in the phone's own SSE record).
    await activeWorker.emitEvent(transcriptEvent);
    await waitFor(() => activeUi.viewed().length >= 1);
    const viewed = activeUi.viewed()[0];
    if (viewed === undefined) {
      throw new Error("ccctl e2e: the phone did not view the worker's transcript event over SSE");
    }
    if (viewed.data !== JSON.stringify(transcriptEvent)) {
      throw new Error(`ccctl e2e: the phone viewed ${viewed.data}, expected ${JSON.stringify(transcriptEvent)}`);
    }
    assertNoAnthropicLeak(standIn, "SSE transcript view");

    return {
      environmentId,
      sessionId,
      workItem: delivered.item,
      workSecret: delivered.secret,
      control: { leg: "control", receivedBy: "local-server", intendedHost: authority },
      injectedTurn: injected.payload,
      steer,
      steerId: ack.id,
      transcriptEvent,
      viewed,
      worker: activeWorker,
      ui: activeUi,
      close: async (): Promise<void> => {
        await activeUi.close();
        await activeWorker.close();
      },
    };
  } catch (error) {
    if (ui !== undefined) {
      await ui.close();
    }
    if (worker !== undefined) {
      await worker.close();
    }
    throw error;
  }
}

// --- SSE + client_event parsing (pure) ---

/** One parsed SSE block: its optional `event:` name, optional `id:` cursor, and joined `data:`. */
export interface ParsedSseEvent {
  /** The SSE `event:` field, or `undefined` for the default (unnamed) event. */
  readonly event: string | undefined;
  /** The SSE `id:` field (the `Last-Event-ID` cursor), or `undefined` if absent. */
  readonly id: string | undefined;
  /** The joined `data:` payload. */
  readonly data: string;
}

/**
 * Parse one SSE block — the text between `\n\n` boundaries — into a
 * {@link ParsedSseEvent}, or `null` for a comment-only block (the stream opener /
 * keep-alive). Reads the `event:` name and `id:` cursor and joins `data:` lines,
 * matching how an `EventSource` reassembles a multi-line `data` field.
 */
export function parseSseBlock(block: string): ParsedSseEvent | null {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue; // an SSE comment (the stream opener / keep-alive), never an event.
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : { event, id, data: dataLines.join("\n") };
}

/**
 * Decode a downstream `client_event` frame's `data` — the demux envelope
 * `{ sequence_num, event_id, event_type, payload }` — into a {@link ReceivedClientEvent},
 * or `null` when it is malformed (bad JSON, missing `event_id` / `sequence_num`, or no
 * `payload`). Fail-closed over arbitrary bytes, so a broken frame is dropped rather than
 * surfaced as a phantom turn. Pure and unit-testable without a live channel.
 */
export function parseClientEventData(data: string): ReceivedClientEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const eventId = record.event_id;
  const sequenceNum = record.sequence_num;
  if (typeof eventId !== "string" || eventId === "" || typeof sequenceNum !== "number") {
    return null;
  }
  if (!("payload" in record)) {
    return null;
  }
  return { eventId, sequenceNum, payload: record.payload as JsonValue };
}

/**
 * Extract the prompt text from an injected `{ type: "user" }` turn payload
 * (`{ type: "user", message: { role: "user", content: [{ type: "text", text }] }, … }`),
 * or `null` when it is not a well-formed user turn. The receiver-grounded read the flow
 * uses to confirm the phone's `prompt` steer landed as the worker's turn.
 */
function userTurnText(payload: JsonValue): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "user") {
    return null;
  }
  const message = record.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return null;
  }
  const text = (first as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

// --- transport internals ---

/** A held-open SSE reader over a `node:http` GET. */
interface SseStream {
  /** Close the underlying response, releasing the connection. */
  close(): Promise<void>;
}

/**
 * Open a held-open SSE stream (`GET path`) and invoke `onEvent` for every complete
 * `\n\n`-delimited block (comment-only blocks parse to `null` and are skipped). Uses
 * `node:http` so the stream stays open under the harness's control. Rejects if the
 * server answers a non-200 (e.g. a `409` for an unregistered worker), so a refused
 * open never masquerades as a live stream. Idempotent buffering reassembles a block
 * split across two socket reads.
 */
function openSseStream(
  address: HostEndpoint,
  path: string,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<SseStream> {
  return new Promise<SseStream>((resolve, reject) => {
    const req = request(
      { host: address.host, port: address.port, path, method: "GET", headers: { Accept: "text/event-stream" } },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain the error body so the socket does not stall.
          reject(new Error(`ccctl e2e: SSE stream ${path} refused with HTTP ${res.statusCode ?? 0}`));
          return;
        }
        res.setEncoding("utf8");
        res.on("error", () => {}); // swallow a reset when the server ends the stream on shutdown.
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const parsed = parseSseBlock(buffer.slice(0, boundary));
            if (parsed !== null) {
              onEvent(parsed);
            }
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        });
        resolve({
          close: (): Promise<void> => {
            res.destroy();
            return Promise.resolve();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** POST a JSON body to a worker-channel leg and assert the expected status (fail closed). */
async function postJsonExpect(
  server: CcctlServer,
  path: string,
  body: unknown,
  expectedStatus: number,
  leg: string,
): Promise<void> {
  const res = await fetch(serverUrl(server.address, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== expectedStatus) {
    throw new Error(`ccctl e2e: ${leg} expected ${expectedStatus}, got ${res.status}`);
  }
}

/** POST one steer to a session's `…/command` and read the server's `{ id }` ack (best-effort on a refusal). */
async function postSteer(address: HostEndpoint, path: string, command: UiSteerCommand): Promise<UiSteerAck> {
  const res = await fetch(serverUrl(address, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await res.json();
  const id =
    typeof body === "object" && body !== null && typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : "";
  return { status: res.status, id };
}

/** The `http://host:port{path}` URL for a request against a running server. */
function serverUrl(address: HostEndpoint, path: string): string {
  return `http://${formatAuthority(address.host, address.port)}${path}`;
}

/** Fail closed if any control-plane hop leaked to the api.anthropic.com stand-in. */
function assertNoAnthropicLeak(standIn: InferenceStandIn, stage: string): void {
  if (standIn.received.length !== 0) {
    throw new Error(`ccctl e2e: ${stage} traffic leaked to the api.anthropic.com stand-in`);
  }
}

/**
 * Poll `predicate` until it holds or `timeoutMs` lapses — the receiver-grounded wait
 * the flow uses to observe an asynchronous hop landing (the worker reading a turn, the
 * phone viewing an event).
 */
export async function waitFor(predicate: () => boolean, timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ccctl e2e: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
