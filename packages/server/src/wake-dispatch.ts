// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **wake-dispatch seam** (#50) — the reliability ladder's DISPATCHER: the single function every push
 * wake is sent through, plus the VAPID key handling a Web-Push send needs. This is the wiring point the
 * whole push ladder deferred to — #45 (`push-payload.ts`) fixed the pointer-only SHAPE, #46 the reliability
 * directives, #47 the unread queue, #48 the re-nudge cadence, #49 presence suppression, each explicitly
 * naming "the future dispatcher (#50)" as the thing that would actually SEND. {@link dispatchWake} is that
 * thing.
 *
 * **One function, no transport abstraction (#50 AC1/AC2).** All wake dispatch goes through
 * {@link dispatchWake} — assembling the request, stamping the directives, invoking the transmit, and mapping
 * the result are ALL in the one function, never scattered across call sites (AC1). And it is HARD-WIRED to
 * Web-Push: there is deliberately no `PushTransport` interface with Web-Push / APNs / FCM implementations
 * selected at runtime (AC2 "no pluggable-transport abstraction"). The MESSAGE shape it builds
 * ({@link WebPushMessage}) is Web-Push-specific — a `p256dh`/`auth` subscription, an RFC 8291-encrypted body,
 * RFC 8030 `Urgency`/`Topic`/`TTL` headers, RFC 8292 VAPID identity — and a future APNs/FCM adapter would
 * REPLACE this whole function (a new `dispatchWakeApns`), not implement an injected port. The single
 * function IS the seam; that is exactly the AC2 ask.
 *
 * **Why the transmit is injected — a network boundary, NOT a transport selector.** The one thing
 * {@link dispatchWake} does not do itself is the raw encrypted `POST` to the push endpoint: that is
 * {@link WebPushSend}, an injected primitive. This is the SAME dependency-inversion the rest of this package
 * uses for its I/O edges — {@link https://ccctl | RandomBytesSource} (the CSPRNG), `PtySpawner` (`node-pty`),
 * `ProcessLivenessProbe` — so the module stays unit-testable and free of a heavy transitive dependency, with
 * the daemon (`@ccctl/cli`) binding the real implementation (the `web-push` library, which owns the RFC 8291
 * ECDH payload encryption + RFC 8292 ES256 JWT signing no one should hand-roll) exactly as it binds the real
 * launcher / store / probe. It is NOT a transport abstraction: there is one transport (Web-Push), the
 * primitive is its network edge, and an APNs adapter would not implement {@link WebPushSend} (APNs has no
 * `p256dh`, no VAPID, no `Topic`-as-collapse) — it would be a different `dispatchWake`.
 *
 * **What it stamps (wiring #45 + #46 into the actual send).** {@link dispatchWake} takes the pointer-only
 * {@link PushPayload} (#45) as the encrypted body, and derives the reliability directives itself via
 * {@link toPushReliability} (#46) — so a caller CANNOT forget or mis-stamp them: every wake carries
 * `Urgency: high` (RFC 8030 §5.3) and the opaque per-session collapse `Topic` (RFC 8030 §5.4) that coalesces
 * repeats of one blocked session rather than stacking them.
 *
 * **The #45/#46 firewall holds in the actual send.** The gateway a wake transits sees only the RFC 8030
 * CLEARTEXT headers — `Urgency`, `TTL`, and the `Topic` (an opaque SHA-256 digest of the session pointer,
 * #46), plus the device-specific endpoint — never the session pointer and never content. The opaque session
 * id rides ONLY the RFC 8291-encrypted body ({@link WebPushMessage.payload}), opaque to the relay; content
 * never leaves the box at all (#45). So the dispatcher preserves, at send time, the bounded / content-free /
 * pointer-free guarantee the shape layers built.
 *
 * **VAPID key handling (#50 AC3).** {@link validateVapidKeys} is the fail-closed gate the daemon runs when it
 * loads its VAPID identity: it refuses a subject that is not a `mailto:`/`https:` URI (RFC 8292 §2.1) and a
 * public/private key that is not the exact P-256 byte length, so a mistyped key is rejected at config load —
 * LOUDLY, in the one place keys enter — rather than failing cryptically at first send (the same fail-closed
 * stance {@link https://ccctl | startServer} takes for `maxSessions`). The validated {@link VapidKeys} then
 * ride every {@link dispatchWake} as the RFC 8292 application-server identity the transmit signs with.
 *
 * **Unwired, by design (the ladder's stance).** {@link dispatchWake} is not yet called from any live path:
 * there is no subscription store yet (the PWA subscription is #51) and no scheduler loop yet (the live
 * needs-input → dispatch wiring, reusing #48's {@link https://ccctl | dueRenudges} + #49's
 * {@link https://ccctl | isPushSuppressed}, is a later slice). This slice ships the SEAM every such caller
 * will funnel through, so the dispatch discipline (one function, directives always stamped, firewall held,
 * VAPID validated) is fixed BEFORE the first live caller exists. A repo-wide grep finds no consumer of these
 * exports yet — blast radius nil, exactly as #45–#49 each shipped their piece unwired.
 *
 * Traces SRV-C-006.
 */

import { PUSH_URGENCY_HIGH, toPushReliability, type PushPayload } from "./push-payload.js";

/**
 * A device's Web-Push subscription — the target a wake is dispatched TO. The standard browser Push API shape
 * (`PushSubscription.toJSON()`): the push-service `endpoint` the wake is `POST`ed to, plus the client's
 * `p256dh` (its P-256 public key) and `auth` secret that the transmit uses to RFC 8291-encrypt the body so
 * only that device can decrypt it. The web-ui mints and persists these (#51); this slice only CONSUMES the
 * shape, exactly as #45 consumed the needs-input notification shape without owning it. Not the `session` — a
 * subscription addresses a DEVICE; which session a wake concerns rides the encrypted payload.
 */
export interface WebPushSubscription {
  /** The push-service URL the encrypted wake is `POST`ed to (device/service-specific, not session-specific). */
  readonly endpoint: string;
  /** The RFC 8291 content-encryption key material the transmit encrypts the body with. */
  readonly keys: {
    /** The client's P-256 ECDH public key (base64url), for the RFC 8291 key agreement. */
    readonly p256dh: string;
    /** The client's auth secret (base64url), an RFC 8291 encryption input. */
    readonly auth: string;
  };
}

/**
 * The byte length of a VAPID PUBLIC key — 65, the uncompressed P-256 EC point (`0x04 || X(32) || Y(32)`,
 * SEC1 §2.3.3) a Web-Push application server publishes. Named so {@link validateVapidKeys} and its test
 * assert against one source of truth; a key that does not decode to exactly this many bytes is not a P-256
 * public key and is rejected fail-closed.
 */
export const VAPID_PUBLIC_KEY_BYTES = 65;

/**
 * The byte length of a VAPID PRIVATE key — 32, the P-256 private scalar `d`. The signing half of the VAPID
 * key pair, kept server-side and never sent; {@link validateVapidKeys} rejects anything not exactly this
 * length before it can be handed to a signer, for the same fail-closed reason as {@link VAPID_PUBLIC_KEY_BYTES}.
 */
export const VAPID_PRIVATE_KEY_BYTES = 32;

/**
 * The **VAPID application-server identity** (RFC 8292) a Web-Push send is authenticated with — the "Voluntary
 * Application Server Identification" key pair the transmit uses to sign the request so the push service knows
 * which application server it is from (and can rate-limit / contact it):
 *   - `subject` — the RFC 8292 §2.1 `sub` claim: a `mailto:` or `https:` URI naming a contact for this
 *     application server. Validated (a bad scheme is refused), never used as a credential.
 *   - `publicKey` — the P-256 public key (base64url, {@link VAPID_PUBLIC_KEY_BYTES} bytes), sent in the RFC
 *     8292 `Authorization` header so the push service can verify the signature. The SAME key the client
 *     subscribed with, so a wake it did not authorize is rejected.
 *   - `privateKey` — the P-256 private scalar (base64url, {@link VAPID_PRIVATE_KEY_BYTES} bytes) the request
 *     JWT is ES256-signed with. Server-secret; never leaves the box, never rides a payload.
 *
 * Distinct from the per-device {@link WebPushSubscription} keys: those RFC 8291-ENCRYPT the body for one
 * device; these RFC 8292-IDENTIFY the application server to the push service. Both are needed for a send, and
 * neither is content — the firewall is untouched.
 */
export interface VapidKeys {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * The RFC 8030 §5.2 `TTL` (seconds) a wake is dispatched with — how long the push service RETAINS an
 * undelivered wake before dropping it. Defaults to 5 minutes: comfortably longer than the initial re-nudge
 * gap ({@link https://ccctl | DEFAULT_RENUDGE_BACKOFF_MS}[0] = 30s, #48) so a wake survives a brief
 * device-unreachable blip and still lands, yet BOUNDED so a long-stale wake does not resurface hours later as
 * noise — the escalating re-nudge ladder (#48) sends FRESH wakes on its own schedule (all coalescing under
 * the same `Topic`, #46), and the persisted unread queue (#47), not the at-most-once push, is the source of
 * truth, so a single wake need not live long. This exact value is a PRODUCT-FEEL default in the spirit of
 * #48's cadence ("tunable, not settled") — every {@link dispatchWake} may override it via
 * {@link DispatchWakeParams.ttlSeconds}; it is the one baked baseline, and the `web-push` library's own
 * ~4-week default (wildly wrong for a wake) is exactly why an explicit, bounded value is set here.
 */
export const DEFAULT_WAKE_TTL_SECONDS = 300;

/**
 * The RFC 8030 status codes that mean a subscription is GONE — 404 Not Found and 410 Gone: the push service
 * no longer knows this endpoint (the user unsubscribed, or the browser rotated it). The canonical Web-Push
 * signal to PRUNE the stored subscription rather than retry it — a wake to a `410`d endpoint will never
 * succeed. {@link dispatchWake} maps these to {@link WakeDispatchOutcome} `expired` so the caller drops the
 * dead subscription; every other non-2xx is a transient/other `failed`. Frozen so the shared set is not mutated.
 */
export const WAKE_SUBSCRIPTION_EXPIRED_STATUSES: readonly number[] = Object.freeze([404, 410]);

/**
 * The single Web-Push request {@link dispatchWake} assembles and hands to the transmit — one fully-formed
 * wake, ready to send. Its fields split exactly along the #45/#46 firewall:
 *   - `payload` — the RFC 8291-ENCRYPTED body input: the pointer-only {@link PushPayload} (#45) serialized.
 *     Carries the opaque session pointer, but is encrypted for the target device, so opaque to the relay.
 *   - `urgency` / `topic` / `ttlSeconds` — the RFC 8030 CLEARTEXT headers the push gateway reads:
 *     `Urgency: high` (#46), the opaque collapse `Topic` (#46 — a digest of the pointer, never the pointer),
 *     and the retention `TTL`. Bounded, content-free, pointer-free — what the gateway is allowed to see (#45
 *     AC2).
 *   - `subscription` — the target device ({@link WebPushSubscription}); `vapid` — the RFC 8292 identity.
 *
 * Frozen so the assembled wake cannot be mutated between assembly and transmit — a downstream {@link WebPushSend}
 * cannot swap a content-bearing body or a session-revealing `Topic` in, mirroring the runtime-immutability
 * discipline of the shapes it is built from.
 */
export interface WebPushMessage {
  readonly subscription: WebPushSubscription;
  /** The RFC 8291-encrypted body input — the pointer-only {@link PushPayload} JSON. */
  readonly payload: string;
  /** RFC 8030 §5.2 `TTL` header (seconds the push service retains an undelivered wake). */
  readonly ttlSeconds: number;
  /** RFC 8030 §5.3 `Urgency` header — always {@link PUSH_URGENCY_HIGH} for a wake (#46). */
  readonly urgency: typeof PUSH_URGENCY_HIGH;
  /** RFC 8030 §5.4 `Topic` header — the opaque per-session collapse id (#46); coalesces repeats. */
  readonly topic: string;
  /** RFC 8292 application-server identity the transmit signs the request with. */
  readonly vapid: VapidKeys;
}

/**
 * The result of a transmit — just the HTTP status the push service answered with. {@link dispatchWake} reads
 * only the status ({@link WebPushSend} need not surface a body), classifying it into a {@link WakeDispatchOutcome}.
 */
export interface WebPushSendResult {
  readonly statusCode: number;
}

/**
 * The injected NETWORK PRIMITIVE that performs the raw encrypted `POST` of one {@link WebPushMessage} to its
 * push endpoint — the single I/O edge {@link dispatchWake} does not do itself (see the module doc: a network
 * boundary, injected for testability + to keep the `web-push` dependency out of this package, NOT a transport
 * abstraction). In production the daemon binds this to the `web-push` library's `sendNotification`; a test
 * passes a fake that returns a chosen status. It is the ONE thing a future non-Web-Push adapter would not
 * reuse — that adapter is a different {@link dispatchWake}, not a different {@link WebPushSend}.
 */
export type WebPushSend = (message: WebPushMessage) => Promise<WebPushSendResult>;

/**
 * What one {@link dispatchWake} did — a caller-meaningful classification of the push service's answer, so a
 * caller branches without re-reading raw HTTP status codes:
 *   - `accepted` — the push service took the wake for delivery (a 2xx). At-most-once still holds (delivery is
 *     not guaranteed — that is why #47's unread queue is the truth), but this server did its part.
 *   - `expired` — the subscription is GONE ({@link WAKE_SUBSCRIPTION_EXPIRED_STATUSES}: 404/410). The caller
 *     should PRUNE the stored subscription; retrying it is futile.
 *   - `failed` — any other non-2xx (429 rate-limit, 5xx, a malformed-request 4xx). Transient or
 *     server-side; the subscription is NOT pruned, and the re-nudge ladder (#48) will try again.
 */
export type WakeDispatchOutcome = "accepted" | "expired" | "failed";

/** The inputs to one {@link dispatchWake}. */
export interface DispatchWakeParams {
  /** The device to wake (#51 supplies these; this slice consumes the shape). */
  readonly subscription: WebPushSubscription;
  /** The pointer-only wake (#45) — becomes the encrypted body; its pointer also derives the collapse `Topic`. */
  readonly payload: PushPayload;
  /** The RFC 8292 application-server identity to sign with — validate once via {@link validateVapidKeys}. */
  readonly vapid: VapidKeys;
  /** The network transmit (injected — see {@link WebPushSend}). */
  readonly send: WebPushSend;
  /** Override the RFC 8030 `TTL`; defaults to {@link DEFAULT_WAKE_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
}

/** Whether `subject` is an RFC 8292 §2.1-acceptable `sub`: a non-empty `mailto:` or `https:` URI. */
function isValidVapidSubject(subject: string): boolean {
  // A bare scheme with nothing after it (`mailto:` / `https://` alone) is not a contact — require content past it.
  return (
    (subject.startsWith("mailto:") && subject.length > "mailto:".length) ||
    (subject.startsWith("https://") && subject.length > "https://".length)
  );
}

/**
 * Assert `key` is a base64url string decoding to exactly `expectedBytes` — the fixed P-256 length of a VAPID
 * key. Throws a fail-closed, actionable `ccctl:` error (the {@link https://ccctl | startServer} style) naming
 * which key and what was wrong, so a mistyped key is refused at config load, not at first send. The alphabet
 * check (`A–Z a–z 0–9 - _`, no padding) rejects a non-base64url string before decoding; the byte-length check
 * rejects a well-encoded string of the wrong length (a truncated or swapped key).
 */
function assertVapidKeyBytes(label: "public" | "private", key: string, expectedBytes: number): void {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(
      `ccctl: VAPID ${label} key must be a base64url string (got ${key === "" ? "an empty string" : "invalid characters"}) — ` +
        "it is a P-256 key, url-safe-Base64 encoded, and a value outside that alphabet cannot be one",
    );
  }
  const decodedBytes = Buffer.from(key, "base64url").length;
  if (decodedBytes !== expectedBytes) {
    throw new Error(
      `ccctl: VAPID ${label} key must be ${expectedBytes} bytes (got ${decodedBytes}) — ` +
        `a P-256 ${label} key is exactly ${expectedBytes} bytes, so a different length is a truncated or wrong key`,
    );
  }
}

/**
 * The **VAPID key-handling gate** (#50 AC3) — validate a {@link VapidKeys} fail-closed and return a FROZEN
 * copy. The daemon (`@ccctl/cli`) runs this when it loads its VAPID identity, so a bad key is refused at the
 * door — LOUDLY, in the one place keys enter — rather than failing cryptically at the first {@link dispatchWake}:
 *   - `subject` must be a `mailto:`/`https:` URI (RFC 8292 §2.1) — a non-contact scheme is refused.
 *   - `publicKey` / `privateKey` must be base64url decoding to their exact P-256 byte lengths
 *     ({@link VAPID_PUBLIC_KEY_BYTES} / {@link VAPID_PRIVATE_KEY_BYTES}) — a truncated, swapped, or
 *     non-base64url key is refused.
 *
 * The same fail-closed philosophy as {@link https://ccctl | startServer}'s `maxSessions` guard: a safety-
 * relevant config value that is malformed is rejected at boot, not silently degraded. Returns the validated
 * keys frozen so they cannot be mutated after the check. Throws a descriptive `ccctl:` `Error` on any
 * violation; on success the returned value is a safe-to-pass {@link VapidKeys}.
 */
export function validateVapidKeys(keys: VapidKeys): VapidKeys {
  if (!isValidVapidSubject(keys.subject)) {
    throw new Error(
      `ccctl: VAPID subject must be a \`mailto:\` or \`https:\` URI (got \`${keys.subject}\`) — ` +
        "RFC 8292 §2.1 requires the application-server contact be one, and a push service may reject other schemes",
    );
  }
  assertVapidKeyBytes("public", keys.publicKey, VAPID_PUBLIC_KEY_BYTES);
  assertVapidKeyBytes("private", keys.privateKey, VAPID_PRIVATE_KEY_BYTES);
  return Object.freeze({
    subject: keys.subject,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  });
}

/** Classify a push-service HTTP status into a {@link WakeDispatchOutcome} (see that type for the rationale). */
function classifyStatus(statusCode: number): WakeDispatchOutcome {
  if (statusCode >= 200 && statusCode < 300) {
    return "accepted";
  }
  if (WAKE_SUBSCRIPTION_EXPIRED_STATUSES.includes(statusCode)) {
    return "expired";
  }
  return "failed";
}

/**
 * **Dispatch one push wake (#50)** — THE single function all wake dispatch goes through (AC1). Given the
 * device to wake, the pointer-only payload (#45), and the VAPID identity, it:
 *   1. derives the reliability directives from the payload ({@link toPushReliability}, #46) — so `Urgency: high`
 *      and the opaque collapse `Topic` are ALWAYS stamped, never a per-caller responsibility to remember;
 *   2. assembles the one {@link WebPushMessage} — the encrypted-body payload split from the cleartext RFC 8030
 *      headers, VAPID attached, `TTL` defaulted (or overridden) — frozen so it cannot be tampered before send;
 *   3. invokes the injected transmit ({@link WebPushSend}) exactly ONCE; and
 *   4. maps the returned status into a {@link WakeDispatchOutcome} (`accepted` / `expired` → prune / `failed`).
 *
 * This is the seam AC2 asks for: hard-wired to Web-Push, no transport abstraction — a future APNs/FCM adapter
 * replaces this whole function. It preserves the #45/#46 firewall in the actual send: the opaque session id
 * rides only the encrypted body; the gateway's cleartext `Topic` is the opaque digest, never the pointer.
 *
 * Rejects only if the injected `send` rejects (a network throw) — the classification itself never throws; a
 * non-2xx is a returned outcome, not an exception, so a caller handles "the push service said no" the same way
 * whatever the status.
 */
export async function dispatchWake(params: DispatchWakeParams): Promise<WakeDispatchOutcome> {
  const { subscription, payload, vapid, send, ttlSeconds = DEFAULT_WAKE_TTL_SECONDS } = params;
  const { urgency, collapse_id } = toPushReliability(payload);
  const message: WebPushMessage = Object.freeze({
    subscription,
    // The pointer-only payload (#45) is the encrypted body — the opaque session id rides here (encrypted for
    // the device), never a cleartext header; content never rides it at all (the #45 firewall).
    payload: JSON.stringify(payload),
    ttlSeconds,
    // The two reliability directives (#46), stamped here so every wake carries them: high urgency + the opaque
    // collapse Topic (a digest of the pointer, gateway-safe), so repeats of one session coalesce, not stack.
    urgency,
    topic: collapse_id,
    vapid,
  });
  const { statusCode } = await send(message);
  return classifyStatus(statusCode);
}
