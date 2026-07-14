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
 * bridge-protocol face (the environments-bridge flow — environment register →
 * session create → work poll → per-session worker channel) models the contract at
 * the type level: the shapes, the version pin, the fail-closed drift guards, and
 * the pure derivations — no transport I/O. The per-session worker channel is
 * **HTTP + SSE** (the `--sdk-url` control path opens a Server-Sent-Events stream
 * to the server and POSTs back over HTTP), never a WebSocket.
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

/**
 * Format a `host:port` authority (RFC 3986), bracketing an IPv6 host so `::1`
 * renders `[::1]:port` — never the malformed `::1:port`. The single place that
 * knows the bracketing rule, shared by everything that renders a
 * {@link HostEndpoint} into a URL (the work-secret's `api_base_url`, a tunnel's
 * serve target), so an IPv6 loopback is handled the one correct way everywhere.
 */
export function formatAuthority(host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${authority}:${port}`;
}

// ---------------------------------------------------------------------------
// session / state model
// ---------------------------------------------------------------------------

/** Lifecycle of a single steered Claude Code session. */
export type SessionStatus = "connecting" | "ready" | "busy" | "closed" | "errored";

/**
 * A Claude Code session under ccctl control, as tracked by the hub.
 *
 * Session state is THREE orthogonal dimensions that COMPOSE — none subsumes
 * another, so each is tracked and transitioned on its own:
 *
 *   - {@link SessionStatus} `status` — the transport LIFECYCLE of the steering
 *     channel (connecting → ready → busy → closed/errored).
 *   - {@link SessionActivity} `activity` — what the worker is DOING inside a
 *     live session, derived from `worker_status` frames (running /
 *     requires_action / idle). See {@link sessionActivityFromFrame}.
 *   - liveness — heartbeat freshness ({@link Session.lastHeartbeatAt}); a
 *     session whose heartbeat gap exceeds the window is *stale* regardless of
 *     lifecycle or activity. See {@link isSessionStale}.
 *
 * A `ready` + `running` session can still be `stale` (the worker stopped
 * heart-beating) — the dimensions are independent.
 */
export interface Session {
  /**
   * Session identity — the **session id from the session-create response**
   * ({@link SessionCreateResponse.sessionId}, contract §2), server-assigned and
   * distinct from any worker-side id. {@link createSession} keys a session on it.
   */
  readonly id: string;
  /** Transport lifecycle state. */
  status: SessionStatus;
  /** Activity derived from the latest `worker_status` frame. */
  activity: SessionActivity;
  /** Epoch millis when the session was first registered. */
  readonly createdAt: number;
  /** Epoch millis of the most recent `worker_status` frame applied. */
  lastActivityAt: number;
  /** Epoch millis of the most recent heartbeat; drives liveness/staleness. */
  lastHeartbeatAt: number;
}

/**
 * Create a freshly-registered session: `connecting` lifecycle, `idle` activity,
 * and the heartbeat clock started at `now` (registration is its first liveness
 * signal). `now` is injectable so liveness/heartbeat timing is deterministic
 * under test — never a baked-in ambient clock.
 */
export function createSession(id: string, now: number = Date.now()): Session {
  return {
    id,
    status: "connecting",
    activity: { kind: "idle" },
    createdAt: now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
  };
}

// ---------------------------------------------------------------------------
// bridge protocol — environments-bridge flow
//
// ccctl interoperates with the current Claude Code build's native `--sdk-url`
// control transport. The local server terminates the transport; the flow it
// models has five legs, conformed to the worker's *actually-observed* wire:
//
//   §1. Environment register — `POST /v1/environments/bridge` with the account
//       Bearer; the body carries `machine_name` / `directory` / `branch` /
//       `git_repo_url` (nullable) / `max_sessions` / `metadata`; the response is
//       an environment id (interpolated into the §3 work-poll path).
//   §2. Session create — `POST /v1/sessions` with the account Bearer; the body
//       carries the session context (model, cwd), a source, and a permission
//       mode; the response is `{ session_id }` (NO `ws_url` — the SSE control
//       path never reads one).
//   §3. Work poll — `GET /v1/environments/{env}/work/poll`, long-polled with NO
//       credential (the worker presents none), delivering a SINGLE {@link WorkItem}
//       object (`{ id, secret, data: { type, id } }`) or an empty body ("no work").
//       The item's `secret` is `base64url(JSON` {@link WorkSecret}`)`, carrying the
//       locally-minted `session_ingress_token` (the §4/§5 credential) and the
//       `api_base_url` base of the per-session control URL.
//   §4/§5. Per-session worker channel — HTTP + SSE under
//       `/v1/code/sessions/{id}/worker/…`, authorized by the `session_ingress_token`
//       (NOT the account Bearer): a register handshake (`→ { worker_epoch }`), a
//       held-open downstream SSE (`…/events/stream`), a batched upstream POST
//       (`…/events`), a status gate (`PUT …/worker`), a heartbeat, and a downstream
//       delivery-ack. A turn is injected by pushing a `client_event` frame down the
//       SSE; the turn (prompt → inference) and steer travel that way, and the
//       worker relays assistant/result output back up `…/events`.
//
// This is the contract FACE only: the shapes plus pure derivations. Transport I/O
// (the fetch, the SSE stream, the long-poll loop) is the server's job and is not
// here. The versioned paths below are PINNED, and unknown shapes carried over them
// fail closed on drift (see {@link workItemFromValue}, {@link isPermissionMode}).
//
// **Two-credential boundary (HARD, #60/#130).** The account OAuth Bearer authorizes
// the two POSTs that reach Anthropic — environment register (§1) and session create
// (§2) — and ONLY those. It is a strict NON-PERSISTING pass-through: validated for
// receipt, then dropped — never logged, persisted, or returned in a body. Modelled
// as an opaque {@link AccountBearer} so a leak into a log or snapshot is a *type*
// error. The work-poll leg (§3) carries NO credential. The per-session channel
// (§4/§5) is authorized by the {@link SessionIngressToken} — minted LOCALLY by the
// server, carried inside the {@link WorkSecret}, and NEVER the account Bearer.
// ---------------------------------------------------------------------------

// --- version pin & pinned paths ---

/**
 * The pinned bridge-protocol API version every path below lives under. Pinning
 * makes a worker-transport drift a loud, fail-closed mismatch rather than a
 * silent wrong-endpoint call; bumping it is a deliberate, reviewed change.
 */
export const BRIDGE_PROTOCOL_API_VERSION = "v1";

/** The environments collection base — the root of §1 and §3. Private: consumers use the builders below. */
const ENVIRONMENTS_PATH = `/${BRIDGE_PROTOCOL_API_VERSION}/environments`;

/** Environment-register path (§1): `POST` with the account Bearer → an environment id. */
export const ENVIRONMENTS_BRIDGE_PATH = `${ENVIRONMENTS_PATH}/bridge`;

/** Session-create path (§2): `POST` with the account Bearer → `{ session_id }`. */
export const SESSIONS_PATH = `/${BRIDGE_PROTOCOL_API_VERSION}/sessions`;

/**
 * Work-poll path for an environment (§3): long-polled with NO credential. The
 * environment id is path-interpolated, so this is a builder rather than a constant.
 */
export function environmentWorkPollPath(environmentId: string): string {
  return `${ENVIRONMENTS_PATH}/${environmentId}/work/poll`;
}

/**
 * The per-session worker-channel base (§4/§5): `/v1/code/sessions/{id}/worker`. The
 * `PUT` on this exact path is the status gate; the sub-paths below hang off it. This
 * lives under `/v1/code/sessions/…` (the observed `--sdk-url` control base), distinct
 * from the §2 `SESSIONS_PATH` register collection.
 */
export function workerChannelPath(sessionId: string): string {
  return `/${BRIDGE_PROTOCOL_API_VERSION}/code/sessions/${sessionId}/worker`;
}

/** Worker register-handshake path (§4): `POST {}` → `{ worker_epoch }`. */
export function workerRegisterPath(sessionId: string): string {
  return `${workerChannelPath(sessionId)}/register`;
}

/** Held-open downstream SSE path (§4): `GET` → `text/event-stream` (server→worker). */
export function workerEventsStreamPath(sessionId: string): string {
  return `${workerChannelPath(sessionId)}/events/stream`;
}

/** Batched upstream events path (§5): `POST { worker_epoch, events }` (worker→server). */
export function workerEventsPath(sessionId: string): string {
  return `${workerChannelPath(sessionId)}/events`;
}

/** Downstream delivery-ack path (§5): `POST { worker_epoch, updates }` (the worker acks each pushed event). */
export function workerEventsDeliveryPath(sessionId: string): string {
  return `${workerChannelPath(sessionId)}/events/delivery`;
}

/** Liveness heartbeat path (§5): `POST` (keeps the channel live). */
export function workerHeartbeatPath(sessionId: string): string {
  return `${workerChannelPath(sessionId)}/heartbeat`;
}

// --- credentials ---
//
// Two credential CLASSES ride the bridge, on opposite legs and with opposite
// privilege — modelling both is the two-credential boundary (#60/#130):
//
//   - The account OAuth Bearer (`Authorization: Bearer …`) authorizes the two
//     POSTs that reach Anthropic — environment register (§1) and session create
//     (§2) — and ONLY those. It is a strict NON-PERSISTING pass-through — validated
//     for receipt, then dropped; NEVER logged, persisted, or returned in a body.
//     Modelled as an opaque {@link AccountBearer} so a leak into a log or snapshot
//     is a *type* error (it is neither a string nor a `JsonValue`), backed by
//     runtime redaction.
//   - The scoped per-session {@link SessionIngressToken} authorizes the per-session
//     worker channel (§4/§5) and ONLY that. It is minted LOCALLY by the server,
//     carried to the worker inside the {@link WorkSecret}, and is NEVER the account
//     Bearer: presenting a distinct, session-scoped credential on the channel IS the
//     Bearer boundary. Being scoped (its leak compromises one session's channel, not
//     the account), it is an ordinary branded string that may travel on the wire.

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
 * A scoped per-session token — the credential the per-session worker channel
 * (§4/§5) presents, in place of (never alongside) the {@link AccountBearer}. It is
 * minted LOCALLY by the server and handed to the worker inside the
 * {@link WorkSecret} (`session_ingress_token`). Branded so it cannot be confused
 * with an arbitrary string, yet still a `string` (hence a {@link JsonValue}) because,
 * being session-scoped, it may legitimately travel on the wire. Its type — distinct
 * from {@link AccountBearer} — is what makes "the worker channel is not authorized by
 * the account Bearer" a compile-time fact.
 */
export type SessionIngressToken = string & {
  readonly [sessionIngressTokenBrand]: never;
};

/** Tag a raw string as a {@link SessionIngressToken}. */
export function sessionIngressToken(value: string): SessionIngressToken {
  return value as SessionIngressToken;
}

// --- §1 environment register ---

/**
 * The JSON body of an {@link EnvironmentRegisterRequest}: the environment ccctl
 * is bridging — its machine, working directory, branch, repository URL (nullable)
 * — plus the cap on concurrent sessions and an opaque metadata bag. A
 * {@link JsonObject} by construction; it carries NO credential (the account Bearer
 * rides the sibling `authorization` field, structurally outside the body), so it is
 * the loggable/persistable projection of a register.
 */
export interface EnvironmentRegisterRequestBody {
  /** Human-readable name of the machine ccctl runs on (`machine_name` on the wire). */
  readonly machineName: string;
  /** Absolute working directory the environment is rooted at. */
  readonly directory: string;
  /** Git branch checked out in {@link EnvironmentRegisterRequestBody.directory}. */
  readonly branch: string;
  /** Git remote URL the environment is working against (`git_repo_url`), or `null` when there is none. */
  readonly gitRepoUrl: string | null;
  /** Upper bound on concurrent sessions this environment will accept. */
  readonly maxSessions: number;
  /** Opaque metadata bag (e.g. `{ worker_type: "claude_code" }`); carried through, not interpreted. */
  readonly metadata: JsonObject;
}

/**
 * A `POST /v1/environments/bridge` request (§1). The account Bearer sits in
 * `authorization` (the `Authorization: Bearer …` header) — structurally OUTSIDE
 * the JSON {@link EnvironmentRegisterRequestBody}, so it can never be serialized
 * as part of the payload. Use {@link loggableEnvironmentRegisterRequest} for the
 * Bearer-free view.
 */
export interface EnvironmentRegisterRequest {
  /** `Authorization: Bearer …` — non-persisting pass-through, never in `body`. */
  readonly authorization: AccountBearer;
  /** The JSON payload (machine/dir/branch/repo + max-sessions cap + metadata). */
  readonly body: EnvironmentRegisterRequestBody;
}

/**
 * The `POST /v1/environments/bridge` response (§1): the server-assigned
 * environment id later interpolated into the work-poll path
 * ({@link environmentWorkPollPath}). A {@link JsonObject} carrying no credential,
 * so it is safe to persist and log.
 */
export interface EnvironmentRegisterResponse {
  /** Server-assigned environment identifier. */
  readonly environmentId: string;
}

/**
 * Project an {@link EnvironmentRegisterRequest} to its Bearer-free, loggable
 * view — its JSON body. Because {@link EnvironmentRegisterRequestBody} has no
 * field able to hold an {@link AccountBearer}, this IS the "omit by
 * construction" guarantee (#60): a register cannot be routed through a log
 * without dropping the Bearer.
 */
export function loggableEnvironmentRegisterRequest(
  request: EnvironmentRegisterRequest,
): EnvironmentRegisterRequestBody {
  return request.body;
}

// --- §2 session create ---

/**
 * The Claude Code permission modes a session can be created under. Pinned to the
 * current build's set ({@link PERMISSION_MODES}); an unrecognized mode fails
 * closed via {@link isPermissionMode} rather than being silently accepted
 * (drift), mirroring the control-frame codec's discriminant validation.
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/** The pinned {@link PermissionMode} set, in one place, for the guard and tests. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

/** Runtime guard for {@link PermissionMode} — fails closed on an unknown mode (drift). */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The session context a create carries: which model, and the working directory. */
export interface SessionContext {
  /** Model the session runs (a Claude model id). */
  readonly model: string;
  /** Working directory the session is rooted at. */
  readonly cwd: string;
}

/**
 * The JSON body of a {@link SessionCreateRequest}: the session context, the
 * source that initiated the session, and the permission mode it runs under. A
 * {@link JsonObject} by construction, carrying NO credential (the account Bearer
 * rides the sibling `authorization` field) — the loggable projection of a create.
 */
export interface SessionCreateRequestBody {
  /** The model + cwd the session runs with. */
  readonly context: SessionContext;
  /** What initiated the session (e.g. a UI action, a dequeued work item). */
  readonly source: string;
  /** Permission mode the session runs under. */
  readonly permissionMode: PermissionMode;
}

/**
 * A `POST /v1/sessions` request (§2). The account Bearer sits in `authorization`,
 * structurally OUTSIDE the JSON {@link SessionCreateRequestBody}, so it can never
 * be serialized as part of the payload. Use {@link loggableSessionCreateRequest}
 * for the Bearer-free view.
 */
export interface SessionCreateRequest {
  /** `Authorization: Bearer …` — non-persisting pass-through, never in `body`. */
  readonly authorization: AccountBearer;
  /** The JSON payload (session context + source + permission mode). */
  readonly body: SessionCreateRequestBody;
}

/**
 * The `POST /v1/sessions` response (§2): the newly-created session id. There is NO
 * `ws_url` — the `--sdk-url` control path is SSE and never reads one; the worker
 * reaches the per-session channel (§4/§5) via the {@link WorkSecret}'s `api_base_url`
 * instead. A {@link JsonObject} carrying no credential, so it is safe to persist and log.
 */
export interface SessionCreateResponse {
  /** Server-assigned session identifier. */
  readonly sessionId: string;
}

/** Project a {@link SessionCreateRequest} to its Bearer-free, loggable JSON body. */
export function loggableSessionCreateRequest(request: SessionCreateRequest): SessionCreateRequestBody {
  return request.body;
}

// --- §3 work poll ---

/**
 * The kinds of work item the work-poll leg (§3) delivers: a `healthcheck` (a
 * liveness poke) or a `session` (start/attach a session's worker). Pinned to the
 * current build's set ({@link WORK_ITEM_TYPES}); an unknown type fails closed via
 * {@link isWorkItemType} / {@link workItemFromValue} rather than being dispatched
 * (drift).
 */
export type WorkItemType = "healthcheck" | "session";

/** The pinned {@link WorkItemType} set, in one place, for the guard and tests. */
export const WORK_ITEM_TYPES: readonly WorkItemType[] = ["healthcheck", "session"];

/** Runtime guard for {@link WorkItemType} — fails closed on an unknown type (drift). */
export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * The `data` of a {@link WorkItem}: its {@link WorkItemType} and, for a `session`
 * item, the session id it dispatches ({@link WorkItemData.id} is the
 * {@link SessionCreateResponse.sessionId}). A `healthcheck` carries no session id.
 */
export interface WorkItemData {
  /** The work-item discriminant. */
  readonly type: WorkItemType;
  /** The session id (present, and load-bearing, when `type === "session"`). */
  readonly id?: string;
}

/**
 * One work item delivered by a poll (§3): `{ id, secret, data: { type, id } }`. `id`
 * is the work-item handle; `secret` is `base64url(JSON` {@link WorkSecret}`)` carrying
 * the locally-minted `session_ingress_token` and `api_base_url` the worker needs to
 * open the §4/§5 channel; `data` is the {@link WorkItemData}. A poll returns exactly
 * ONE item (or an empty body — "no work"), NOT a `{ work: [...] }` envelope.
 */
export interface WorkItem {
  /** Work-item handle. */
  readonly id: string;
  /** `base64url(JSON` {@link WorkSecret}`)` — the per-session ingress credential + control base. */
  readonly secret: string;
  /** The item discriminant + (for a `session`) its session id. */
  readonly data: WorkItemData;
}

/** The pinned {@link WorkSecret} version — a version drift fails closed in {@link parseWorkSecret}. */
export const WORK_SECRET_VERSION = 1;

/**
 * The decoded {@link WorkItem.secret}: `base64url(JSON.stringify(WorkSecret))`. Both
 * inner fields are load-bearing — the worker fails the item without either. The
 * `session_ingress_token` becomes the Bearer the worker presents on the per-session
 * legs (§4/§5); `api_base_url` is the base of the child control URL. This is NOT a
 * cryptographic token — it is minted locally by the server. It is NOT the account
 * Bearer and must never be persisted or logged. Snake_case because these fields ARE
 * the on-the-wire secret body (the base64url ↔ bytes step is the transport's, out of
 * this pure face's scope).
 */
export interface WorkSecret {
  /** Pinned to {@link WORK_SECRET_VERSION}; a drift fails closed. */
  readonly version: 1;
  /** The scoped per-session credential the worker presents on §4/§5. */
  readonly session_ingress_token: string;
  /** The base (`scheme://authority`) of the per-session control URL. */
  readonly api_base_url: string;
}

