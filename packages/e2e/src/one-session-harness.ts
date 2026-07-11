// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Skeleton harness for the one-session control-plane flow (issue #19, traces
 * E2E-B-002).
 *
 * It drives the whole one-session round-trip the walking skeleton ships over the
 * CURRENT environments-bridge flow (#124) — register → session-create → work-poll →
 * per-session channel → phone view + steer — end-to-end against the REAL
 * {@link CcctlServer}, hermetically (loopback only; a stand-in worker and a
 * stand-in phone, no patched Claude Code worker, no credentials, no egress):
 *
 *   1. **Environment register** (§1) — the bridge registers with the local server
 *      (`POST /v1/environments/bridge`); the response yields the scoped
 *      per-environment work-poll token, asserted against the pinned
 *      `{environment_id, work_poll_token}` wire via {@link registerEnvironment}.
 *   2. **Session create** (§2) — a session is created (`POST /v1/sessions`); the
 *      response is asserted against the snake_case `{session_id, ws_url}` wire
 *      PINNED by ADR-001, via {@link createSession}.
 *   3. **Work poll** (§3) — the bridge long-polls `GET …/work/poll` with its SCOPED
 *      token (never the account Bearer) and receives the session-dispatch work item,
 *      then acks it — grounded in the poll body it RECEIVED and the server dropping
 *      the in-flight item. The server-side ingress that a create triggers in the full
 *      build (the §2→§3 enqueue wiring) is a later item, so the harness drives the
 *      enqueue explicitly — as it stands in for the worker/phone.
 *   4. **Worker channel** (§4) — a stand-in worker opens the worker-channel WebSocket
 *      at the minted `ws_url` (#11); the session moves `connecting → ready`.
 *   5. **Phone view (SSE)** — a stand-in phone subscribes over Server-Sent Events
 *      (`GET /api/events`, #13/#15); the worker emits a `control_event` and the
 *      phone VIEWS it — grounded in the phone's OWN received record.
 *   6. **Phone steer** — the phone POSTs one steer (`POST /api/command`, #13/#16);
 *      the server re-frames it as a `control_request` and relays it over the
 *      worker channel (#12), where the worker RECEIVES it — grounded in the
 *      worker's OWN received frames.
 *
 * Every "reached X" verdict is RECEIVER-grounded — read from the endpoint that
 * actually took the traffic (the server's session map, the phone's SSE log, the
 * worker's inbound frames), never from a sender's self-report — the same posture
 * `traffic-harness.ts` holds for the inference legs. The flow it drives produces
 * a control-leg {@link ObservedConnection}: the fixture the inference-untouched
 * assertion (#18, `assertInferenceUntouched`) runs against. The later credentialed
 * wave swaps the stand-in worker + phone for a real patched worker + browser and a
 * real egress to api.anthropic.com; the assertion the fixture feeds does not change.
 *
 * The worker end is a WebSocket CLIENT, so the framing here is the MIRROR of the
 * server codec (`@ccctl/server`'s `websocket.ts`): it MASKS its own client→server
 * frames (RFC 6455 §5.1) and reads the server's UNMASKED frames. The NDJSON
 * control-frame codec itself is reused from `@ccctl/core`, never re-implemented.
 */

import { randomBytes } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  ControlFrameDecoder,
  encodeControlFrame,
  formatAuthority,
  type ControlEvent,
  type ControlRequest,
  type HostEndpoint,
  type WorkItem,
} from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import { createSession, registerEnvironment, roundTripWork } from "./bridge-wire-conformance.js";
import type { ObservedConnection } from "./inference-guarantee.js";
import type { InferenceStandIn } from "./traffic-harness.js";

/** The same-origin SSE subscription path (mirrors the server's `EVENTS_PATH`, #13). */
const EVENTS_PATH = "/api/events";

/** The same-origin steer-ingress path the phone POSTs to (mirrors the server's `COMMAND_PATH`, #13). */
const COMMAND_PATH = "/api/command";

/** RFC 6455 §5.2 text-frame opcode — the only data opcode the worker channel carries. */
const WS_TEXT_OPCODE = 0x1;

/** How long a receiver-grounded wait polls before it treats the flow as hung. */
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/**
 * The transcript event the worker emits when a flow does not supply one — a plain
 * message `control_event`, the shape the SSE relay fans out to the phone (#13).
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

/**
 * A stand-in patched worker — the WebSocket CLIENT end of the worker channel. It
 * can emit control events server-ward and records the steer requests the server
 * relays back, so "the steer reached the worker" is grounded in its own receipt.
 */
export interface FakeWorker {
  /** Emit one control event worker→server over the channel (a masked text frame). */
  emitEvent(event: ControlEvent): void;
  /** The steer `control_request`s the server relayed to this worker, in arrival order. */
  receivedSteers(): readonly ControlRequest[];
  /** Close the client socket, releasing the channel. */
  close(): Promise<void>;
}

/** Inputs to open the stand-in worker's channel. */
export interface FakeWorkerOptions {
  /** The `ws_url` the §2 session-create response minted (the worker dials exactly this). */
  readonly wsUrl: string;
  /** The account Bearer, presented again on the WS connect (bridge-protocol §4). */
  readonly bearer: string;
}

/**
 * Open the worker channel as a stand-in worker and resolve a {@link FakeWorker}.
 * Uses `node:http` (not the WHATWG `WebSocket`) so the `Authorization` header can
 * be set on the upgrade — the native client cannot. Rejects if the server fails
 * the upgrade closed (a non-101 response) so a broken connect cannot masquerade as
 * an open channel.
 */
export function connectFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
  const url = new URL(options.wsUrl);
  return new Promise<FakeWorker>((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Authorization: `Bearer ${options.bearer}`,
      },
    });
    req.on("upgrade", (_res: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Accumulate every inbound byte; `receivedSteers` decodes the whole buffer
      // fresh on each call, so it is idempotent under polling and a frame split
      // across two socket reads is reassembled on a later call.
      let inbound = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        inbound = Buffer.concat([inbound, chunk]);
      });
      // A reset during teardown (the server destroying its side first) must not
      // surface as an unhandled socket error.
      socket.on("error", () => {});
      resolve({
        emitEvent: (event: ControlEvent): void => {
          socket.write(maskWsTextFrame(encodeControlFrame(event)));
        },
        receivedSteers: (): readonly ControlRequest[] => decodeRelayedRequests(inbound),
        close: (): Promise<void> => {
          socket.destroy();
          return Promise.resolve();
        },
      });
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`ccctl e2e: worker channel upgrade refused with HTTP ${res.statusCode ?? 0}`));
    });
    req.on("error", reject);
    req.end();
  });
}

