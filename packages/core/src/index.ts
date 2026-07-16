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

/**
 * The loopback hosts that are always permitted without a tunnel, in their exact
 * canonical spellings — the hostname `localhost` plus the two canonical literals.
 * {@link isLoopbackHost} ALSO accepts the rest of the IPv4 loopback block beyond
 * `127.0.0.1` (see there); this list is the named, exact-match core.
 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/**
 * Whether a host is a loopback host — one that never leaves the box, so it is always
 * permitted without a tunnel and is the only kind {@link https://ccctl | @ccctl/server}'s
 * `resolveBindHost` lets the daemon bind. Recognises the exact forms in
 * {@link LOOPBACK_HOSTS} PLUS the WHOLE IPv4 loopback block `127.0.0.0/8`
 * (RFC 1122 §3.2.1.3 — every `127.x.y.z`, not just `127.0.0.1`). `::1` is the IPv6
 * loopback in its canonical form; a non-canonical spelling fails closed, because the
 * bind guard that gates on this must over-refuse, never over-permit.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host) || isIpv4LoopbackHost(host);
}

/**
 * Whether `host` is a dotted-quad in the IPv4 loopback block `127.0.0.0/8`. Strict by
 * design: four decimal octets, each `0`–`255` with NO leading zeros (a leading-zero octet
 * is an octal-ambiguity footgun — `0177` is 127 read as octal but 177 read as a plain
 * integer), first octet exactly `127`. Anything else — `0.0.0.0`, a LAN or public address,
 * a partial form like `127.1`, a hostname — is not a loopback bind here. Fails CLOSED: an
 * ambiguous or non-canonical spelling is refused, never guessed into loopback, because the
 * caller that gates on it (the server bind guard) must never over-permit a bind.
 */