/**
 * Parse an ALREADY-DECODED value into a {@link WorkSecret}, or `null` if it is not a
 * well-formed one. Fail-closed over a value off the wire: a wrong `version` (drift),
 * or a missing/blank `session_ingress_token` / `api_base_url`, all yield `null`. The
 * base64url ↔ bytes decode is the caller's job (a runtime concern kept out of this
 * layer, which stays `Buffer`-free); this is the shared shape guard both the server
 * (mint) and a worker/oracle (verify) honor.
 */
export function parseWorkSecret(value: unknown): WorkSecret | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { version, session_ingress_token, api_base_url } = value as {
    version?: unknown;
    session_ingress_token?: unknown;
    api_base_url?: unknown;
  };
  if (version !== WORK_SECRET_VERSION) {
    return null;
  }
  if (typeof session_ingress_token !== "string" || session_ingress_token === "") {
    return null;
  }
  if (typeof api_base_url !== "string" || api_base_url === "") {
    return null;
  }
  return { version: WORK_SECRET_VERSION, session_ingress_token, api_base_url };
}

/**
 * Parse an arbitrary decoded value into a {@link WorkItem}, or `null` if it is not a
 * well-formed one. Defensive/fail-closed over a value off the wire: a missing or
 * non-string `id`/`secret`, a `data` that is not an object, an unknown `data.type`
 * (drift), or a `session` item missing its `data.id` all yield `null` rather than a
 * half-typed item — the single fail-closed seam for §3, mirroring
 * {@link decodeControlFrame}'s discriminant-only validation, so a drifted work item
 * cannot be dispatched. (The `secret`'s INTERNAL structure is validated separately by
 * {@link parseWorkSecret} after a base64url decode.)
 */