/** One control-event line the phone received off the SSE stream, with its `Last-Event-ID`. */
export interface ViewedSseEvent {
  /** The SSE `id:` field (the `Last-Event-ID` cursor), or `undefined` if absent. */
  readonly id: string | undefined;
  /** The SSE `data:` payload — one `JSON.stringify(ControlEvent)` from the server. */
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
  /** The `control_request` id the server minted (empty string when the POST was refused). */
  readonly id: string;
}

/**
 * A stand-in phone — the SSE subscriber that VIEWS the session and the `fetch`
 * POSTer that STEERS it. The two browser-facing legs (#15/#16) the walking
 * skeleton's UI drives, without a browser.
 */
export interface UiClient {
  /** The control-event lines this phone has viewed over SSE, in arrival order. */
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
}

/**
 * Subscribe the stand-in phone to the SSE stream and resolve a {@link UiClient}.
 * Resolves once the response headers arrive — at which point the server has
 * synchronously registered the subscriber — so a subsequent worker emit is
 * delivered live rather than missed (a fresh SSE connection is not replayed the
 * backlog).
 */
export function connectUiClient(options: UiClientOptions): Promise<UiClient> {
  const { host, port } = options.server.address;
  const events: ViewedSseEvent[] = [];
  return new Promise<UiClient>((resolve, reject) => {
    const req = request(
      { host, port, path: EVENTS_PATH, method: "GET", headers: { Accept: "text/event-stream" } },
      (res: IncomingMessage) => {
        res.setEncoding("utf8");
        res.on("error", () => {}); // swallow a reset when the server ends the stream on shutdown.
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
        resolve({
          viewed: (): readonly ViewedSseEvent[] => events,
          steer: (command: UiSteerCommand): Promise<UiSteerAck> => postSteer(options.server.address, command),
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

/** Inputs to drive the whole one-session flow. */
export interface OneSessionFlowOptions {
  /** The real local ccctl server the flow runs against. */
  readonly server: CcctlServer;
  /** The account Bearer presented on the §1/§2 control POSTs AND the §4 worker-channel connect. */
  readonly bearer: string;
  /** The Anthropic stand-in, used to prove control-plane traffic never leaks to it. */
  readonly standIn: InferenceStandIn;
  /** The transcript event the worker emits for the phone to view. Defaults to {@link DEFAULT_TRANSCRIPT_EVENT}. */
  readonly transcriptEvent?: ControlEvent;
  /** The steer the phone sends over the worker channel. Defaults to {@link DEFAULT_STEER}. */
  readonly steer?: UiSteerCommand;
}

/** The receiver-grounded outcome of one full one-session flow. */
export interface OneSessionFlow {
  /** The server-assigned environment id from the §1 environment-register response. */
  readonly environmentId: string;
  /** The session-dispatch work item the bridge received over the §3 work poll (and acked). */
  readonly workItem: WorkItem;
  /** The server-assigned session id from the §2 session-create response. */
  readonly sessionId: string;
  /** The worker-channel URL the §2 session-create response minted. */
  readonly wsUrl: string;
  /**
   * The control-leg observation the whole flow grounds — the fixture the
   * inference-untouched assertion (#18) consumes: control traffic reached the
   * local server (and only it).
   */
  readonly control: ObservedConnection;
  /** The SSE event the phone viewed (grounded in the phone's own record). */
  readonly viewed: ViewedSseEvent;
  /** The control event the worker emitted (equals the decoded {@link OneSessionFlow.viewed} data). */
  readonly transcriptEvent: ControlEvent;
  /** The steer `control_request` the worker received over its channel (grounded in the worker's own record). */
  readonly relayedSteer: ControlRequest;
  /** The steer command the phone sent. */
  readonly steer: UiSteerCommand;
  /** The server-minted correlation id the steer was acked with. */
  readonly steerId: string;
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
 * throws if a ground is not met — so a broken flow cannot masquerade as a pass —
 * and after every control-plane hop it asserts nothing leaked to the
 * api.anthropic.com stand-in. On any failure it closes whatever it already opened
 * before rethrowing, so a serial e2e run never leaks a socket.
 */
export async function driveOneSessionFlow(options: OneSessionFlowOptions): Promise<OneSessionFlow> {
  const { server, bearer, standIn } = options;
  const transcriptEvent = options.transcriptEvent ?? DEFAULT_TRANSCRIPT_EVENT;
  const steer = options.steer ?? DEFAULT_STEER;
  const authority = formatAuthority(server.address.host, server.address.port);

  let workerHandle: FakeWorker | undefined;
  let uiHandle: UiClient | undefined;
  try {
    // 1. Environment register (§1) — the bridge registers itself; grounded in the
    //    server's own environments record, and yields the scoped §3 work-poll token.
    const { environmentId, workPollToken } = await registerEnvironment(server, bearer);
    if (!server.environments.has(environmentId)) {
      throw new Error("ccctl e2e: the local server did not record the registered environment");
    }
    assertNoAnthropicLeak(standIn, "environment registration");

    // 2. Session create (§2) — a session is created; grounded in the server's own
    //    session record, and the response IS the pinned { session_id, ws_url } wire.
    const { sessionId, wsUrl } = await createSession(server, bearer);
    if (server.sessions.size !== 1 || !server.sessions.has(sessionId)) {
      throw new Error("ccctl e2e: the local server did not record the created session");
    }
    assertNoAnthropicLeak(standIn, "session creation");

    // 3. Work poll (§3) — the bridge polls with its SCOPED token and receives the
    //    session-dispatch work item, then acks it. The server-side ingress a create
    //    triggers in the full build (the §2→§3 enqueue wiring) is a later item, so the
    //    harness drives the enqueue explicitly — as it stands in for the worker/phone.
    const dispatch: WorkItem = {
      kind: "create_session",
      id: "e2e-create-session",
      payload: { session_id: sessionId },
    };
    const workItem = await roundTripWork(server, environmentId, workPollToken, dispatch);
    assertNoAnthropicLeak(standIn, "work poll");

    // 4. Worker channel (§4) — the stand-in worker opens the WS at ws_url; ready confirms it.
    const worker = await connectFakeWorker({ wsUrl, bearer });
    workerHandle = worker;
    await waitFor(() => server.sessions.get(sessionId)?.status === "ready");
    assertNoAnthropicLeak(standIn, "worker-channel connect");

    // 5. Phone view — subscribe over SSE, then the worker emits a transcript event
    //    and the phone views it (grounded in the phone's own SSE record).
    const ui = await connectUiClient({ server });
    uiHandle = ui;
    worker.emitEvent(transcriptEvent);
    await waitFor(() => ui.viewed().length >= 1);
    const viewed = ui.viewed()[0];
    if (viewed === undefined) {
      throw new Error("ccctl e2e: the phone did not view the worker's transcript event over SSE");
    }
    if (viewed.data !== JSON.stringify(transcriptEvent)) {
      throw new Error(`ccctl e2e: the phone viewed ${viewed.data}, expected ${JSON.stringify(transcriptEvent)}`);
    }
    assertNoAnthropicLeak(standIn, "SSE transcript view");

    // 6. Phone steer — POST one steer; the server relays it worker-ward and the
    //    worker receives it (grounded in the worker's own inbound frames).
    const ack = await ui.steer(steer);
    if (ack.status !== 202) {
      throw new Error(`ccctl e2e: the phone's steer expected 202 from ${COMMAND_PATH}, got ${ack.status}`);
    }
    await waitFor(() => worker.receivedSteers().length >= 1);
    const relayedSteer = worker.receivedSteers()[0];
    if (relayedSteer === undefined) {
      throw new Error("ccctl e2e: the worker did not receive the steer over its channel");
    }
    // The relayed steer is the phone's verb re-framed as a control_request carrying
    // the SERVER-minted id (the browser never chooses the correlation id, #12/#13).
    const expectedSteer: ControlRequest =
      steer.payload === undefined
        ? { type: "control_request", id: ack.id, subtype: steer.subtype }
        : { type: "control_request", id: ack.id, subtype: steer.subtype, payload: steer.payload };
    if (JSON.stringify(relayedSteer) !== JSON.stringify(expectedSteer)) {
      throw new Error(
        `ccctl e2e: the worker received ${JSON.stringify(relayedSteer)}, expected ${JSON.stringify(expectedSteer)}`,
      );
    }
    assertNoAnthropicLeak(standIn, "worker-channel steer");

    return {
      environmentId,
      workItem,
      sessionId,
      wsUrl,
      control: { leg: "control", receivedBy: "local-server", intendedHost: authority },
      viewed,
      transcriptEvent,
      relayedSteer,
      steer,
      steerId: ack.id,
      worker,
      ui,
      close: async (): Promise<void> => {
        await ui.close();
        await worker.close();
      },
    };
  } catch (error) {
    if (uiHandle !== undefined) {
      await uiHandle.close();
    }
    if (workerHandle !== undefined) {
      await workerHandle.close();
    }
    throw error;
  }
}

/** POST one steer to `/api/command` and read the server's `{ id }` ack (best-effort on a refusal). */
async function postSteer(address: HostEndpoint, command: UiSteerCommand): Promise<UiSteerAck> {
  const res = await fetch(`http://${formatAuthority(address.host, address.port)}${COMMAND_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body: unknown = await res.json();
  const id =
    typeof body === "object" && body !== null && typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : "";
  return { status: res.status, id };
}

/** Fail closed if any control-plane hop leaked to the api.anthropic.com stand-in. */
function assertNoAnthropicLeak(standIn: InferenceStandIn, stage: string): void {
  if (standIn.received.length !== 0) {
    throw new Error(`ccctl e2e: ${stage} traffic leaked to the api.anthropic.com stand-in`);
  }
}

/**
 * Decode the server→client (UNMASKED) text frames buffered in `inbound` into the
 * `control_request`s they carry. Reuses `@ccctl/core`'s streaming
 * {@link ControlFrameDecoder} (the same codec the server encodes with), filtering
 * to `control_request` — the only frame the steer relay writes worker-ward (#12).
 * Pure over the buffer and idempotent, so it is safe to call repeatedly while
 * polling.
 */
function decodeRelayedRequests(inbound: Buffer): ControlRequest[] {
  const decoder = new ControlFrameDecoder();
  const requests: ControlRequest[] = [];
  for (const text of readServerTextFrames(inbound)) {
    for (const result of decoder.push(text)) {
      if (result.ok && result.frame.type === "control_request") {
        requests.push(result.frame);
      }
    }
  }
  return requests;
}

/**
 * Decode the UNMASKED server→client WebSocket text frames complete in `buffer`
 * (RFC 6455 §5.1: server frames are never masked), returning each one's UTF-8
 * payload. Handles all three §5.2 length forms; a partial trailing frame is left
 * undecoded for a later call. Hand-rolled, independent of the server codec it
 * mirrors — a re-implementation here would defeat the point of grounding the read
 * in the client's own decode. Throws on a masked server frame (a protocol
 * violation).
 */
export function readServerTextFrames(buffer: Buffer): string[] {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer.readUInt8(offset);
    const b1 = buffer.readUInt8(offset + 1);
    const opcode = b0 & 0x0f;
    if ((b1 & 0x80) !== 0) {
      throw new Error("ccctl e2e: server→client WebSocket frame is masked (RFC 6455 §5.1 forbids it)");
    }
    let length = b1 & 0x7f;
    let dataOffset = offset + 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      dataOffset = offset + 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset + 2));
      dataOffset = offset + 10;
    }
    if (dataOffset + length > buffer.length) {
      break; // full payload not yet buffered.
    }
    if (opcode === WS_TEXT_OPCODE) {
      texts.push(buffer.subarray(dataOffset, dataOffset + length).toString("utf8"));
    }
    offset = dataOffset + length;
  }
  return texts;
}

/**
 * Encode `text` as one masked (client→server, RFC 6455 §5.1 requires client frames
 * to be masked) WebSocket text frame with FIN set. The MIRROR of the server codec's
 * unmasked `encodeWsFrame`: byte ops go through `readUInt8`/`writeUInt8` (never a
 * `noUncheckedIndexedAccess` index) exactly as the server's `unmask` does. Handles
 * the 7-bit and 16-bit length forms — a steer/transcript line easily exceeds the
 * 126-byte 7-bit form.
 */
export function maskWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const b0 = 0x80 | WS_TEXT_OPCODE; // FIN + text opcode.
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([b0, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header.writeUInt8(b0, 0);
    header.writeUInt8(0x80 | 126, 1); // mask bit set; a 16-bit extended length follows.
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(b0, 0);
    header.writeUInt8(0x80 | 127, 1); // mask bit set; a 64-bit extended length follows.
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index++) {
    masked.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * Parse one SSE block — the text between `\n\n` boundaries — into a
 * {@link ViewedSseEvent}, or `null` for a comment-only block (the stream opener /
 * keep-alive). Reads the `id:` cursor and joins `data:` lines, matching how an
 * `EventSource` reassembles a multi-line `data` field.
 */
export function parseSseBlock(block: string): ViewedSseEvent | null {
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue; // an SSE comment (the stream opener / keep-alive), never an event.
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
 * Poll `predicate` until it holds or `timeoutMs` lapses — the receiver-grounded
 * wait the flow uses to observe an asynchronous hop landing (the session going
 * `ready`, the phone viewing an event, the worker receiving a steer).
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
