// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/core` — the hub.
 *
 * Shared domain model for ccctl: the session/state model and the Claude Code
 * `stream-json` control-channel types. Every other package (`server`, `cli`,
 * `tunnel-adapters`) depends on this one; the wire contract and the session
 * model live here so there is a single source of truth.
 *
 * The `stream-json` control-channel codec below (frame types, encode, decode,
 * and the streaming {@link ControlFrameDecoder}) is implemented and tested; the
 * network primitives and session model further down are still skeletons whose
 * shapes capture the intended contract, not yet a working implementation. The
 * bridge-protocol face (register → worker channel, `worker_status` frames, and
 * the non-persisting account Bearer) likewise models the contract at the type
 * level — the shapes and pure derivations, no transport I/O.
 */

// ---------------------------------------------------------------------------
// stream-json control channel
//
// Claude Code's `--sdk-url` worker transport frames control messages as
// newline-delimited JSON (NDJSON): one JSON object per line, `\n`-terminated.
// The control channel is bidirectional — the controller issues
// `control_request`s and the worker answers with `control_response`s (plus
// unsolicited `control_event`s for streamed progress).
// ---------------------------------------------------------------------------

/** Discriminator for every frame carried on the control channel. */
export type ControlFrameType = "control_request" | "control_response" | "control_event";

/** A controller→worker instruction. `id` correlates the eventual response. */
export interface ControlRequest {
  type: "control_request";
  /** Opaque correlation id, unique within a session. */
  id: string;
  /** The verb the worker should act on (e.g. `"interrupt"`, `"prompt"`). */
  subtype: string;
  /** Verb-specific payload; shape is defined per subtype downstream. */
  payload?: Record<string, unknown>;
}

/** A worker→controller reply to a specific {@link ControlRequest}. */
export interface ControlResponse {
  type: "control_response";
  /** Echoes the originating {@link ControlRequest.id}. */
  id: string;
  /** Whether the requested action succeeded. */
  ok: boolean;
  /** Result payload on success. */
  result?: Record<string, unknown>;
  /** Human-readable failure reason when `ok` is `false`. */
  error?: string;
}

/** An unsolicited worker→controller progress/notification frame. */
export interface ControlEvent {
  type: "control_event";
  /** Event discriminator (e.g. `"session_started"`, `"message"`). */
  subtype: string;
  /** Event-specific payload. */
  payload?: Record<string, unknown>;
}

/** Any frame that can travel on the control channel. */
export type ControlFrame = ControlRequest | ControlResponse | ControlEvent;

/**
 * Serialize a single control frame to one NDJSON line (including the trailing
 * newline the framing requires).
 */