export function workItemFromValue(value: unknown): WorkItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { id, secret, data } = value as { id?: unknown; secret?: unknown; data?: unknown };
  if (typeof id !== "string" || id === "" || typeof secret !== "string" || secret === "") {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const { type, id: dataId } = data as { type?: unknown; id?: unknown };
  if (!isWorkItemType(type)) {
    return null;
  }
  if (type === "session") {
    if (typeof dataId !== "string" || dataId === "") {
      return null;
    }
    return { id, secret, data: { type, id: dataId } };
  }
  // A non-session item carries no session id; a stray non-string one fails closed.
  if (dataId !== undefined && (typeof dataId !== "string" || dataId === "")) {
    return null;
  }
  return dataId === undefined ? { id, secret, data: { type } } : { id, secret, data: { type, id: dataId } };
}

// --- worker_status frames ---

/**
 * Per-session state the server derives from `worker_status` frames — and the value
 * the §4/§5 `PUT …/worker` status gate carries: `running` (busy),
 * `requires_action` (awaiting steer input), or `idle` (ready for a turn).
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
 *
 * When `status` is `"requires_action"` the worker MAY attach a `detail`: a
 * human-ready line naming what input it is waiting for (a permission prompt, a
 * question). It is OPTIONAL on the wire — {@link sessionActivityFromFrame}
 * supplies {@link DEFAULT_REQUIRES_ACTION_DETAIL} when it is absent, so the
 * derived activity always carries a non-empty, displayable detail. Adding it as
 * an optional field keeps every existing `{ status }` payload valid.
 */
