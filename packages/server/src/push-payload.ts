// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **pointer-only push wake** contract (#45) — the server-side derivation that turns a blocking
 * needs-input notification (#43/#44) into what may leave the box as a push notification, firewalled so
 * that session CONTENT never rides it.
 *
 * **Why a firewall.** The blocking `ccctl_session_needs_input` event (#43) carries the human-ready
 * `detail` of WHAT a session is blocked on (a tool name, a question). That event, and its `detail`, ride
 * the per-session UI Server-Sent Events relay — which is reachable only over the operator's authenticated,
 * loopback-bound tunnel (`@ccctl/tunnel-adapters`; the "tunnel-only exposure" posture in the server
 * README). A **push** wake is different: it necessarily transits an EXTERNAL push gateway (a Web-Push
 * relay / APNs / FCM) the operator does not own. So a push must carry only a POINTER — an opaque session
 * id plus a minimal, generic line — never the `detail`, never a transcript, never anything a session is
 * actually saying. The content is fetched back over the tunnel on tap ({@link PushPayload} § AC3).
 *
 * **Two firewalled views**, mirroring #44's two firewalled notification classes:
 *   - {@link PushPayload} — what the CLIENT ultimately renders and taps (#45 AC1/AC3): an opaque session
 *     pointer + a minimal generic text + the blocking class carried forward. Never `detail`/content.
 *   - {@link PushGatewayView} — what the push GATEWAY sees in transit (#45 AC2): bounded metadata only —
 *     wake existence/timing/cadence + a stable subscription id. Never content, and never even the session
 *     pointer (in Web-Push the pointer rides the encrypted payload, opaque to the relay).
 *
 * **The firewall is structural, not prose** (the #44 stance): each builder reads ONLY the bounded fields
 * it is allowed to, constructs a fresh FROZEN object, and never so much as references `detail`. There is
 * no seam through which content could enter a push — proven by feeding a detail-bearing notification to
 * {@link toPushPayload} and observing the detail cannot appear (push-payload.test.ts).
 *
 * **Scope (first of the W5 push ladder).** #45 (SRV-C-004) fixed the pointer-only SHAPE and its firewall;
 * #46 (SRV-B-007 a,b) adds — still purely, still unwired to any dispatch — the **reliability directives** a
 * wake carries ({@link PushReliability}, {@link toPushReliability}): the `Urgency: high` marker and an
 * OPAQUE per-session collapse id, so repeated wakes for one blocked session coalesce rather than stack. The
 * actual wake DISPATCH and VAPID key handling (#50), the unread-queue reconcile (#47), and the client's PWA
 * subscription (#51) / tap→deep-link fetch (#52) remain separate downstream slices that CONSUME these
 * shapes. The `wake_seq` / `sent_at_ms` VALUES are supplied by that future dispatcher; this module only
 * guarantees the shapes they travel in stay bounded, content-free, and — for the gateway-visible collapse
 * id — pointer-free.
 */

import { createHash } from "node:crypto";
import { NOTIFICATION_CLASS_BLOCKING } from "./worker-channel.js";

/**
 * The minimal, generic line a pointer-only push wake carries (#45 AC1). Deliberately says nothing about
 * WHICH session or WHAT it awaits — content-free by construction: it is a compile-time constant, not
 * derived from any worker-supplied text, so no `detail` or transcript can reach the notification a push
 * gateway relays. The specific session is identified by the payload's opaque {@link PushPayload.session_id}
 * pointer (for the client's deep-link), never by this human-facing text; what the session is actually
 * saying is fetched over the tunnel on tap.
 */
export const PUSH_WAKE_TEXT = "A session needs your input";

/**
 * The **pointer-only push payload** (#45 AC1/AC3) — the client-facing wake, firewalled to a pointer plus a
 * generic line:
 *   - `session_id` — the OPAQUE pointer (AC1 "opaque id"): a bare server-minted session UUID carrying no
 *     session content of its own. It is the deep-link target the client resolves to actual content over
 *     the tunnel on tap (AC3 — `GET /api/sessions/{id}/events`; the client tap→fetch is wired by #52), so
 *     content is fetched over the tunnel and is NEVER in this payload.
 *   - `text` — the minimal generic {@link PUSH_WAKE_TEXT}; never the `requires_action` detail.
 *   - `notification_class` — the blocking class (#44) carried FORWARD from the source notification (reused,
 *     never re-derived) and pinned in this payload's TYPE, so the reliability derivation
 *     ({@link toPushReliability}, #46) can pin `Urgency: high` as a type-level consequence — without
 *     re-inspecting the wake. Only the blocking "it is waiting on you" class is push-woken; the
 *     informational idle nudge (#41) is quiet/batchable and is not.
 *
 * There is deliberately NO `detail` / transcript / content field: the type IS the AC1 firewall. A
 * {@link toPushPayload} result is frozen so the pointer-only guarantee also holds at runtime — a
 * downstream dispatcher cannot mutate a content field back in.
 */
export interface PushPayload {
  readonly session_id: string;
  readonly text: typeof PUSH_WAKE_TEXT;
  readonly notification_class: typeof NOTIFICATION_CLASS_BLOCKING;
}

/**
 * The bounded metadata a push **gateway** sees in transit (#45 AC2) — the firewalled counterpart of
 * {@link PushPayload}. A relay the operator does not own must learn only that a wake happened, when, and
 * how often, for which subscription — never content, and never even the session pointer:
 *   - `subscription_id` — a STABLE per-subscription handle (AC2 "a stable subscription id"); identifies
 *     the device subscription to wake, NOT the session (that pointer rides the encrypted payload, opaque
 *     to the relay). Stable so the gateway can address re-nudges (#48) without the server re-minting it.
 *   - `wake_seq` — the CADENCE ordinal (AC2 "cadence"): a monotonic per-subscription wake counter, so the
 *     order/frequency of wakes is expressible without any content.
 *   - `sent_at_ms` — the TIMING (AC2 "timing"): epoch-ms the wake was dispatched.
 *
 * "Existence" (AC2) is the mere presence of a view — a wake occurred. There is deliberately NO `session_id`
 * / `text` / `detail` / transcript field: the type IS the AC2 firewall. The `wake_seq` / `sent_at_ms`
 * VALUES are supplied by the future dispatcher (#50); #45 fixes only that whatever the gateway sees is this
 * bounded, content-free, pointer-free shape. The wake's reliability directives — `Urgency: high` + an
 * opaque collapse id (#46) — are the OTHER gateway-visible shape ({@link PushReliability}), likewise
 * content-free and pointer-free.
 */
export interface PushGatewayView {
  readonly subscription_id: string;
  readonly wake_seq: number;
  readonly sent_at_ms: number;
}

/**
 * The needs-input notification (#43/#44) a push wake is derived FROM — the ONLY fields {@link toPushPayload}
 * is permitted to read. The real event ({@link needsInputEvent} in `worker-channel.ts`) also carries the
 * human-ready `detail` and more; those are DELIBERATELY absent from this contract and never read, so
 * content has no path into a push payload. A caller may pass the richer event object (structural typing
 * allows it) — the derivation still reads only what is declared here.
 */
export interface NeedsInputNotification {
  readonly session_id: string;
  readonly notification_class: typeof NOTIFICATION_CLASS_BLOCKING;
}

/**
 * Derive the pointer-only {@link PushPayload} from a blocking needs-input notification (#45 AC1/AC3). Reads
 * ONLY the session pointer and the blocking class off `notification`; the `text` is the compile-time
 * {@link PUSH_WAKE_TEXT} constant, never worker-supplied. Because nothing but the pointer and class is
 * read — the notification's `detail` is never touched — session content structurally cannot enter the
 * result, which is the AC1/AC3 firewall (a downstream dispatcher gets a pointer to fetch over the tunnel,
 * not the content itself). Frozen so that guarantee also holds at runtime.
 */
export function toPushPayload(notification: NeedsInputNotification): PushPayload {
  // `as const` pins `text` to the {@link PUSH_WAKE_TEXT} literal (the compile-time half of the firewall —
  // a consumer's type says the text is never a worker-supplied string); `Object.freeze` is the runtime half.
  return Object.freeze({
    session_id: notification.session_id,
    text: PUSH_WAKE_TEXT,
    notification_class: notification.notification_class,
  } as const);
}

/**
 * Package the bounded, content-free {@link PushGatewayView} a push gateway may see (#45 AC2). Carries only
 * a stable subscription id and the wake's cadence/timing — no session pointer, no content — so the single
 * place that constructs the gateway-visible shape is also the place that guarantees its boundedness.
 * Frozen for the same runtime-firewall reason as {@link toPushPayload}. The `wakeSeq` / `sentAtMs` values
 * originate with the future dispatcher (#50); this only fixes the shape they ride in.
 */
export function toPushGatewayView(subscriptionId: string, wakeSeq: number, sentAtMs: number): PushGatewayView {
  return Object.freeze({
    subscription_id: subscriptionId,
    wake_seq: wakeSeq,
    sent_at_ms: sentAtMs,
  });
}

/**
 * The RFC 8030 §5.3 `Urgency` value a blocking push wake carries (#46 AC3) — `"high"`: "surface now", the
 * one wake class that should pull a backgrounded/closed client back immediately (and, on a
 * battery-constrained push service, be delivered rather than deferred). It is the wire header value the
 * future dispatcher (#50) stamps onto the Web-Push request — distinct from, though aligned with, the
 * blocking notification class's INTERNAL high-urgency handling policy (#44 `BLOCKING_NOTIFICATION.urgency`):
 * that policy governs how the UI surfaces the SSE notification; this is the push TRANSPORT's delivery
 * priority. Only the blocking class is push-woken (the informational idle nudge is quiet/batchable and
 * never becomes a wake), so a wake's Urgency is always high.
 */
export const PUSH_URGENCY_HIGH = "high";

/**
 * The maximum length of a {@link PushReliability.collapse_id} (#46 AC3) — 32, the RFC 8030 §5.4 `Topic`
 * header cap ("no more than 32 characters from the URL- and filename-safe Base64 alphabet [RFC 4648 §5]").
 * The collapse id IS that Topic — the coalescing key a Web-Push service compares to replace an undelivered
 * wake with a newer one for the same blocked session — so it MUST fit the cap or the push service rejects
 * it and coalescing silently stops. Named, not a hidden 32, so the derivation and its test assert against
 * one source of truth.
 */
export const PUSH_COLLAPSE_ID_MAX_LENGTH = 32;

/**
 * The **reliability directives** a blocking push wake carries (#46 AC3) — the two Web-Push delivery
 * controls that make a wake reliable WITHOUT stacking, derived from a {@link PushPayload} and handed to the
 * future dispatcher (#50) to stamp onto the outgoing Web-Push request:
 *   - `urgency` — the RFC 8030 §5.3 `Urgency` header, always {@link PUSH_URGENCY_HIGH} for a wake (only the
 *     blocking class is push-woken). The "surface now" marker AC3 asks for.
 *   - `collapse_id` — the RFC 8030 §5.4 `Topic` header: the COALESCING key. A push service replaces an
 *     undelivered wake with a newer one carrying the SAME Topic, so repeated wakes for ONE blocked session
 *     collapse to a single notification rather than piling up (AC3 "repeats coalesce, do not stack"). It is
 *     OPAQUE — a one-way digest of the session pointer, never the pointer itself — because the Topic rides
 *     as a CLEARTEXT HTTP header the EXTERNAL push gateway reads, and #45's firewall forbids that gateway
 *     ever learning which session is which (the pointer rides only the encrypted payload). Stable per
 *     session (so a re-nudge (#48) for the same session reuses it and coalesces) and distinct across
 *     sessions (so two different blocked sessions do NOT collapse into one wake).
 *
 * Frozen for the same runtime-firewall reason as the sibling shapes: a downstream dispatcher cannot mutate
 * the urgency down or swap a session-revealing collapse id back in.
 */
export interface PushReliability {
  readonly urgency: typeof PUSH_URGENCY_HIGH;
  readonly collapse_id: string;
}

/**
 * Derive the OPAQUE per-session collapse id (#46 AC3) — the RFC 8030 §5.4 `Topic` — from the opaque session
 * pointer. A keyless SHA-256 digest, base64url-encoded (the RFC 4648 §5 / RFC 8030 §5.4 alphabet) and
 * clamped to {@link PUSH_COLLAPSE_ID_MAX_LENGTH}:
 *   - **Opaque.** The Topic is a cleartext HTTP header the external push gateway reads, so it must not BE
 *     the session pointer (#45's firewall). A one-way digest reveals nothing invertible: the session id is
 *     a 122-bit-entropy server-minted UUID, so the gateway can neither invert the hash nor enumerate
 *     candidates to confirm one — it learns only a stable token, never which session. Keyless (no server
 *     secret to manage — that stays #50's VAPID concern); the UUID's entropy alone carries the opacity.
 *   - **Stable per session.** Deterministic, so every wake for one blocked session (including a re-nudge,
 *     #48) yields the SAME Topic and the push service coalesces them.
 *   - **Distinct across sessions.** Different session ids give different digests (collision negligible at
 *     192 truncated bits), so two blocked sessions never collapse into one wake.
 *
 * Deterministic and 0 I/O (a digest, not randomness or a clock) — the module's purity stance holds.
 */
function collapseIdFor(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("base64url").slice(0, PUSH_COLLAPSE_ID_MAX_LENGTH);
}

/**
 * Derive the {@link PushReliability} directives from a pointer-only {@link PushPayload} (#46 AC3). Reads
 * ONLY the payload's opaque session pointer (→ an opaque, gateway-safe collapse id via
 * {@link collapseIdFor}); the urgency is a fixed {@link PUSH_URGENCY_HIGH}, correct WITHOUT re-inspecting
 * the wake because {@link PushPayload} statically pins the blocking class #45 carried forward (only the
 * blocking class is push-woken) — so high is a type-level consequence of that pinned class, not a per-wake
 * read. Carries no `detail`/transcript/content and does not expose the session pointer, so — like its
 * sibling builders — the reliability shape a push gateway reads stays content-free and pointer-free. Frozen
 * so the pointer-free / high-urgency guarantees also hold at runtime.
 */
export function toPushReliability(payload: PushPayload): PushReliability {
  return Object.freeze({
    urgency: PUSH_URGENCY_HIGH,
    collapse_id: collapseIdFor(payload.session_id),
  } as const);
}