export function encodeControlFrame(frame: ControlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Why a line could not be decoded into a {@link ControlFrame}.
 *
 * - `invalid-json`  — the line was not well-formed JSON.
 * - `not-an-object` — valid JSON, but not a JSON object (a number, string,
 *                     `null`, or array — none of which can carry a frame).
 * - `missing-type`  — a JSON object with no `type` discriminator.
 * - `unknown-type`  — a `type` that is not one of the known frame kinds.
 */
export type ControlFrameParseErrorReason = "invalid-json" | "not-an-object" | "missing-type" | "unknown-type";

/**
 * A typed, non-fatal decode failure. Surfaced as a value (never thrown across
 * the channel) so a single malformed or partial line cannot tear down the
 * stream: the caller inspects it and decides whether to skip the line, log, or
 * close. Extends {@link Error} so it can still be `throw`n at a boundary that
 * prefers exceptions, but the codec itself only ever returns it.
 */
export class ControlFrameParseError extends Error {
  /** Machine-readable failure category. */
  readonly reason: ControlFrameParseErrorReason;
  /** The offending line, verbatim, for diagnostics. */
  readonly line: string;

  constructor(reason: ControlFrameParseErrorReason, line: string, message: string) {
    super(message);
    this.name = "ControlFrameParseError";
    this.reason = reason;
    this.line = line;
  }
}

/**
 * Outcome of decoding one line: either a typed {@link ControlFrame} or a typed
 * {@link ControlFrameParseError}. A discriminated union on `ok` so callers
 * branch without `try`/`catch`.
 */
export type DecodeResult =
  { readonly ok: true; readonly frame: ControlFrame } | { readonly ok: false; readonly error: ControlFrameParseError };

/** Runtime guard for the frame discriminator (mirrors {@link ControlFrameType}). */
function isControlFrameType(value: unknown): value is ControlFrameType {
  return value === "control_request" || value === "control_response" || value === "control_event";
}

/** Render an unexpected `type` value for a diagnostic message without stringifying an object. */
function describeType(type: unknown): string {
  return typeof type === "string" ? type : typeof type;
}

/** Build a `{ ok: false }` result carrying a {@link ControlFrameParseError}. */
function parseFailure(reason: ControlFrameParseErrorReason, line: string, message: string): DecodeResult {
  return { ok: false, error: new ControlFrameParseError(reason, line, message) };
}

/**
 * Decode one NDJSON line into a {@link ControlFrame}. Never throws: a malformed
 * line is returned as a `{ ok: false }` {@link ControlFrameParseError} so the
 * caller can keep the stream alive (a bad line must not crash the channel).
 * Validation is at the framing layer — the frame's `type` discriminator — with
 * per-subtype payload validation left to downstream consumers.
 *
 * The caller is responsible for splitting the byte stream into lines; for
 * chunk-boundary buffering use {@link ControlFrameDecoder} instead.
 */
export function decodeControlFrame(line: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown error";
    return parseFailure("invalid-json", line, `ccctl: control frame is not valid JSON: ${detail}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return parseFailure("not-an-object", line, "ccctl: control frame is not a JSON object");
  }
  if (!("type" in value)) {
    return parseFailure("missing-type", line, "ccctl: control frame is missing its `type` discriminator");
  }
  if (!isControlFrameType(value.type)) {
    return parseFailure("unknown-type", line, `ccctl: unknown control frame type: ${describeType(value.type)}`);
  }
  return { ok: true, frame: value as ControlFrame };
}

/**
 * Streaming NDJSON decoder. Accepts arbitrary string chunks as they arrive off
 * a transport and emits one {@link DecodeResult} per complete `\n`-terminated
 * line. A partial trailing line is buffered across chunks — never mis-reported
 * as malformed — until its newline arrives, so a frame split across two reads
 * does not crash the stream. Byte→string decoding is the caller's job, which
 * keeps this layer runtime-agnostic (no `Buffer`, no `node:*`).
 */
export class ControlFrameDecoder {
  #buffer = "";

  /**
   * Feed the next chunk. Returns a {@link DecodeResult} for every complete line
   * the chunk finished — possibly none, if the chunk carried no newline, or
   * several, if it carried many. Blank lines (e.g. keep-alive newlines) are
   * skipped rather than reported as errors, and a malformed line does not stop
   * the well-formed lines around it.
   */
  push(chunk: string): DecodeResult[] {
    this.#buffer += chunk;
    const results: DecodeResult[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        results.push(decodeControlFrame(line));
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return results;
  }

  /**
   * Decode any content left buffered when the stream ends without a trailing
   * newline. Returns the final {@link DecodeResult}, or `null` if nothing (or
   * only whitespace) remained. Clears the buffer, so it is safe to call once at
   * end-of-stream.
   */
  flush(): DecodeResult | null {
    const line = this.#buffer;
    this.#buffer = "";
    return line.trim() === "" ? null : decodeControlFrame(line);
  }
}

// ---------------------------------------------------------------------------
// network primitives
//
// Shared by `server` (what it binds) and `tunnel-adapters` (what a tunnel
// exposes and therefore what the worker's `--sdk-url` allowlist must permit).
// ---------------------------------------------------------------------------

/** A host:port the ccctl server is reachable at. */
export interface HostEndpoint {
  host: string;
  port: number;
}

/** The loopback hosts that are always permitted without a tunnel. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** Whether a host is one of the always-allowed loopback hosts. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

// ---------------------------------------------------------------------------
// session / state model
// ---------------------------------------------------------------------------

/** Lifecycle of a single steered Claude Code session. */
export type SessionStatus = "connecting" | "ready" | "busy" | "closed" | "errored";

/** A Claude Code session under ccctl control, as tracked by the hub. */
export interface Session {
  /** ccctl-assigned session identifier (distinct from any worker-side id). */
  readonly id: string;
  /** Current lifecycle state. */
  status: SessionStatus;
  /** Epoch millis when the session was first registered. */
  readonly createdAt: number;
  /** Epoch millis of the most recent frame in either direction. */
  lastActivityAt: number;
}

/** Create a freshly-registered session in the `connecting` state. */
export function createSession(id: string, now: number = Date.now()): Session {
  return {
    id,
    status: "connecting",
    createdAt: now,
    lastActivityAt: now,
  };
}

// ---------------------------------------------------------------------------
// bridge protocol — register → worker channel
//
// ccctl interoperates with Claude Code's native Agent-SDK stream-json control
// transport (the `--sdk-url` steering channel). The local server terminates the
// transport for a session; the flow it models is:
//
//   1. Register — the worker issues `POST /v1/code/sessions`; the response
//      carries a session id and a `ws_url` (the worker-channel URL).
//   2. Worker channel — the worker opens a WebSocket to `ws_url` speaking
//      stream-json (the NDJSON `ControlFrame`s above); transcript events flow
//      server-ward and steer input worker-ward over the one channel.
//   3. `worker_status` frames on that channel drive per-session state.
//
// This is the contract FACE only: the shapes plus pure derivations. Transport
// I/O (the fetch, the WebSocket client) is the server's job and is not here.
// ---------------------------------------------------------------------------

/**
 * The build-specific session-create path, pinned to a concrete API version.
 * Pinning makes a drift in the worker's transport a loud, fail-closed mismatch
 * rather than a silent wrong-endpoint call; bumping it is a deliberate,
 * reviewed change.
 */
export const SESSIONS_CREATE_PATH = "/v1/code/sessions";

// --- credentials ---
//
// Two credentials ride the bridge, with opposite persistence rules:
//
//   - The account OAuth Bearer (`Authorization: Bearer …`) is presented on BOTH
//     the register request and the worker-WebSocket connect. It is a strict
//     NON-PERSISTING pass-through — forwarded only to api.anthropic.com for the
//     live session, and NEVER logged, persisted, or replayed. Modelled as an
//     opaque `AccountBearer` so a leak into a log or snapshot is a *type* error
//     (it is neither a string nor a `JsonValue`), backed by runtime redaction.
//   - A scoped session-ingress token rides as a payload field and does NOT
//     replace the Bearer. Being scoped, it is an ordinary branded string that
//     legitimately travels inside the JSON body.

/**
 * Opaque holder for the account OAuth Bearer. By construction it cannot leak
 * into a loggable or persistable shape:
 *
 *   - it is a class instance with a private `#token`, so it is neither a
 *     `string` nor a {@link JsonValue} — assigning it to any log/snapshot field
 *     is a compile error (the "omit by construction" contract, #60);
 *   - the raw token is reachable ONLY through {@link AccountBearer.reveal}, the
 *     single sanctioned exit (used solely by the server transport when
 *     forwarding to api.anthropic.com);
 *   - {@link AccountBearer.toJSON} and {@link AccountBearer.toString} redact, so
 *     even a stray `JSON.stringify` or interpolation emits a marker, never the
 *     token — runtime defense in depth behind the type-level guarantee.
 */
export class AccountBearer {
  /** Emitted in place of the token on any serialization or string coercion. */
  static readonly REDACTED = "[redacted AccountBearer]";

  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /**
   * The raw `Authorization: Bearer` value — the ONLY way out. Call sites form
   * the small auditable set that touches the credential; everything else sees
   * an opaque holder.
   */
  reveal(): string {
    return this.#token;
  }

  /** Redact under `JSON.stringify`: a stray serialization never emits the token. */
  toJSON(): string {
    return AccountBearer.REDACTED;
  }

  /** Redact under string coercion / template interpolation. */
  toString(): string {
    return AccountBearer.REDACTED;
  }
}

/** Nominal brand for {@link SessionIngressToken}. */
declare const sessionIngressTokenBrand: unique symbol;

/**
 * A scoped session-ingress token. It rides as a field in the register payload
 * and does NOT replace the {@link AccountBearer}. Branded so it cannot be
 * confused with an arbitrary string, yet still a `string` (hence a
 * {@link JsonValue}) because it legitimately travels inside the JSON body.
 */
export type SessionIngressToken = string & {
  readonly [sessionIngressTokenBrand]: never;
};

/** Tag a raw string as a {@link SessionIngressToken}. */
export function sessionIngressToken(value: string): SessionIngressToken {
  return value as SessionIngressToken;
}

// --- register (session create) ---

/**
 * The JSON body of a {@link RegisterRequest}: everything that legitimately
 * travels in the `POST /v1/code/sessions` payload. A {@link JsonObject} by
 * construction — it carries the scoped {@link SessionIngressToken}, never the
 * {@link AccountBearer} (which rides in the `Authorization` header, modelled as
 * the sibling field on {@link RegisterRequest}). This is precisely the
 * loggable/persistable projection of a register: the Bearer is absent because
 * the body has no field able to hold it.
 */
export interface RegisterRequestBody {
  readonly sessionIngressToken: SessionIngressToken;
}

/**
 * A `POST /v1/code/sessions` request. The account Bearer sits in
 * `authorization` (the `Authorization: Bearer …` header) — structurally OUTSIDE
 * the JSON {@link RegisterRequestBody}, so it can never be serialized as part
 * of the payload. Use {@link loggableRegisterRequest} for the Bearer-free view.
 */
export interface RegisterRequest {
  /** `Authorization: Bearer …` — non-persisting pass-through, never in `body`. */
  readonly authorization: AccountBearer;
  /** The JSON payload (carries the scoped session-ingress token). */
  readonly body: RegisterRequestBody;
}

/**
 * The `POST /v1/code/sessions` response: the newly-created session id and the
 * `ws_url` the worker opens its channel to. A {@link JsonObject} carrying no
 * credentials, so it is safe to persist and log.
 */
export interface RegisterResponse {
  /** Server-assigned session identifier. */
  readonly sessionId: string;
  /** The worker-channel WebSocket URL (`ws_url`). */
  readonly wsUrl: string;
}

/**
 * Project a {@link RegisterRequest} to its Bearer-free, loggable view — its JSON
 * body. Because {@link RegisterRequestBody} has no field able to hold an
 * {@link AccountBearer}, this IS the "omit by construction" guarantee: a
 * register cannot be routed through a log without dropping the Bearer.
 */
export function loggableRegisterRequest(request: RegisterRequest): RegisterRequestBody {
  return request.body;
}

// --- worker channel ---

/**
 * Parameters to open the worker-channel WebSocket. The {@link AccountBearer} is
 * presented AGAIN here (`Authorization: Bearer …` on the WS connect), modelled
 * the same opaque way; {@link loggableWorkerChannelConnect} yields the
 * Bearer-free view for diagnostics.
 */
export interface WorkerChannelConnect {
  /** The `ws_url` from {@link RegisterResponse.wsUrl}. */
  readonly wsUrl: string;
  /** `Authorization: Bearer …` — the same non-persisting account credential. */
  readonly authorization: AccountBearer;
}

/** The Bearer-free projection of a {@link WorkerChannelConnect}, safe to log. */
export interface LoggableWorkerChannelConnect {
  readonly wsUrl: string;
}

/** Project a {@link WorkerChannelConnect} to its Bearer-free, loggable view. */
export function loggableWorkerChannelConnect(connect: WorkerChannelConnect): LoggableWorkerChannelConnect {
  return { wsUrl: connect.wsUrl };
}

// --- worker_status frames ---

/**
 * Per-session state the server derives from `worker_status` frames: `running`
 * (busy), `requires_action` (awaiting steer input), or `idle`.
 */
export type WorkerStatus = "running" | "requires_action" | "idle";

/** Runtime guard for {@link WorkerStatus} (mirrors {@link isControlFrameType} above). */
export function isWorkerStatus(value: unknown): value is WorkerStatus {
  return value === "running" || value === "requires_action" || value === "idle";
}

/**
 * A `worker_status` frame: a {@link ControlEvent} whose `subtype` is pinned to
 * `"worker_status"` and whose payload carries a {@link WorkerStatus}. Modelled
 * as a refinement of {@link ControlEvent} — not a new frame kind — so it rides
 * the existing NDJSON codec unchanged.
 */
export interface WorkerStatusEvent extends ControlEvent {
  subtype: "worker_status";
  payload: { status: WorkerStatus };
}

/**
 * Narrow a {@link ControlFrame} to a {@link WorkerStatusEvent}. Defensive over
 * decoded frames: a `payload` that is missing, `null`, or carries an unknown
 * status fails closed. The static type says payload is never `null`, but a
 * decoded line can be anything, so the guard reads it back as `unknown`.
 */
export function isWorkerStatusEvent(frame: ControlFrame): frame is WorkerStatusEvent {
  if (frame.type !== "control_event" || frame.subtype !== "worker_status") {
    return false;
  }
  const payload: unknown = frame.payload;
  return typeof payload === "object" && payload !== null && "status" in payload && isWorkerStatus(payload.status);
}

/**
 * Derive the {@link WorkerStatus} a control frame reports, or `null` if it is
 * not a well-formed `worker_status` event. This is the pure server-side
 * derivation of per-session state from the worker channel.
 */
export function workerStatusFromFrame(frame: ControlFrame): WorkerStatus | null {
  return isWorkerStatusEvent(frame) ? frame.payload.status : null;
}

// --- loggable / persistable (JSON) shape + credential-omission proofs ---

/** A JSON-safe value: exactly what may cross into a log line or a snapshot. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** A JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// Compile-time proof (erased at build) that the account Bearer cannot reach a
// loggable/persistable (JSON) shape, while the wire/persist shapes stay provably
// credential-free. If any assertion breaks, `tsc` fails — so "omit the Bearer by
// construction" is enforced by the type checker, not by reviewer vigilance.
// `IsJson` is structural: an interface has no implicit index signature (so it is
// not directly assignable to `JsonObject`), so it checks JSON-safety per property
// and rejects method-bearing class instances such as `AccountBearer`.
type Assert<T extends true> = T;
type IsJson<T> = [T] extends [JsonValue]
  ? true
  : [T] extends [(...args: never[]) => unknown]
    ? false
    : [T] extends [readonly (infer E)[]]
      ? IsJson<E>
      : [T] extends [object]
        ? { [K in keyof T]-?: IsJson<T[K]> } extends Record<keyof T, true>
          ? true
          : false
        : false;

/**
 * The compile-time credential-omission contract, exported so it has a referent
 * (and is therefore evaluated, not dropped as unused). Each element is a proof:
 * the account {@link AccountBearer} is NOT JSON — so a leak into a log/snapshot
 * is a type error — while {@link RegisterResponse}, {@link RegisterRequestBody},
 * {@link LoggableWorkerChannelConnect}, and the {@link Session} snapshot ARE
 * JSON, provably free of the credential.
 */
export type BridgeCredentialJsonProofs = [
  Assert<IsJson<AccountBearer> extends true ? false : true>,
  Assert<IsJson<RegisterResponse>>,
  Assert<IsJson<RegisterRequestBody>>,
  Assert<IsJson<LoggableWorkerChannelConnect>>,
  Assert<IsJson<Session>>,
];