export interface WorkerStatusEvent extends ControlEvent {
  subtype: "worker_status";
  payload: { status: WorkerStatus; detail?: string };
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

// ---------------------------------------------------------------------------
// session activity, liveness & transitions
//
// The tri-state a `worker_status` frame derives (running / requires_action /
// idle), the heartbeat-based liveness rule, and the explicit per-session
// transitions that fold both into a {@link Session}. Every transition is a PURE
// function returning a NEW session, so one session's transition can never mutate
// another (contract: per-session isolation). Timing is via an injected `now`
// (epoch millis), never an ambient clock, so liveness is deterministic in tests.
// ---------------------------------------------------------------------------

/**
 * The session state derived from a `worker_status` frame — the richer form of
 * {@link WorkerStatus} that carries, for `requires_action`, the human-ready
 * detail naming what input the worker is waiting for. A discriminated union on
 * `kind`, so a consumer handles the detail exactly when (and only when) it
 * exists.
 */
export type SessionActivity =
  | { readonly kind: "running" }
  | { readonly kind: "requires_action"; readonly detail: string }
  | { readonly kind: "idle" };

/**
 * Human-ready detail used when a `requires_action` frame carries none, so the
 * derived {@link SessionActivity} always has a non-empty, displayable detail.
 */
export const DEFAULT_REQUIRES_ACTION_DETAIL = "Awaiting input.";

/**
 * Resolve a `requires_action` human `detail`, defaulting to
 * {@link DEFAULT_REQUIRES_ACTION_DETAIL}. Defensive over a decoded frame or a bare
 * status update: a `detail` that is absent, non-string, or blank falls back rather
 * than surfacing an empty line.
 */
function requiresActionDetail(detail: string | undefined): string {
  return typeof detail === "string" && detail.trim() !== "" ? detail : DEFAULT_REQUIRES_ACTION_DETAIL;
}

/**
 * Derive the {@link SessionActivity} a control frame reports, or `null` if it is
 * not a well-formed `worker_status` event. The tri-state the session model is
 * built on: `running` / `requires_action` (+ its human-ready detail) / `idle`.
 * Shares the fail-closed guard {@link isWorkerStatusEvent} with
 * {@link workerStatusFromFrame}, then enriches `requires_action` with the
 * detail. The `switch` is exhaustive over {@link WorkerStatus}, so adding a
 * fourth status later is a compile error here until it is handled.
 */
export function sessionActivityFromFrame(frame: ControlFrame): SessionActivity | null {
  if (!isWorkerStatusEvent(frame)) {
    return null;
  }
  return sessionActivityFromStatus(frame.payload.status, frame.payload.detail);
}

/**
 * Derive a {@link SessionActivity} directly from a {@link WorkerStatus} (and, for
 * `requires_action`, an optional human detail). The §4/§5 `PUT …/worker` status gate
 * carries a bare `worker_status` rather than a full `control_event`, so it folds its
 * status into activity through this shared derivation. The `switch` is exhaustive, so
 * a fourth status is a compile error until handled.
 */
export function sessionActivityFromStatus(status: WorkerStatus, detail?: string): SessionActivity {
  switch (status) {
    case "running":
      return { kind: "running" };
    case "requires_action":
      return { kind: "requires_action", detail: requiresActionDetail(detail) };
    case "idle":
      return { kind: "idle" };
  }
}

/**
 * How long the hub tolerates silence — no heartbeat — before it marks a session
 * stale. The worker channel emits a periodic heartbeat; a session stays live
 * while beats keep arriving, and a gap wider than this window means the worker
 * is presumed gone rather than merely slow.
 *
 * Chosen at 30_000 ms (30 s). The heartbeat cadence is NOT pinned by the
 * protocol, so this is a deliberate design value, not a derived one: assuming a
 * nominal ~10 s beat, 30 s absorbs two consecutive missed beats (a GC pause,
 * transient network jitter, a brief event-loop stall) before a false-positive
 * stale, while still surfacing a genuinely dead worker within a few seconds of
 * the third missed beat. It is an INJECTABLE default — a deployment with a
 * faster or slower heartbeat passes its own window to {@link isSessionStale} /
 * {@link sessionLiveness} — never a hidden magic number.
 */
export const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 30_000;

/** Heartbeat-derived liveness: `live` while beats are fresh, `stale` once the window lapses. */
export type SessionLiveness = "live" | "stale";

/**
 * Whether `session` is stale at `now`: `true` once the gap since its last
 * heartbeat EXCEEDS `staleAfterMs` (a gap exactly at the window is still live —
 * the boundary is `>`). Pure and injectable — both `now` and the window are
 * parameters — so staleness is a deterministic derivation, never a stored flag
 * that drifts out of date.
 */
export function isSessionStale(
  session: Session,
  now: number,
  staleAfterMs: number = DEFAULT_HEARTBEAT_STALE_AFTER_MS,
): boolean {
  return now - session.lastHeartbeatAt > staleAfterMs;
}

/** The {@link SessionLiveness} of `session` at `now` under the (injectable) stale window. */
export function sessionLiveness(
  session: Session,
  now: number,
  staleAfterMs: number = DEFAULT_HEARTBEAT_STALE_AFTER_MS,
): SessionLiveness {
  return isSessionStale(session, now, staleAfterMs) ? "stale" : "live";
}

/**
 * Explicit transition — apply a `worker_status` frame to a session. Returns a
 * NEW session with the derived {@link SessionActivity} and `lastActivityAt`
 * advanced to `now`. If `frame` is not a well-formed `worker_status` event the
 * session is returned unchanged (no transition). Pure: the input session is
 * never mutated, so applying a frame to one session cannot touch another.
 */
export function applyWorkerStatusFrame(session: Session, frame: ControlFrame, now: number = Date.now()): Session {
  const activity = sessionActivityFromFrame(frame);
  if (activity === null) {
    return session;
  }
  return { ...session, activity, lastActivityAt: now };
}

/**
 * Explicit transition — apply a {@link WorkerStatus} (from the §4/§5 `PUT …/worker`
 * status gate) to a session. Returns a NEW session with the derived
 * {@link SessionActivity} and `lastActivityAt` advanced to `now`. Pure: never
 * mutates the input, so one session's status cannot touch another's.
 */
export function applyWorkerStatus(
  session: Session,
  status: WorkerStatus,
  detail?: string,
  now: number = Date.now(),
): Session {
  return { ...session, activity: sessionActivityFromStatus(status, detail), lastActivityAt: now };
}

/**
 * Explicit transition — record a heartbeat. Returns a NEW session with
 * `lastHeartbeatAt` advanced to `now` (refreshing liveness); every other
 * dimension is untouched. Pure: never mutates the input, so one session's
 * heartbeat cannot touch another's.
 */
export function recordHeartbeat(session: Session, now: number = Date.now()): Session {
  return { ...session, lastHeartbeatAt: now };
}

/**
 * Explicit transition — advance a session's transport lifecycle to `ready` when the
 * worker's downstream event stream attaches (the session becomes steerable). Returns a
 * NEW `ready` session ONLY from `connecting`; any other {@link SessionStatus} is returned
 * UNCHANGED (no transition), so a re-attach on an already-advanced session — and a future
 * `busy` / `closed` / `errored` — is never clobbered. Only `status` moves; the orthogonal
 * activity / liveness dimensions are untouched. Pure: never mutates the input, so one
 * session's attach cannot touch another's. The reverse leg (`→ closed` / `errored` on
 * teardown / failure) is a separate transition.
 */
export function markSessionReady(session: Session): Session {
  if (session.status !== "connecting") {
    return session;
  }
  return { ...session, status: "ready" };
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
 * is a type error (#60) — while the loggable §1/§2 request bodies and responses,
 * the {@link SessionActivity} derived from a `worker_status` frame, and the
 * {@link Session} snapshot ARE JSON, provably free of the account credential.
 * (The {@link SessionIngressToken} is a branded string that legitimately travels
 * on the wire inside the {@link WorkSecret}; the {@link WorkItem} / {@link WorkSecret}
 * therefore carry a scoped credential and are deliberately NOT asserted loggable.)
 */
export type BridgeCredentialJsonProofs = [
  Assert<IsJson<AccountBearer> extends true ? false : true>,
  Assert<IsJson<EnvironmentRegisterRequestBody>>,
  Assert<IsJson<EnvironmentRegisterResponse>>,
  Assert<IsJson<SessionCreateRequestBody>>,
  Assert<IsJson<SessionCreateResponse>>,
  Assert<IsJson<SessionActivity>>,
  Assert<IsJson<Session>>,
];
