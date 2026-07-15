// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **ack + re-nudge/escalate loop** (#48) — the reliability ladder's FINAL rung: a blocking event that
 * is not acknowledged within a window is re-nudged, and the re-nudge interval ESCALATES per a defined,
 * finite cadence, so a missed blocking event keeps pulling the operator back rather than being silently
 * dropped after one attempt. Acknowledgement stops the nudging.
 *
 * **Where this sits in the ladder.** The reliability ladder has three delivery rungs and this escalation
 * loop on top:
 *   - Rung 1 — live delivery (#43): a `requires_action` transition raises the blocking
 *     `ccctl_session_needs_input` event onto the session's live SSE relay; reaches a CONNECTED client now.
 *   - Rung 2 — push wake (#45/#46/#50): a pointer-only push pulls a BACKGROUNDED/closed client back — but a
 *     push is at-most-once (coalesced away by its `Topic` #46, dropped on expiry, lost on a lapsed subscription).
 *   - Rung 3 — the persisted unread queue (#47): every blocking event is ALSO enqueued and reconciled on
 *     reconnect, so it is NEVER permanently missed. The queue, not the at-most-once push, is the source of truth.
 * A SINGLE wake still lands at most once, though: if the operator is away, that one wake can pass unseen and
 * the session sits blocked. **This slice adds the ESCALATION** — an unacknowledged blocking event is re-woken
 * on a backing-off schedule until it is acknowledged or the cadence is exhausted.
 *
 * **Acknowledgement IS removal from the unread queue (#47) — there is deliberately no second ack concept.**
 * #47 already models "acknowledged == absent": {@link ackUnread} REMOVES the `(sessionId, eventId)` entry, so
 * the unread queue always means exactly "the un-acked set". This slice REUSES that: the re-nudge scheduler
 * evaluates only events still present in the queue, so an acked (removed) event is never re-nudged — that is
 * how "acknowledgement stops nudging" (AC3) holds, structurally, with no extra state. Introducing a separate
 * `acked` flag or a per-event nudge watermark would be exactly the "second, driftable source of truth" the
 * #47 module doc rejects. {@link dueRenudges} makes this composition explicit: it reads a set of still-queued
 * candidates, so an acked entry — absent from that set — yields no re-nudge.
 *
 * **The cadence ESCALATES and is FINITE (AC4).** {@link DEFAULT_RENUDGE_BACKOFF_MS} is a list of GROWING
 * delays between consecutive wakes (30s → 2m → 5m → 15m): re-nudge #1 fires 30s after the initial wake, #2
 * two minutes after #1, and so on — an escalating back-off, NEVER a fixed tiny interval, and it STOPS after
 * the last step (four re-nudges, then {@link RenudgeDecision} `exhausted`) so it does not run forever. The
 * exact schedule is a product-feel default: the issue note pins it as "build/config overridable — treated as
 * tunable, not settled", so every function here takes the cadence as an OVERRIDABLE parameter and the default
 * is the only baked value. An empty cadence is a valid "never re-nudge" config (exhausted immediately).
 * Quiet-hours (also named as tunable in the issue) is deliberately NOT implemented here: it needs wall-clock
 * time-of-day, which would break this module's deterministic, 0-I/O stance — it belongs to the wiring slice.
 *
 * **Exhaustion is NOT acknowledgement.** When the cadence is exhausted the PUSH re-nudges stop (AC4 "does not
 * continue forever") — but the event REMAINS in the #47 unread queue until it is really acked. The firewall
 * is intentional: "stop pestering with pushes" (this slice) is a separate concern from "never silently drop
 * the event" (the queue, the permanent backstop). An exhausted event still badges on the next reconnect.
 *
 * **`renudgesFired` is the {@link https://ccctl | PushGatewayView.wake_seq} analogue (#46), supplied by the
 * future dispatcher (#50).** The pure decision cannot know how many re-nudges have already gone out — that is
 * mutable bookkeeping the dispatcher owns (and increments when it actually sends a wake), exactly as #45/#46
 * leave `wake_seq`/`sent_at_ms` to the dispatcher. So {@link renudgeDecision} takes `renudgesFired` as a
 * parameter and stays a pure function of it. It is needed for firing IDEMPOTENCE: without it the scheduler
 * would re-fire the current step on every tick.
 *
 * **Restart behaviour is free.** Every deadline is derived from the event's fire time — {@link UnreadEntry.at},
 * which the persisted queue already carries — plus `now`, so after a daemon restart the current escalation
 * level is RE-DERIVABLE from the reconciled queue with no separate timer state to rebuild. A restart fires at
 * most the one current-level catch-up wake (not a burst of every missed step), and #46's collapse `Topic`
 * coalesces even that with any live wake for the same session.
 *
 * **Pure + unwired, by design (the #45/#46/#47 stance).** These functions are deterministic (0 I/O — `now` is
 * a parameter, like `createSession(id, mode, now)`), return frozen values, and are unit-tested against the AC
 * but not yet wired into a live dispatch path. The wiring slice (the #50 dispatcher) owns: incrementing and
 * persisting `renudgesFired`, actually sending each re-nudge wake (reusing the #45/#46 pointer-only payload +
 * reliability directives — the same collapse `Topic` makes the re-nudges coalesce rather than stack), and any
 * quiet-hours policy.
 *
 * Traces SRV-B-007 (d).
 */

import type { UnreadEntry } from "@ccctl/core";

/**
 * A re-nudge cadence: the escalating delays (in epoch-ms) BETWEEN consecutive wakes for one unacknowledged
 * blocking event. Entry `i` is the gap from wake `i` to wake `i+1`, where wake `0` is the initial wake
 * ({@link https://ccctl | toPushPayload}, #45): so `cadence[0]` is how long after the initial wake the FIRST
 * re-nudge fires, `cadence[1]` the gap to the second, and so on. Its LENGTH is the number of re-nudges — the
 * cadence is finite by construction, so re-nudging cannot run forever (AC4). A `readonly number[]` rather than
 * a bespoke object because the whole cadence is one tunable: it is passed around and overridden as a unit.
 */
export type RenudgeCadence = readonly number[];

/**
 * The default re-nudge back-off (#48 AC4) — 30s → 2m → 5m → 15m, an ESCALATING schedule of four re-nudges,
 * then stop. Escalating (each gap is larger than the last), so it is emphatically NOT "a fixed tiny interval",
 * and FINITE (four entries), so it does not continue forever. These exact values are a PRODUCT-FEEL default:
 * the issue pins the cadence as "build/config overridable — treated as tunable, not settled", so this is the
 * baseline every caller may override by passing its own {@link RenudgeCadence}, not a settled constant. Frozen
 * so the shared default cannot be mutated by a consumer.
 */
export const DEFAULT_RENUDGE_BACKOFF_MS: RenudgeCadence = Object.freeze([30_000, 120_000, 300_000, 900_000]);

/**
 * The decision for ONE unacknowledged blocking event at a moment `now` (#48) — a discriminated union on
 * `kind`, so a caller branches without inspecting timestamps:
 *   - `due` — a re-nudge should fire NOW (`now` has reached the scheduled deadline). `renudgeIndex` is the
 *     0-based ordinal of the re-nudge to fire (also its {@link RenudgeCadence} index); `renudgeAt` is its
 *     scheduled deadline (`<= now`). The caller sends the wake and increments `renudgesFired`.
 *   - `pending` — no re-nudge is due yet; the next one (`renudgeIndex`) is scheduled for `renudgeAt`
 *     (`> now`). A caller can set a timer for exactly `renudgeAt` rather than poll. This is also the state an
 *     event is in when the operator acks it "before the window" (AC): the window had not elapsed, so no
 *     re-nudge had fired — and ack then removes the event from the queue entirely.
 *   - `exhausted` — the cadence is spent; NO further re-nudge fires (AC4). The event nonetheless stays in the
 *     #47 unread queue until really acked (exhaustion is not acknowledgement).
 */
export type RenudgeDecision =
  | { readonly kind: "due"; readonly renudgeIndex: number; readonly renudgeAt: number }
  | { readonly kind: "pending"; readonly renudgeIndex: number; readonly renudgeAt: number }
  | { readonly kind: "exhausted" };

/**
 * The scheduled deadline of re-nudge number `renudgeIndex` (0-based) — the event's `firedAt` plus the
 * cumulative back-off up to and including that step: `firedAt + cadence[0] + … + cadence[renudgeIndex]`.
 * Cumulative-from-fire (not "previous nudge + gap") so every deadline is a pure function of the persisted
 * fire time and needs no stored "last nudged at"; that is what makes the level re-derivable after a restart.
 */
function renudgeDeadline(firedAt: number, renudgeIndex: number, cadence: RenudgeCadence): number {
  // Sum the first `renudgeIndex + 1` gaps onto the fire time. `slice` + `reduce` (over a `readonly number[]`,
  // so each `gap` is a `number`) keeps the caller's `renudgeIndex < cadence.length` guarantee out of the
  // indexed-access type — no out-of-bounds `undefined` to guard.
  return cadence.slice(0, renudgeIndex + 1).reduce((deadline, gap) => deadline + gap, firedAt);
}

/**
 * Decide whether the next re-nudge for one unacknowledged blocking event is due (#48 AC2/AC4). Pure and
 * deterministic — `now` is a parameter, no clock is read — so the same inputs always give the same decision.
 *
 * @param firedAt        Epoch-ms the blocking event fired (the initial wake). For a queued event this is
 *                       {@link UnreadEntry.at}.
 * @param renudgesFired  How many re-nudges have ALREADY been sent for this event (0 = only the initial wake).
 *                       The {@link https://ccctl | PushGatewayView.wake_seq} analogue the dispatcher (#50)
 *                       owns; needed so the current step is not re-fired every tick.
 * @param now            The current epoch-ms.
 * @param cadence        The escalating back-off; defaults to {@link DEFAULT_RENUDGE_BACKOFF_MS}, overridable.
 *
 * Returns `exhausted` once every cadence step has been used (`renudgesFired >= cadence.length`) — so an empty
 * cadence means "never re-nudge". Otherwise the next re-nudge is step `renudgesFired`, due at its cumulative
 * deadline: `due` when `now` has reached it, else `pending` with that deadline for a precise timer. Frozen so
 * the pointer-only ladder's runtime-immutability discipline holds here too.
 */
export function renudgeDecision(
  firedAt: number,
  renudgesFired: number,
  now: number,
  cadence: RenudgeCadence = DEFAULT_RENUDGE_BACKOFF_MS,
): RenudgeDecision {
  if (renudgesFired >= cadence.length) {
    return Object.freeze({ kind: "exhausted" } as const);
  }
  const renudgeAt = renudgeDeadline(firedAt, renudgesFired, cadence);
  return Object.freeze({
    kind: now >= renudgeAt ? "due" : "pending",
    renudgeIndex: renudgesFired,
    renudgeAt,
  } as const);
}

/**
 * One still-un-acked blocking event the re-nudge scheduler evaluates: an unread-queue {@link UnreadEntry}
 * paired with how many re-nudges it has already had. The `entry` comes straight from the #47 unread queue
 * (its `at` is the fire time, its `sessionId`/`eventId` the ack handle); `renudgesFired` is the dispatcher's
 * bookkeeping. Because the candidate set is derived from the queue, an ACKED event — removed by
 * {@link ackUnread} (#47) — simply is not a candidate, which is how {@link dueRenudges} respects AC3.
 */
export interface RenudgeCandidate {
  readonly entry: UnreadEntry;
  readonly renudgesFired: number;
}

/**
 * A candidate whose re-nudge is due now — the entry to re-wake plus the `due` {@link RenudgeDecision} that
 * named it. The entry is carried through verbatim so the caller has the `(sessionId, eventId)` ack handle and
 * fire time it needs to send the wake (reusing the #45/#46 pointer-only payload + coalescing `Topic`).
 */
export interface DueRenudge {
  readonly entry: UnreadEntry;
  readonly renudgeIndex: number;
  readonly renudgeAt: number;
}

/**
 * The scheduler-tick primitive (#48): given the current set of still-un-acked candidates and `now`, return
 * exactly those whose next re-nudge is DUE — the counterpart of #47's {@link reconcileUnread} ("given the
 * queue, what to deliver on reconnect") for the re-nudge loop ("given the queue, what to re-wake now").
 *
 * This is where "acknowledgement stops nudging" (AC3) lives in code: `candidates` is derived from the unread
 * queue, so an event the operator acknowledged — {@link ackUnread} removed it (#47) — is absent from
 * `candidates` and therefore never returned here, whether it was acked before the first window or after
 * several re-nudges. `pending` and `exhausted` candidates are likewise excluded — only `due` ones are re-woken.
 * Pure: reads `candidates`, returns a fresh array, mutates nothing (inputs may be frozen).
 */
export function dueRenudges(
  candidates: readonly RenudgeCandidate[],
  now: number,
  cadence: RenudgeCadence = DEFAULT_RENUDGE_BACKOFF_MS,
): readonly DueRenudge[] {
  const due: DueRenudge[] = [];
  for (const candidate of candidates) {
    const decision = renudgeDecision(candidate.entry.at, candidate.renudgesFired, now, cadence);
    if (decision.kind === "due") {
      due.push({ entry: candidate.entry, renudgeIndex: decision.renudgeIndex, renudgeAt: decision.renudgeAt });
    }
  }
  return due;
}