function isIpv4LoopbackHost(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }
  for (const octet of octets) {
    if (!/^(0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255) {
      return false;
    }
  }
  return octets[0] === "127";
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
// device pairing (QR onboarding #74) + device-token at-rest form (#84)
//
// Onboard a phone/tablet/laptop by scanning a terminal QR: the server mints a
// per-device token (`mintDeviceToken`, @ccctl/server), encodes it — together with
// the tunnel origin — into a pairing URL, and prints that URL as a QR. The scanned
// URL carries the token in its FRAGMENT, so it is applied client-side with no
// copy/paste and never reaches the server in the request line. The pure encode/redact
// contract lives here; the {@link DeviceTokenHash} brand below is the
// at-rest form #84 (W3-10) persists in place of the raw token, and the persisted
// {@link PairedDevice} record + {@link IDeviceStore} seam are the device-store
// contract at the end of this file. Server-side VERIFICATION of a presented token
// is a later credentialed-wave item — not introduced here.
// ---------------------------------------------------------------------------

/** Nominal brand for {@link DeviceToken}. */
declare const deviceTokenBrand: unique symbol;

/**
 * A per-device access token minted for QR-pair onboarding (#74) — the credential a
 * paired device presents to reach the tunnel-exposed UI, distinct per device and minted
 * server-side (@ccctl/server's `mintDeviceToken`). Branded so it cannot be confused with
 * an arbitrary string or another token family ({@link SessionIngressToken} /
 * {@link AccountBearer}), a compile-time distinctness — yet still a `string` because it
 * legitimately travels to the device inside the pairing QR / URL fragment.
 */
export type DeviceToken = string & {
  readonly [deviceTokenBrand]: never;
};

/**
 * Tag a raw string as a {@link DeviceToken}, failing closed on a blank one — an empty or
 * whitespace-only token is trivially not a secret, the same "blank is not configured"
 * treatment the local-server-auth guard applies. The single place a raw string becomes a
 * DeviceToken, so every DeviceToken in the system is non-blank by construction.
 */
export function deviceToken(value: string): DeviceToken {
  if (value.trim() === "") {
    throw new Error("ccctl: a device token must be a non-empty string");
  }
  return value as DeviceToken;
}

/** Nominal brand for {@link DeviceTokenHash}. */
declare const deviceTokenHashBrand: unique symbol;

/**
 * The at-rest form of a {@link DeviceToken}: a one-way hash of the minted secret, and the ONLY
 * projection of a device token that is safe to persist (#84). A {@link PairedDevice} stores
 * this, never the raw {@link DeviceToken} — so a leaked device store yields no usable
 * credential. Branded distinctly from {@link DeviceToken} so the two cannot be confused at a
 * type level: {@link PairedDevice.tokenHash} is a DeviceTokenHash, and a raw DeviceToken is NOT
 * assignable to it, which makes "persist the hash, never the token" a compile-time guarantee at
 * the field. Still a `string` (hence a {@link JsonValue}) because it legitimately rides a JSON
 * snapshot at rest.
 *
 * Producing the hash is runtime-coupled (a `node:crypto` digest), so it lives in @ccctl/server's
 * `hashDeviceToken` — the counterpart to `mintDeviceToken`; core owns only the brand and its
 * non-blank constructor, exactly as it owns {@link DeviceToken} while minting lives server-side.
 */
export type DeviceTokenHash = string & {
  readonly [deviceTokenHashBrand]: never;
};

/**
 * Tag a raw string as a {@link DeviceTokenHash}, failing closed on a blank one — a blank hash is
 * trivially not a digest, the same "blank is not configured" treatment {@link deviceToken}
 * applies. The single place a raw string becomes a DeviceTokenHash, so every DeviceTokenHash in
 * the system is non-blank by construction.
 */
export function deviceTokenHash(value: string): DeviceTokenHash {
  if (value.trim() === "") {
    throw new Error("ccctl: a device token hash must be a non-empty string");
  }
  return value as DeviceTokenHash;
}

/**
 * The URL-fragment parameter the pairing URL carries the {@link DeviceToken} in. A
 * FRAGMENT (`#…`), deliberately never a query (`?…`): the browser strips a fragment before
 * sending the request, so the token never rides the HTTP request line and therefore never
 * lands in the server's access log — the "never logged in plaintext" guarantee (#74). The
 * web UI reads it from `location.hash` on load (its own `pairing.js` pins the same literal).
 */
export const PAIRING_TOKEN_PARAM = "ccctl_token";

/** The placeholder {@link loggablePairingUrl} substitutes for the token when projecting a pairing URL to a loggable form. */
export const PAIRING_TOKEN_REDACTED = "REDACTED";

/**
 * Build the QR-pair onboarding URL a device scans: the tunnel-exposed origin with the
 * {@link DeviceToken} in the URL fragment ({@link PAIRING_TOKEN_PARAM}). `host` (+ optional
 * `port`) is the TUNNEL's reachable endpoint — never loopback, since the token is only ever
 * carried over the operator's own tunnel (#74) — and an IPv6 host is bracketed the one
 * canonical way ({@link formatAuthority}). The token rides the fragment so it is applied
 * client-side without a manual copy and never reaches the server in the request line;
 * `encodeURIComponent` keeps a URL-reserved character in the token from breaking the URL.
 * `scheme` defaults to `https` (a tunnel exposes TLS).
 */
export function buildPairingUrl(params: {
  readonly host: string;
  readonly port?: number;
  readonly token: DeviceToken;
  readonly scheme?: string;
}): string {
  const { host, port, token, scheme = "https" } = params;
  // With a port, delegate to the canonical authority formatter; without one, apply the same
  // IPv6-bracketing rule sans `:port` (a tunnel host is typically a MagicDNS name reached on 443).
  const authority = port === undefined ? (host.includes(":") ? `[${host}]` : host) : formatAuthority(host, port);
  return `${scheme}://${authority}/#${PAIRING_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Project a pairing URL to a loggable form: the fragment's token value is replaced with
 * {@link PAIRING_TOKEN_REDACTED}, everything else preserved — so an operator log or error that
 * echoes "the pairing URL" carries the origin and the parameter name but never the raw token
 * (#74). The QR is the only surface the token is meant to leave on; a URL with no pairing
 * fragment is returned unchanged. Matches the {@link loggableSessionCreateRequest} family: the
 * one projection from a secret-bearing value to a safe-to-log one.
 */
export function loggablePairingUrl(url: string): string {
  return url.replace(new RegExp(`(#${PAIRING_TOKEN_PARAM}=)[^&]*`), `$1${PAIRING_TOKEN_REDACTED}`);
}

// ---------------------------------------------------------------------------
// worker↔server transport: TLS certificate pinning (#59)
// ---------------------------------------------------------------------------

/** Nominal brand for {@link SpkiPin}. */
declare const spkiPinBrand: unique symbol;

/**
 * An SPKI certificate pin: the base64 SHA-256 of a certificate's DER-encoded
 * SubjectPublicKeyInfo — the RFC 7469 `pin-sha256` construction. The worker pins the
 * EXPECTED server public key by this value; a presented certificate is trusted iff its SPKI
 * pin is one of the pinned values ({@link certificatePinMatches}).
 *
 * Pinning the SPKI (the public KEY) rather than the whole certificate is what makes the pin
 * survive a leaf-certificate REISSUE with the same key — the reissued leaf carries the same
 * SubjectPublicKeyInfo, hence the same pin — while a KEY rotation deliberately changes it (a
 * new key ⇒ a new pin ⇒ a re-pin; see `docs/security-posture.md`, AC4). Branded so it cannot
 * be confused with an arbitrary string or another hash family (e.g. {@link DeviceTokenHash});
 * still a `string` (hence a {@link JsonValue}) because it legitimately rides configuration /
 * JSON at rest.
 *
 * Computing a pin from a key is a `node:crypto` digest, so it lives in @ccctl/server's
 * `computeSpkiPin` — the counterpart to `hashDeviceToken`; core owns only the brand, its
 * validating constructor, and the pure {@link certificatePinMatches} decision.
 */
export type SpkiPin = string & {
  readonly [spkiPinBrand]: never;
};

/**
 * Tag a raw string as a {@link SpkiPin}, failing closed on anything that is not a base64
 * SHA-256 digest (43 base64 characters + the single `=` that pads a 32-byte hash). A blank or
 * malformed pin is a misconfiguration, never a valid pin — the same "single place a raw string
 * becomes X, so every X is valid by construction" treatment {@link deviceTokenHash} applies.
 * Rejecting a malformed pin HERE means a typo in a pinned value fails LOUD at configuration
 * time, rather than silently as a never-matching pin that would reject every certificate.
 */
export function spkiPin(value: string): SpkiPin {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(
      "ccctl: an SPKI pin must be the base64 SHA-256 of a DER SubjectPublicKeyInfo (43 base64 chars + '=')",
    );
  }
  return value as SpkiPin;
}

/**
 * The pinning DECISION, pure and crypto-free: a presented server key (already reduced to its
 * {@link SpkiPin} by @ccctl/server's `computeSpkiPin`) is trusted iff it is one of `pinnedKeys`.
 * Plain set membership, deliberately NOT a constant-time compare — a pin is a hash of a PUBLIC
 * key, so there is no secret to protect from timing.
 *
 * Fails CLOSED on an empty `pinnedKeys`: pinning against no keys is a misconfiguration (it can
 * only mean "trust nothing", or — if misread — "trust everything"), so it throws rather than
 * silently rejecting or accepting. Supporting MULTIPLE pinned keys is exactly what gives a key
 * rotation its overlap window — pin both the outgoing and incoming keys, roll the server key,
 * then retire the old pin (`docs/security-posture.md`, AC4).
 */
export function certificatePinMatches(pinnedKeys: readonly SpkiPin[], presented: SpkiPin): boolean {
  if (pinnedKeys.length === 0) {
    throw new Error("ccctl: certificate pinning requires at least one pinned key");
  }
  return pinnedKeys.includes(presented);
}

// ---------------------------------------------------------------------------
// session / state model
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single steered Claude Code session.
 *
 * `registering` is the PRE-transport entry point, and the only status a session can hold
 * before a worker has ever spoken to the server (#33): a UC2 launch brought a terminal up
 * and is now waiting for the worker inside it to register over the bridge (§2). It exists so
 * a launched-but-not-yet-registered session is VISIBLE (the operator sees it coming up)
 * without being mistaken for a live one: it has no worker channel, so it cannot be STEERED
 * (a steer fails closed) and the whole §4 worker surface is shut to it. A UI may still SUBSCRIBE
 * to it — that is the point of showing the row, and the subscriber's stream is ended for them if
 * the session is evicted. It is transient by construction: the registration CLAIMS it (→ a fresh
 * `connecting` session on the same id), or the registration timeout EVICTS it. A session that
 * ccctl merely ATTACHED to (UC1) never passes through it — it is born `connecting` at
 * registration ({@link createSession}).
 *
 * **A `registering` session must never be RESTORED.** What bounds it is a live, in-process eviction
 * timer holding the handle of the terminal the launch spawned (`pending-launch.ts`), and neither
 * survives a restart. A `registering` row rehydrated from a persisted snapshot would therefore be
 * precisely the ghost this status exists to prevent: nothing can claim it (its worker is long gone)
 * and nothing is left to evict it. A session store must drop `registering` sessions — the status
 * marks work IN FLIGHT, not a state worth keeping.
 */
export type SessionStatus = "registering" | "connecting" | "ready" | "busy" | "closed" | "errored";

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
 *
 * Alongside the three transitioning dimensions is ONE static birth-property:
 * {@link Session.notificationsDegraded}, set once at attach from the observed
 * permission mode and never cleared. It is not a fourth dimension that moves —
 * it is a fixed fact about how the session was created.
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
  /**
   * Life-long attach-time marker: `true` when this session was created under a
   * non-prompting {@link PermissionMode} ({@link isNonPromptingPermissionMode}) —
   * the worker never blocks on a decision, so it never emits `requires_action`
   * and needs-you notifications are DEGRADED. Set ONCE at {@link createSession}
   * from the observed mode and never cleared: a running session's mode cannot
   * change, and every transition SPREADS the session, carrying it through
   * unchanged — so there is no mid-run path that clears it. A prompting session
   * (`default` / `plan`) carries `false`.
   */
  readonly notificationsDegraded: boolean;
  /** Epoch millis when the session was first registered. */
  readonly createdAt: number;
  /** Epoch millis of the most recent `worker_status` frame applied. */
  lastActivityAt: number;
  /** Epoch millis of the most recent heartbeat; drives liveness/staleness. */
  lastHeartbeatAt: number;
}

/**
 * Create a freshly-registered session: `connecting` lifecycle, `idle` activity,
 * its life-long {@link Session.notificationsDegraded} marker derived from
 * `permissionMode` (a non-prompting mode ⇒ degraded), and the heartbeat clock
 * started at `now` (registration is its first liveness signal). `permissionMode`
 * is the mode the session is created under — a birth parameter, since a running
 * session's mode cannot change. `now` is injectable so liveness/heartbeat timing
 * is deterministic under test — never a baked-in ambient clock.
 */
export function createSession(id: string, permissionMode: PermissionMode, now: number = Date.now()): Session {
  return {
    id,
    status: "connecting",
    activity: { kind: "idle" },
    notificationsDegraded: isNonPromptingPermissionMode(permissionMode),
    createdAt: now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
  };
}

/**
 * Create the PROVISIONAL session a UC2 launch places in the registry the moment its terminal
 * comes up — `registering` lifecycle, awaiting the worker's own bridge registration (§2, #33).
 * Identical birth to {@link createSession} — same id, same life-long
 * {@link Session.notificationsDegraded} marker derived from the mode the session was LAUNCHED
 * under, same clocks started at `now` — but entering the lifecycle one step EARLIER, so the
 * launched session is visible in the list from LAUNCH rather than only from registration.
 *
 * It is transient: the worker's registration claims it (the server replaces it with a
 * `connecting` {@link createSession} on the SAME id, so the list row advances in place rather
 * than duplicating), or the registration timeout evicts it. `now` is injectable for the same
 * determinism reason as {@link createSession}.
 */
export function createRegisteringSession(
  id: string,
  permissionMode: PermissionMode,
  now: number = Date.now(),
): Session {
  return { ...createSession(id, permissionMode, now), status: "registering" };
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

/**
 * The {@link PermissionMode}s under which the worker NEVER blocks on a decision —
 * it auto-proceeds — so it never emits a `requires_action` `worker_status`. A
 * session created under one of these has DEGRADED needs-you notifications: the
 * hub has nothing to surface as "needs attention" because the worker will never
 * ask. `acceptEdits` and `bypassPermissions` auto-accept; the PROMPTING
 * complement — `default` (prompts per decision) and `plan` (blocks awaiting plan
 * approval) — is deliberately absent. Pinned in one place, mirroring
 * {@link PERMISSION_MODES}; the two sets partition {@link PERMISSION_MODES}.
 */
export const NON_PROMPTING_PERMISSION_MODES: readonly PermissionMode[] = ["acceptEdits", "bypassPermissions"];

/**
 * Whether `mode` is non-prompting ({@link NON_PROMPTING_PERMISSION_MODES}) — i.e.
 * a mode whose session has degraded needs-you notifications (it never emits
 * `requires_action`). The attach-time input to a session's life-long
 * {@link Session.notificationsDegraded} marker.
 */
export function isNonPromptingPermissionMode(mode: PermissionMode): boolean {
  return NON_PROMPTING_PERMISSION_MODES.includes(mode);
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
 * Hard ceiling on a `requires_action` detail, in CODE POINTS. The detail is a ONE-LINE human
 * label — it shares a terminal row with the session id in `ccctl attach`, and rides every
 * `GET /api/sessions` response — so it is bounded rather than trusted to be short. The worker
 * can put arbitrary bytes here within the 1 MiB body cap; a 512 KB detail re-served on every
 * 2 s UI poll is not a label. 200 comfortably fits a real tool description ("Approve the edit to
 * packages/server/src/worker-channel.ts?") while keeping the row a row.
 */
export const MAX_REQUIRES_ACTION_DETAIL_LENGTH = 200;

/**
 * Unicode FORMAT characters (general category Cf) — zero-width, yet not inert: U+202E reorders
 * the text after it, U+200B pads a label invisibly, U+FEFF rides along as a stray BOM. Emoji
 * variation selectors are marks (Mn), not Cf, so they survive.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Unicode CONTROL characters (general category Cc) — exactly the C0 and C1 ranges: a newline,
 * tab, NUL, BEL, or the ESC that opens an ANSI/CSI escape sequence. Spelled as a property
 * escape rather than the equivalent character class, because a class spelling the range out
 * IS a control-character regex, which the `no-control-regex` lint rule rejects (rightly — it
 * catches the accidental ones), and no source in this repo suppresses a lint rule.
 */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Normalize a wire `detail` into ONE displayable line, or `undefined` when the frame said
 * nothing usable (absent, non-string, or nothing left once normalized).
 *
 * This is the trust boundary for the detail: the string is worker-supplied and this is the
 * single point where it enters the session model, so every consumer downstream — `ccctl
 * attach`'s one-line-per-session list, `GET /api/sessions`, the persisted snapshot, a future
 * "needs you" notification — inherits the guarantee rather than re-deriving it. Normalizing
 * here, not at each renderer, is what makes the guarantee hold for consumers not yet written.
 *
 * Three passes, in order:
 *  1. Zero-width FORMAT characters are dropped — a bidi override (U+202E) silently reorders the
 *     rest of the line, and a detail made only of zero-width characters would be "non-empty" yet
 *     invisible, which is not displayable.
 *  2. Control characters become spaces — a newline forges a session row in a line-oriented list,
 *     and the ESC opening an ANSI/CSI escape repaints or clears the operator's terminal. A space
 *     (not deletion) keeps `a\nb` reading as `a b` rather than `ab`.
 *  3. Whitespace runs collapse, and the result is clamped to
 *     {@link MAX_REQUIRES_ACTION_DETAIL_LENGTH} code points.
 */
function displayableDetail(detail: string | undefined): string | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }
  const flattened = detail.replace(FORMAT_CHARACTERS, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (flattened === "") {
    return undefined;
  }
  // Clamp by CODE POINT: `String.slice` counts UTF-16 code units, so it would cut a surrogate
  // pair in half and leave a lone surrogate as the last character of the label.
  const points = Array.from(flattened);
  return points.length > MAX_REQUIRES_ACTION_DETAIL_LENGTH
    ? `${points.slice(0, MAX_REQUIRES_ACTION_DETAIL_LENGTH - 1).join("")}…`
    : flattened;
}

/**
 * Resolve a `requires_action` human `detail` to a normalized single line, defaulting to
 * {@link DEFAULT_REQUIRES_ACTION_DETAIL} when the frame supplies none.
 */
function requiresActionDetail(detail: string | undefined): string {
  return displayableDetail(detail) ?? DEFAULT_REQUIRES_ACTION_DETAIL;
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
 * THE single source of the blocking "input-awaited / needs-you" signal (SRV-C-002, #40): a session
 * needs you when, and ONLY when, its {@link SessionActivity} is `requires_action`. That activity is
 * derived — through {@link sessionActivityFromStatus}, the choke point both the §5 event leg
 * ({@link applyWorkerStatusFrame}) and the §4 `PUT …/worker` gate ({@link applyWorkerStatus}) fold
 * through — from the `worker_status` feed and nothing else, so this predicate structurally CANNOT fire
 * from any other source. It reads one field of one worker-status-derived value; it has no way to see:
 *
 *   - **Stream silence / absence of output** — liveness is an ORTHOGONAL dimension keyed on
 *     {@link Session.lastHeartbeatAt} ({@link isSessionStale}). A quiet session goes *stale*, never
 *     `requires_action`; absence of frames leaves `activity` at whatever the last frame set (a fresh
 *     session is born `idle`, see {@link createSession}), so no output can *promote* a session here.
 *   - **A hook / progress event alone** — a hook is a non-`worker_status` {@link ControlEvent};
 *     {@link applyWorkerStatusFrame} is a no-op on it (the session, and thus its `activity`, is
 *     returned unchanged), so a hook cannot move a session into — or out of — the needs-you signal.
 *     Hooks may at most feed the SEPARATE informational class (idle > X, #41); they never feed this
 *     blocking one.
 *
 * Detail-agnostic: any `requires_action` fires it, whatever the human `detail` (the emitter, #43,
 * reads the detail for the message; whether the needs-you TRIGGER holds is decided HERE). This is the
 * single-DIMENSION trigger, not the whole fire decision: #43 still composes it with liveness and
 * lifecycle — a `requires_action` session that has since gone *stale* ({@link isSessionStale}) or
 * *closed* ({@link markSessionClosed}) must not notify. A session created under a non-prompting mode
 * never emits `requires_action` ({@link Session.notificationsDegraded}), so this naturally returns
 * `false` for it — no suppression gate needed. Keeping this one derivation single-sourced is what lets
 * #43 compose the notification without re-deriving (and possibly re-sourcing) the trigger.
 *
 * Returns a TYPE GUARD narrowing to the `requires_action` {@link SessionActivity} member, not a bare
 * `boolean`: the composing emitter (#43) branches on this predicate AND then reads the `detail` off the
 * same value for the notification message, so the guard hands it the narrowed member type-safely rather
 * than forcing a second, drift-prone `kind` re-check. Boolean-compatible, so existing conditional /
 * `expect(…)` callers are unaffected.
 */
export function isInputAwaited(
  activity: SessionActivity,
): activity is Extract<SessionActivity, { kind: "requires_action" }> {
  return activity.kind === "requires_action";
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

// --- on AC4's "monotonic by the frame's timestamp" (#39) ---
//
// The classification is per-session (every transition below is pure, and the server keys one
// map cell per session), but it is ordered by the server's RECEIPT of a frame, not by the
// frame's own age — because the wire carries no frame age to order by. A `worker_status`
// rides either the §4 `PUT …/worker` body (`{ worker_status, worker_epoch,
// external_metadata }`) or a §5 {@link ControlEvent} (`{ type, subtype, payload }`); neither
// carries a timestamp or a sequence number, and `worker_epoch` orders REGISTRATIONS, not the
// frames within one.
//
// A guard comparing a server-read clock against `lastActivityAt` was tried and removed: reads
// taken at apply time on a single-threaded event loop are non-decreasing by construction, so
// it could never fire in production — while `Date.now()` is wall-clock, so one backward NTP
// step made it refuse EVERY frame until real time caught up, silently swallowing the
// `requires_action` that the notification wave exists to deliver.
//
// So: last-write-wins in receipt order, which is the only order the server can observe.
// Detecting a genuinely stale frame needs the emitter to stamp one (a sequence number or a
// timestamp) — a protocol change, since the emitter is the patched worker. Tracked in #201
// rather than approximated here.

/**
 * The `requires_action` detail already captured for this session, when the incoming frame
 * supplies none — otherwise `undefined`, leaving {@link DEFAULT_REQUIRES_ACTION_DETAIL} to apply.
 *
 * The §4 `PUT …/worker` status gate reports a BARE status: its body has no detail field at
 * all. The rich human detail rides the §5 `worker/events` leg. So a §4 re-affirmation of
 * `requires_action` would otherwise degrade the tool description §5 captured back to the
 * generic default, and the notification that reads it (#43) would never name the actual
 * tool. Supplying no detail is not a statement that the detail is unknown — it is no
 * statement at all, so the last one that WAS stated stands.
 *
 * Scoped to a `requires_action` → `requires_action` re-affirmation: any other status means
 * the session moved on, so the question the detail named is gone and must not be resurrected.
 */
function capturedRequiresActionDetail(session: Session, status: WorkerStatus): string | undefined {
  return status === "requires_action" && session.activity.kind === "requires_action"
    ? session.activity.detail
    : undefined;
}

/**
 * Explicit transition — apply a `worker_status` frame to a session (the §5 `worker/events`
 * leg, where the RICH frame carrying a human `detail` rides). Returns a NEW session with the
 * derived {@link SessionActivity} and `lastActivityAt` advanced to `now`. A frame that is not
 * a well-formed `worker_status` event returns the session unchanged (no transition). Pure:
 * the input session is never mutated, so applying a frame to one session cannot touch another.
 */
export function applyWorkerStatusFrame(session: Session, frame: ControlFrame, now: number = Date.now()): Session {
  if (!isWorkerStatusEvent(frame)) {
    return session;
  }
  return applyWorkerStatus(session, frame.payload.status, frame.payload.detail, now);
}

/**
 * Explicit transition — apply a {@link WorkerStatus} to a session. The single choke point
 * every status application flows through: the §4 `PUT …/worker` gate calls it with a bare
 * status, and {@link applyWorkerStatusFrame} folds a §5 frame through it, so the detail's
 * normalization and carry-forward hold on BOTH legs from one place.
 *
 * Returns a NEW session with the derived {@link SessionActivity} and `lastActivityAt`
 * advanced to `now`. An absent `detail` on a `requires_action` re-affirmation keeps the one
 * already captured ({@link capturedRequiresActionDetail}). Applications are last-write-wins in
 * receipt order — see the note above on why frame-age ordering is not enforced here. Pure:
 * never mutates the input, so one session's status cannot touch another's.
 */
export function applyWorkerStatus(
  session: Session,
  status: WorkerStatus,
  detail?: string,
  now: number = Date.now(),
): Session {
  const resolved = displayableDetail(detail) ?? capturedRequiresActionDetail(session, status);
  return { ...session, activity: sessionActivityFromStatus(status, resolved), lastActivityAt: now };
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

/**
 * Explicit transition — drive a session's transport lifecycle to its TERMINAL `closed`
 * state (the reverse leg of {@link markSessionReady}), applied when the worker has
 * terminally exited and the session is being torn down. Returns a NEW `closed` session
 * from any NON-terminal status — it is a blocklist, not an allowlist, so a `registering`
 * session closes too (its terminal is real even before its worker checks in); an ALREADY-terminal
 * session (`closed` / `errored`) is returned UNCHANGED (same reference) — a terminal state never
 * moves, so re-closing is a no-op and a distinct `errored` is never clobbered to `closed`.
 * Only `status` moves; the orthogonal activity / liveness dimensions are untouched. Pure:
 * never mutates the input, so one session's teardown cannot touch another's.
 */
export function markSessionClosed(session: Session): Session {
  if (session.status === "closed" || session.status === "errored") {
    return session;
  }
  return { ...session, status: "closed" };
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

// ---------------------------------------------------------------------------
// structured logging — the loggable event contract (#61 / SRV-Q-002)
//
// The hub is a long-lived daemon, and its two failure modes are silent: a STALLED
// session (stuck awaiting a worker that never answers, or gone stale mid-run) and a
// LEAKED one (created, never closed, holding a `maxSessions` slot forever). Diagnosing
// either needs a structured TRAIL of what each
// session did — born, advanced, went stale, closed — alongside the bridge
// registrations, the worker-status transitions, the needs-you / idle notifications, and
// the refusals around them. Those are the five AUTOMATIC surfaces this section names; #62
// adds a sixth — the on-demand DIAGNOSTIC surface (a live, operator-triggered heap snapshot).
//
// This defines the CONTRACT for that trail and nothing else: the JSON-safe loggable
// event SHAPES ({@link LogEvent}) plus the {@link Logger} sink interface and a no-op. A
// concrete sink (a JSON-line writer over `console`) is host-adjacent OUTPUT and ships in
// `@ccctl/server`, exactly as the file session store does; `@ccctl/core` stays
// runtime-agnostic (CORE-C-001) — pure types + a sink that drops everything.
//
// **Redaction by construction (HARD, #61).** Every {@link LogEvent} variant is built only
// from {@link JsonValue}-safe fields, so the account OAuth Bearer — an {@link AccountBearer},
// which is NOT a JSON value — cannot reach a log line by construction: a leak is a `tsc`
// error, enforced by {@link LogEventJsonProofs} below, exactly as {@link BridgeCredentialJsonProofs}
// forbids it reaching a snapshot. The scoped {@link SessionIngressToken} (and the work
// `secret` that carries it) is a JSON-safe branded string, so — like the session store's
// ingress token and the device store's token — that proof does NOT by itself exclude it; it
// stays out because NO variant carries a field for it (omission by construction), guarded at
// runtime by the e2e bearer canary and the server's own redaction test. The loggable shapes
// carry IDs, statuses, activity kinds, and one-line human detail — never a credential.
// ---------------------------------------------------------------------------

/** Severity of a structured {@link LogEvent}. */
export type LogLevel = "info" | "warn" | "error";

/**
 * The six diagnostic surfaces a structured {@link LogEvent} belongs to: the five AUTOMATIC ones
 * the lifecycle turns on (#61) — a session's LIFECYCLE, the bridge REGISTRATION legs (§1/§2/§3),
 * worker-status DETECTION transitions, NOTIFICATION dispatch (needs-you / idle), and ERROR
 * refusals — plus the on-demand DIAGNOSTIC surface (#62, #63), operator-triggered runtime actions
 * (a live heap snapshot; an inspector attach + FD/handle-count report). The `category` discriminates
 * the union so a sink can route or filter by surface.
 */
export type LogEventCategory = "session" | "registration" | "detection" | "notification" | "error" | "diagnostic";

/**
 * A session LIFECYCLE event (#61): the trail that answers "was this session leaked?" — a `created`
 * row that never reaches a `closed`/`evicted` is a held slot. `status` is the {@link SessionStatus}
 * AFTER the event; `detail` carries one-line human context (the prior status on a transition, or WHY
 * a row was evicted) and never a credential.
 */
export interface SessionLogEvent {
  readonly category: "session";
  readonly level: LogLevel;
  /** `created` (a row is born), `status` (a lifecycle transition), `closed` (a clean terminal), `evicted` (reaped without a clean close). */
  readonly event: "created" | "status" | "closed" | "evicted";
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly detail: string;
}

/**
 * A bridge REGISTRATION event (#61): the §1 environment register, the §2 session create, and the §3
 * work delivery. `sessionId` is `null` on the §1 leg (no session exists yet). `detail` carries the
 * delivered work item's id and type on §3 — NEVER the work `secret`, which encodes the
 * {@link SessionIngressToken}.
 */
export interface RegistrationLogEvent {
  readonly category: "registration";
  readonly level: LogLevel;
  /** `environment-registered` (§1), `session-created` (§2), `work-delivered` (§3 poll answered). */
  readonly event: "environment-registered" | "session-created" | "work-delivered";
  readonly environmentId: string;
  readonly sessionId: string | null;
  readonly detail: string;
}

/**
 * A worker-status DETECTION event (#61): the trail that answers "is this session stalled?" — an
 * `activity` transition (running / requires_action / idle), a `worker-registered` generation attach,
 * or a `stale` heartbeat lapse. `activity` is the session's {@link SessionActivity} kind the event
 * reflects; `detail` carries the transition ("running→idle"), the worker epoch, or the stale gap.
 */
export interface DetectionLogEvent {
  readonly category: "detection";
  readonly level: LogLevel;
  /** `activity` (a `worker_status` transition), `worker-registered` (a worker generation attached), `stale` (heartbeat lapsed). */
  readonly event: "activity" | "worker-registered" | "stale";
  readonly sessionId: string;
  readonly activity: SessionActivity["kind"];
  readonly detail: string;
}

/**
 * A NOTIFICATION dispatch event (#61): the blocking `awaiting-input` needs-you (#43) or the
 * informational `idle` nudge (#41), each naming the session it concerns. `detail` carries the
 * awaited-input label or the idle threshold.
 */
export interface NotificationLogEvent {
  readonly category: "notification";
  readonly level: LogLevel;
  /** `awaiting-input` (the blocking needs-you, #43), `idle` (the informational "idle > X" nudge, #41). */
  readonly event: "awaiting-input" | "idle";
  readonly sessionId: string;
  readonly detail: string;
}

/**
 * An ERROR event (#61): a refusal or failure worth a trail — a rejected bind, a boot rejected for a
 * bad config, a failed listen, a refused or failed launch (e.g. at-capacity), a failed stop. `event`
 * is a short stable slug ("bind-refused", "boot-rejected", "listen-failed", "launch-failed",
 * "stop-failed"); `sessionId` is `null` for a daemon-wide refusal (bind, boot, listen) that concerns
 * no one session. `detail` is the actionable one-line reason — never a credential. (A missing-auth
 * refuse-to-start is caught at the CLI edge before the server's logger exists, so it is not one of
 * these — it fails the process with a non-zero exit, not a structured line.)
 */
export interface ErrorLogEvent {
  readonly category: "error";
  readonly level: "warn" | "error";
  readonly event: string;
  readonly sessionId: string | null;
  readonly detail: string;
}

/**
 * A DIAGNOSTIC event (#62, #63): an operator-triggered runtime diagnostic action the daemon
 * performed on demand — taken live (no restart) when the daemon is signalled, for chasing a long-run
 * leak. Unlike the five AUTOMATIC surfaces above, a diagnostic event fires ONLY when an operator
 * explicitly asks. Three families ride this category:
 *
 * - **Heap snapshot (#62), on `SIGUSR2`** — `heap-snapshot` on a written snapshot (`detail` = its
 *   PATH), `heap-snapshot-failed` on a failed attempt (`detail` = the one-line reason).
 * - **Inspector attach (#63), on `SIGUSR1`** — `inspector-open` when the Node inspector is open for
 *   deeper diagnosis (`detail` = its loopback `ws://` URL), `inspector-open-failed` when it could not
 *   be opened (`detail` = the reason).
 * - **FD/handle-count report (#63), on `SIGUSR1`** — `handle-report` naming the current active
 *   libuv resource (file-descriptor / handle) counts for leak-vector visibility (`detail` = a compact
 *   `total — type=count, …` tally), `handle-report-failed` on a failed sample (`detail` = the reason).
 *
 * `sessionId` is always `null` — a diagnostic is daemon-wide, concerning no one session. `detail`
 * never carries a credential: a path, a loopback inspector URL, or a resource-count tally — never an
 * {@link AccountBearer} or {@link SessionIngressToken}. (The heap-snapshot FILE holds a copy of
 * process memory, so it is written owner-only `0600`; this log line names only its path. The
 * inspector binds LOOPBACK and is reachable only by a same-uid local process — the signal trigger's
 * OS-level authorization is the "local auth" the diagnostic surface holds to.)
 */
export interface DiagnosticLogEvent {
  readonly category: "diagnostic";
  readonly level: LogLevel;
  /**
   * `heap-snapshot` / `heap-snapshot-failed` (a live heap snapshot, #62); `inspector-open` /
   * `inspector-open-failed` (the Node inspector attach, #63); `handle-report` / `handle-report-failed`
   * (the FD/handle-count report, #63).
   */
  readonly event:
    | "heap-snapshot"
    | "heap-snapshot-failed"
    | "inspector-open"
    | "inspector-open-failed"
    | "handle-report"
    | "handle-report-failed";
  readonly sessionId: null;
  readonly detail: string;
}

/**
 * A single structured log event — one line in the daemon's diagnostic trail (#61, #62). The
 * discriminated union of the six {@link LogEventCategory} surfaces; every variant is a {@link JsonObject} by
 * construction (proven by {@link LogEventJsonProofs}), so it serializes to one JSON log line AND —
 * since no variant carries an {@link AccountBearer} field — provably cannot leak the account credential.
 */
export type LogEvent =
  | SessionLogEvent
  | RegistrationLogEvent
  | DetectionLogEvent
  | NotificationLogEvent
  | ErrorLogEvent
  | DiagnosticLogEvent;

/**
 * The structured-log sink (#61): the ONE way a {@link LogEvent} leaves the domain. An injected
 * function seam, like every other host-touching edge in this codebase ({@link ISessionStore}, the
 * launcher) — `@ccctl/core` defines the interface and a no-op; `@ccctl/server` supplies a concrete
 * JSON-line writer, and a test a capturing fake. `log` takes only a {@link LogEvent}, so a caller
 * CANNOT hand the sink a raw credential — the type IS the redaction boundary.
 */
export interface Logger {
  log(event: LogEvent): void;
}

/**
 * The sink that drops every event (#61) — the default when a server is configured without a
 * {@link Logger}, mirroring how an absent launcher disables launching. A single shared stateless
 * instance: a test or an embedder that wants a quiet server gets one; a daemon wanting a trail
 * injects a real writer instead.
 */
export const NO_OP_LOGGER: Logger = { log: () => undefined };

/**
 * The compile-time redaction contract for the log trail (#61), exported so it has a referent and is
 * therefore evaluated (not dropped as unused). Each element proves one loggable shape is
 * {@link JsonValue}-safe — hence carries no {@link AccountBearer} (a non-JSON class, so a leaked
 * Bearer field is a `tsc` error), the same guarantee {@link BridgeCredentialJsonProofs} draws for the
 * wire/snapshot shapes. Each VARIANT is asserted individually, not only the union: `IsJson` over a
 * union checks only the keys COMMON to every member, so a variant-specific field (a `status`, an
 * `activity`, an `environmentId`) is proven JSON-safe only by asserting that variant on its own.
 */
export type LogEventJsonProofs = [
  Assert<IsJson<SessionLogEvent>>,
  Assert<IsJson<RegistrationLogEvent>>,
  Assert<IsJson<DetectionLogEvent>>,
  Assert<IsJson<NotificationLogEvent>>,
  Assert<IsJson<ErrorLogEvent>>,
  Assert<IsJson<DiagnosticLogEvent>>,
  Assert<IsJson<LogEvent>>,
];

// ---------------------------------------------------------------------------
// session-store persistence — the runtime-agnostic persistence seam (W3-03)
//
// The hub holds its live state in memory: the session registry (every
// {@link Session} it tracks) and the per-session *unread queue* (activity the
// operator has not yet seen). Once more than a couple of sessions exist, losing
// all of that to a daemon restart is a real regression — so the state needs a
// persistence seam. This section defines the CONTRACT for that seam and nothing
// else: the JSON-safe on-disk *shape* ({@link SessionStoreSnapshot}) plus the
// {@link ISessionStore} load/save interface. A concrete backend (a single-file
// `0600` JSON snapshot at an XDG state path) is deliberately NOT here — it is
// Node-coupled I/O and ships in `@ccctl/server` (#23); a SQLite backend, should
// it ever land, is another interface-isolated implementation. `@ccctl/core`
// stays runtime-agnostic (CORE-C-001): pure types + `Promise`, no `fs`, no
// `node:*`.
//
// **No secrets at rest (HARD, #23/SRV-C-007).** The persisted shape is built
// only from types that are provably {@link JsonValue}-safe, so the account
// {@link AccountBearer} — NOT a JSON value (a class with methods, not data) —
// cannot reach a snapshot by construction: a leak is a `tsc` error, enforced at
// compile time by {@link SessionStorePersistenceProofs} below, not a reviewer
// miss. The scoped {@link SessionIngressToken} is a JSON-safe branded string, so
// the proof does NOT exclude it; it stays out of a snapshot because the persisted
// types ({@link Session}, {@link UnreadEntry}) carry no such field — the same
// distinction {@link BridgeCredentialJsonProofs} draws.
// ---------------------------------------------------------------------------

/**
 * The schema version stamped into every {@link SessionStoreSnapshot}. A backend
 * that reads a snapshot whose `version` differs can fail closed (or migrate)
 * rather than silently mis-read an older shape — the same pin-and-fail-closed
 * posture the wire contract takes ({@link BRIDGE_PROTOCOL_API_VERSION},
 * {@link WORK_SECRET_VERSION}). Bumping it is a deliberate, reviewed change.
 *
 * `2` (was `1`): {@link Session} gained the life-long `notificationsDegraded`
 * marker (#26), changing the persisted registry shape — so a pre-#26 `version: 1`
 * snapshot, whose sessions lack the field, is fail-closed on load rather than
 * loaded as a `Session` with an `undefined` marker.
 *
 * `3` (was `2`): {@link UnreadEntry} gained the required `eventId` — the per-session
 * SSE `Last-Event-ID` the needs-you was broadcast under, which the unread-queue
 * reconcile (#47) orders and acknowledges by. A pre-#47 `version: 2` snapshot, whose
 * unread entries lack the field, is fail-closed on load rather than loaded as an entry
 * with an `undefined` order/ack key. The store is "safe to lose" state, so the
 * one-time hard stop on upgrade is the correct cost of a clean shape.
 */
export const SESSION_STORE_SNAPSHOT_VERSION = 3;

/**
 * A single unread marker: a per-session {@link SessionActivity} the operator has
 * not yet seen, held in the hub's unread *queue* (reconciled in {@link UnreadEntry.eventId}
 * order on reconnect, #47).
 * This is the persisted FACE of an unread notification — the minimal signal
 * needed to re-render "session X needs attention" after a restart — not a full
 * notification/dismissal model (that behaviour lives above this seam).
 *
 * Every field is {@link JsonValue}-safe (proven by {@link SessionStorePersistenceProofs}),
 * so an entry survives a JSON snapshot round-trip unchanged and can carry no
 * account credential.
 */
export interface UnreadEntry {
  /** The {@link Session.id} this unread marker belongs to. */
  readonly sessionId: string;
  /**
   * The per-session SSE `Last-Event-ID` (the monotonic event-stream cursor, from 1)
   * the unseen activity was broadcast under. The unread-queue reconcile (#47) ORDERS a
   * session's entries by it and ACKNOWLEDGES an entry by it: it is the client's own
   * cursor handle onto the event, so a reconnecting client acks exactly what it saw.
   * Distinct from {@link UnreadEntry.at} (wall-clock provenance): a strict per-session
   * total order, not a timestamp that can tie within a millisecond.
   */
  readonly eventId: number;
  /** Epoch millis when the activity became unread — wall-clock provenance for display. */
  readonly at: number;
  /**
   * The unseen {@link SessionActivity} (e.g. `requires_action` — the worker is
   * waiting on the operator). Reuses the derived session activity so the unread
   * queue and the live registry speak one vocabulary.
   */
  readonly activity: SessionActivity;
}

/**
 * The complete persisted hub state — everything an {@link ISessionStore} loads
 * on daemon start and saves on change, as ONE JSON-safe snapshot:
 *
 *   - {@link SessionStoreSnapshot.sessions} — the session registry.
 *   - {@link SessionStoreSnapshot.unread} — the unread queue.
 *
 * The whole shape is {@link JsonValue}-safe by construction (proven by
 * {@link SessionStorePersistenceProofs}): it round-trips through JSON unchanged
 * and provably carries no account credential.
 */
export interface SessionStoreSnapshot {
  /** Snapshot schema version; see {@link SESSION_STORE_SNAPSHOT_VERSION}. */
  readonly version: number;
  /** The session registry — every {@link Session} the hub tracks. */
  readonly sessions: readonly Session[];
  /** The unread queue — unseen per-session activity, reconciled in {@link UnreadEntry.eventId} order (#47). */
  readonly unread: readonly UnreadEntry[];
}

/**
 * The persistence seam for the hub's state: load the last {@link SessionStoreSnapshot}
 * on start, save it on change. Runtime-agnostic by design — the interface names
 * no I/O primitive, so a backend is free to be a single-file JSON snapshot
 * (`@ccctl/server`, #23), a SQLite database, or an in-memory fake in a test.
 *
 * **Round-trip contract.** For any snapshot `s`, `await store.save(s)` followed
 * by `await store.load()` yields a snapshot deep-equal to `s` — the shape is
 * JSON-safe, so a serialising backend preserves it exactly. A backend that has
 * never been saved to returns `null` from {@link ISessionStore.load}: absence is
 * `null`, never a fabricated empty snapshot, so a caller can tell "fresh daemon"
 * from "explicitly-saved empty state".
 *
 * Both operations are async so a backend may do real I/O; `@ccctl/core` awaits
 * the contract, never a concrete runtime.
 */
export interface ISessionStore {
  /**
   * Load the most recently saved snapshot, or `null` if nothing has ever been
   * saved (a fresh daemon with no prior state).
   */
  load(): Promise<SessionStoreSnapshot | null>;
  /** Persist `snapshot` as the current hub state, replacing any prior snapshot. */
  save(snapshot: SessionStoreSnapshot): Promise<void>;
}

/**
 * Compile-time proof (erased at build) that the entire persisted shape is
 * {@link JsonValue}-safe — so the account {@link AccountBearer}, which is NOT a
 * JSON value, cannot reach a snapshot by construction (#23's "no secrets at
 * rest"), and every snapshot round-trips through JSON unchanged (the
 * {@link ISessionStore} round-trip contract). The scoped {@link SessionIngressToken}
 * is a JSON-safe string the proof does NOT exclude; it is absent from a snapshot
 * because the persisted types carry no such field — the same distinction
 * {@link BridgeCredentialJsonProofs} draws, which this mirrors. Exported so it has
 * a referent (and is therefore evaluated, not dropped as unused); if any assertion
 * breaks, `tsc` fails.
 */
export type SessionStorePersistenceProofs = [Assert<IsJson<UnreadEntry>>, Assert<IsJson<SessionStoreSnapshot>>];

// ---------------------------------------------------------------------------
// device-store persistence — the paired-device registry seam (#84 / W3-10)
//
// #74 mints a per-device token and prints it as a pairing QR; this section
// defines the CONTRACT for persisting the devices that pairing produces, so one
// operator can manage several paired devices (phone, tablet, laptop) across a
// daemon restart. Like the session-store seam above, it is contract-only: the
// JSON-safe on-disk shape ({@link PairedDevice}, {@link DeviceStoreSnapshot}), the
// {@link IDeviceStore} load/save interface, and the pure record transforms
// ({@link pairedDevice} / {@link renameDevice} / {@link touchDevice}). The concrete
// backend (a single-file `0600` JSON snapshot at an XDG state path) is Node-coupled
// I/O and ships in `@ccctl/server`, exactly as the file session store does; core
// stays runtime-agnostic (CORE-C-001).
//
// **No plaintext token at rest (HARD, AC1).** A {@link PairedDevice} carries a
// {@link DeviceTokenHash} — the one-way hash of the minted secret — and has NO field
// for the raw {@link DeviceToken}: the token is omitted by construction, so a
// snapshot cannot carry it. The compile-time {@link DeviceStorePersistenceProofs}
// below prove the shape is {@link JsonValue}-safe (it round-trips), but — exactly as
// with the session store's {@link SessionIngressToken} — a DeviceToken is ITSELF a
// JSON-safe branded string, so that proof does NOT by itself exclude it; the
// omission-by-construction (no token field) plus a runtime at-rest grep in the server
// backend's suite are what guarantee "never in plaintext at rest".
//
// **One auth model (AC3).** This is the paired-device REGISTRY, not a second auth
// path: it persists device records and their token HASHES for a future
// credentialed-wave verifier to consult, and introduces no request-authorization of
// its own — the account-level mandatory local-server auth (security-posture.md) is
// untouched.
// ---------------------------------------------------------------------------

/**
 * The schema version stamped into every {@link DeviceStoreSnapshot}. A backend that
 * reads a snapshot whose `version` differs fails closed rather than silently mis-reading
 * an older shape — the same pin-and-fail-closed posture
 * {@link SESSION_STORE_SNAPSHOT_VERSION} takes. Bumping it is a deliberate, reviewed change.
 */
export const DEVICE_STORE_SNAPSHOT_VERSION = 1;

/**
 * A single paired device (#84): the persisted record for one device an operator has
 * onboarded via QR pairing (#74) — everything needed to LIST and NAME a device, and
 * never the raw credential.
 *
 * Every field is {@link JsonValue}-safe (proven by {@link DeviceStorePersistenceProofs}),
 * so a record survives a JSON snapshot round-trip unchanged. The {@link DeviceTokenHash} is
 * the ONLY projection of the device token that is persisted — the raw {@link DeviceToken}
 * has no field here, so it cannot reach a snapshot (AC1). All fields are `readonly`: the
 * pure transforms below produce a NEW record rather than mutating in place.
 */
export interface PairedDevice {
  /** Stable device identity, assigned once at pairing and never reused — the list/rename key. */
  readonly id: string;
  /** Human-readable device name ("Alex's phone"), set at pairing and mutable via {@link renameDevice}. */
  readonly name: string;
  /** Epoch millis when the device was paired. */
  readonly createdAt: number;
  /** Epoch millis of the device's most recent activity; advanced by {@link touchDevice}. */
  readonly lastSeen: number;
  /**
   * The one-way hash of the device's minted {@link DeviceToken} (@ccctl/server's
   * `hashDeviceToken`), persisted in place of the secret so the store carries no usable
   * credential at rest (AC1). A future credentialed-wave verifier hashes a presented token
   * and compares it against this.
   */
  readonly tokenHash: DeviceTokenHash;
}

/** Normalise + validate a human-readable device name, failing closed on a blank one. */
function requireDeviceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("ccctl: a device name must be a non-empty string");
  }
  return trimmed;
}

/**
 * Create a freshly-paired device record (#84): `createdAt` and `lastSeen` both start at `now`
 * (pairing is the first time the device is seen), carrying the caller-assigned `id`, `name`,
 * and the already-hashed {@link DeviceTokenHash}. Pure and `now`-injectable so a test is
 * deterministic — the same birth-parameter idiom as {@link createSession}. Server-side, the
 * `id` and `tokenHash` are produced with `node:crypto` (`randomUUID` + `hashDeviceToken`) and
 * handed to this pure constructor. The `name` is trimmed and fails closed when blank — a blank
 * human-readable name is not a name (the same "blank is not configured" guard
 * {@link deviceToken} applies).
 */
export function pairedDevice(params: {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: DeviceTokenHash;
  readonly now?: number;
}): PairedDevice {
  const { id, name, tokenHash, now = Date.now() } = params;
  return { id, name: requireDeviceName(name), createdAt: now, lastSeen: now, tokenHash };
}

/**
 * Rename a paired device (AC2), returning a NEW record with the updated
 * {@link PairedDevice.name} and every other field — `id`, `createdAt`, `lastSeen`, and the
 * {@link DeviceTokenHash} — preserved. Pure: never mutates the input, so one device's rename
 * cannot touch another's. Trims and fails closed on a blank name, the same guard
 * {@link pairedDevice} applies, so a rename can never blank out a device's name.
 */
export function renameDevice(device: PairedDevice, name: string): PairedDevice {
  return { ...device, name: requireDeviceName(name) };
}

/**
 * Mark a paired device as just-seen (updates {@link PairedDevice.lastSeen} to `now`),
 * returning a NEW record with every other field preserved. Pure and `now`-injectable, the
 * same idiom as {@link recordHeartbeat} for a session. `lastSeen` is what the device list
 * (AC4) surfaces so an operator can tell an active device from a long-idle one.
 */
export function touchDevice(device: PairedDevice, now: number = Date.now()): PairedDevice {
  return { ...device, lastSeen: now };
}

/**
 * The complete persisted paired-device registry (#84) — every {@link PairedDevice} the hub
 * tracks, as ONE JSON-safe snapshot an {@link IDeviceStore} loads on start and saves on
 * change. Listing all currently-paired devices (AC4) is reading
 * {@link DeviceStoreSnapshot.devices}.
 *
 * The whole shape is {@link JsonValue}-safe by construction (proven by
 * {@link DeviceStorePersistenceProofs}): it round-trips through JSON unchanged and — since a
 * {@link PairedDevice} carries a {@link DeviceTokenHash} and no raw token — provably carries no
 * plaintext device credential.
 */
export interface DeviceStoreSnapshot {
  /** Snapshot schema version; see {@link DEVICE_STORE_SNAPSHOT_VERSION}. */
  readonly version: number;
  /** The paired-device registry — every {@link PairedDevice} the hub tracks. */
  readonly devices: readonly PairedDevice[];
}

/**
 * Revoke a single paired device (#81 / W6-19), returning a NEW {@link DeviceStoreSnapshot} with
 * the device whose {@link PairedDevice.id} is `id` removed and EVERY other device — and the
 * snapshot `version` — preserved unchanged. This is the invalidation primitive behind per-device
 * revoke: dropping the record drops the {@link DeviceTokenHash} that is the token's ONLY at-rest
 * projection (a {@link PairedDevice} persists the hash, never the raw {@link DeviceToken}), so a
 * hash-and-compare verifier — the credentialed-wave ingress guard that hashes a presented token
 * ({@link https://ccctl | @ccctl/server}'s `hashDeviceToken`) and looks it up here — finds no
 * match and refuses that token on its next use (AC1), while the untouched records keep every
 * other device working (AC2): one operator loses a lost phone, not their tablet and laptop.
 *
 * Pure — never mutates the input snapshot or its records, so revoking one device provably cannot
 * touch another's (the same non-mutating discipline {@link renameDevice} / {@link touchDevice}
 * keep; `filter` builds a fresh array and the surviving records ride through by reference,
 * unchanged). Order-preserving. Idempotent over an absent id: revoking an id no device carries
 * returns an equal (freshly built) snapshot rather than throwing — "revoke this device" and
 * "this device is already gone" share the same desired end state, so a double-revoke (or one
 * racing a concurrent one) is a no-op, never an error. A revoke is persisted the same way any
 * snapshot change is — {@link IDeviceStore.save} of the returned snapshot — so it needs no new
 * store primitive.
 */
export function revokeDevice(snapshot: DeviceStoreSnapshot, id: string): DeviceStoreSnapshot {
  return { ...snapshot, devices: snapshot.devices.filter((device) => device.id !== id) };
}

/**
 * The persistence seam for the paired-device registry: load the last
 * {@link DeviceStoreSnapshot} on start, save it on change. Runtime-agnostic by design — the
 * interface names no I/O primitive, so a backend is free to be a single-file JSON snapshot
 * (`@ccctl/server`), a database, or an in-memory fake in a test. Mirrors {@link ISessionStore}.
 *
 * **Round-trip contract.** For any snapshot `s`, `await store.save(s)` then
 * `await store.load()` yields a snapshot deep-equal to `s`. A backend that has never been
 * saved to returns `null` from {@link IDeviceStore.load}: absence is `null`, never a
 * fabricated empty registry — so a caller can tell "no device ever paired" from
 * "explicitly-saved empty registry".
 */
export interface IDeviceStore {
  /** Load the most recently saved snapshot, or `null` if nothing has ever been saved. */
  load(): Promise<DeviceStoreSnapshot | null>;
  /** Persist `snapshot` as the current paired-device registry, replacing any prior snapshot. */
  save(snapshot: DeviceStoreSnapshot): Promise<void>;
}

/**
 * Compile-time proof (erased at build) that the entire persisted paired-device shape is
 * {@link JsonValue}-safe — so every snapshot round-trips through JSON unchanged (the
 * {@link IDeviceStore} round-trip contract). As with {@link SessionStorePersistenceProofs}, a
 * {@link DeviceTokenHash} is a JSON-safe branded string the proof does NOT exclude — that is
 * intended: the HASH is exactly what a snapshot persists. The raw {@link DeviceToken} is absent
 * because {@link PairedDevice} carries no such field (omission by construction, AC1) — the same
 * distinction the session-store proof draws for {@link SessionIngressToken}, which this mirrors.
 * Exported so it has a referent (and is therefore evaluated, not dropped as unused); if any
 * assertion breaks, `tsc` fails.
 */
export type DeviceStorePersistenceProofs = [Assert<IsJson<PairedDevice>>, Assert<IsJson<DeviceStoreSnapshot>>];
