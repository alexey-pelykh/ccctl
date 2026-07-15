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
 * **Scope (SRV-C-004, first of the W5 push ladder).** This module fixes the pointer-only SHAPE and its
 * firewall — nothing more. The actual wake DISPATCH and VAPID key handling (#50), the reliability headers
 * `Urgency: high` + a collapse id (#46), the unread-queue reconcile (#47), and the client's PWA
 * subscription (#51) / tap→deep-link fetch (#52) are separate downstream slices that CONSUME this shape.
 * The `wake_seq` / `sent_at_ms` VALUES are supplied by that future dispatcher; #45 only guarantees the
 * shape they travel in stays bounded and content-free.
 */

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
 *     never re-derived), so a consumer (#46 maps it to `Urgency: high`) keys on the class without
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
 * VALUES are supplied by the future dispatcher (#50) and reliability headers (#46); #45 fixes only that
 * whatever the gateway sees is this bounded, content-free, pointer-free shape.
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
