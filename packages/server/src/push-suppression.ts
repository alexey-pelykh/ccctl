// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * **Presence-aware push suppression** (#49) — a best-effort filter atop the reliability ladder's
 * always-send wake rung: if a live client just acknowledged a blocking event, the redundant push for
 * that SAME event is suppressed — don't push a notification the operator already handled on a connected
 * client. It can only ever REMOVE a redundant push, never swallow a needed one.
 *
 * **Where this sits in the ladder.** The reliability ladder guarantees a blocking `requires_action` event
 * reaches the operator across three delivery rungs plus the #48 escalation loop:
 *   - Rung 1 — live delivery (#43): the blocking `ccctl_session_needs_input` event rides the session's live
 *     SSE relay ({@link https://ccctl | broadcastEvent} → `event-stream.ts`) to a CONNECTED client now.
 *   - Rung 2 — push wake (#45/#46/#50): a pointer-only push pulls a BACKGROUNDED/closed client back.
 *   - Rung 3 — the persisted unread queue (#47): every blocking event is ALSO enqueued and reconciled on
 *     reconnect, so it is NEVER permanently missed — the queue, not the at-most-once push, is the truth.
 * When a client is CONNECTED, rung 1 already delivered the event and the operator can act on it live. The
 * rung-2 push is then pure redundancy — a buzz on the phone for something already handled on the open
 * client. **This slice removes that redundancy**: a push whose event a live client already acknowledged is
 * suppressed. This is the ONLY thing it does — it never creates, delays, or reroutes a wake.
 *
 * **Best-effort, fail-toward-sending — the invariant that makes this safe (AC).** Suppression is a filter
 * that may only ever DROP a redundant push, so a bug here can waste a buzz but can NEVER lose a needed
 * wake. That safety is structural, not prose: {@link isPushSuppressed} suppresses ONLY on a POSITIVE ack
 * record — the wake's `(sessionId, eventId)` is present in the acknowledged set — and proceeds (returns
 * `false`) on its ABSENCE. So every race tiebreaks toward sending:
 *   - **ack-vs-dispatch (AC4).** If the operator's live ack has not yet been recorded when the dispatcher
 *     checks, the event is absent from the set → not suppressed → the push proceeds. A redundant push beats
 *     a missed one; the ack simply suppresses the NEXT wake (a re-nudge, #48) instead.
 *   - **enqueue-vs-dispatch.** A never-yet-acknowledged event is likewise absent → the push proceeds. This
 *     is WHY suppression keys off a positive acked set and NOT off unread-queue absence: queue-absence
 *     conflates "acknowledged (removed)" with "not yet enqueued", so keying off it would suppress — and
 *     thus DROP — the wake for a genuine, still-unhandled block that merely raced its own enqueue. A
 *     positive ack signal cannot make that mistake: absence, from any cause, always means "send".
 *
 * **Why a positive acked set is NOT the "second source of truth" #47/#48 reject.** #47/#48 model
 * acknowledgement as REMOVAL from the unread queue ("acknowledged == absent") and deliberately refuse a
 * second `acked` flag or an `eventId > watermark` heuristic — a driftable duplicate of "what still needs
 * the operator". This module's acked set is a DIFFERENT thing answering a DIFFERENT question, so it is
 * complementary, not redundant:
 *   - The unread queue answers "what must never be lost" — its authority is that ABSENCE is final (a
 *     removed event is gone). That negative authority is exactly what makes it UNSAFE as a suppression
 *     signal (absence also precedes enqueue), per the enqueue-vs-dispatch race above.
 *   - This acked set answers "which pushes are safe to skip" — a filter that must fail toward sending, so
 *     it needs a POSITIVE signal, and it is TRANSIENT dispatcher bookkeeping (like the #50 dispatcher's
 *     `renudgesFired` / {@link https://ccctl | PushGatewayView.wake_seq}), not a persisted authority. It
 *     may be bounded or dropped freely: a lost ack record costs at most one redundant push (safe), never a
 *     missed event (the queue still guarantees that). And it is NOT the rejected driftable watermark — it
 *     is an EXACT per-event key, never a range comparison over sparse, interleaved `eventId`s, so it cannot
 *     silently mark an earlier un-addressed block read (the precise failure #47's module doc calls out).
 *
 * **"Live" is the wiring's determination; this module just holds the resulting keys.** Only a PRESENT
 * (connected) client can acknowledge an event in the small window before its initial push dispatches, so
 * the acks that populate this set are the LIVE-path acks — a connected client acting on the rung-1 event.
 * The reconnect-reconcile ack (#47 {@link https://ccctl | ackUnread}, rung 3) is a separate, later path:
 * by the time an away operator reconnects, the initial push has long since fired, so it has no initial
 * wake to race; it already stops any pending RE-NUDGE structurally, because #48 derives its candidates
 * from the (now shorter) unread queue. Which acks are "live" is therefore a WIRING decision (#50) about
 * which ack path calls {@link recordLiveAck}; this pure module holds only the resulting `(sessionId,
 * eventId)` keys and answers the membership question.
 *
 * **Pure + unwired, by design (the #45/#46/#47/#48 stance).** These functions are deterministic (0 I/O — no
 * clock is read; suppression is pure membership, so not even `now` is needed), return frozen values, and
 * are unit-tested against the AC but not yet wired into a live dispatch path. The wiring slice (the #50
 * dispatcher) owns: recording a live-path ack via {@link recordLiveAck} when a connected client
 * acknowledges the event it saw, bounding/pruning the acked set, and calling {@link isPushSuppressed}
 * before each send — the initial wake AND every re-nudge — to skip a suppressed one. Stated here rather
 * than hand-waved, exactly as the sibling modules name their unwired feeds.
 *
 * Traces SRV-B-008.
 */

/**
 * The per-event ACK KEY — a `(sessionId, eventId)` pair, the SAME handle {@link https://ccctl | ackUnread}
 * (#47) acknowledges an unread entry by. It serves two structurally-identical roles here: an entry in the
 * acknowledged set (an event a live client handled) and the target of a push about to be sent (the event a
 * wake is for). One type because it is one key space — the pair that uniquely names an event.
 *
 * `eventId` is a PER-SESSION cursor (`event-stream.ts` `nextEventId`, from 1), so it names different events
 * in different sessions; `sessionId` scopes it. Both fields are therefore load-bearing to the identity —
 * matching on `eventId` alone would cross-wire two sessions that happen to share the integer (#49 AC3).
 * Structural typing means a caller may pass a richer object that already carries these fields — an
 * {@link https://ccctl | UnreadEntry} or a #48 {@link https://ccctl | DueRenudge.entry} — without adapting it.
 */
export interface EventKey {
  /** The session the event belongs to — see {@link https://ccctl | UnreadEntry.sessionId}. */
  readonly sessionId: string;
  /** The per-session SSE `Last-Event-ID` the event was broadcast under — see {@link https://ccctl | UnreadEntry.eventId}. */
  readonly eventId: number;
}

/**
 * Record that a live client acknowledged a blocking event (#49) — append its `(sessionId, eventId)` key to
 * the acknowledged set so a subsequent {@link isPushSuppressed} check for that same event suppresses its
 * redundant push. The counterpart of #47's {@link https://ccctl | enqueueUnread} for this transient set.
 *
 * Appends a frozen {@link EventKey} and returns a new array, or returns `acknowledged` unchanged when the
 * same `(sessionId, eventId)` is already present. Never mutates `acknowledged` (which may be frozen).
 * **Idempotent per event identity**: recording the same live ack twice — e.g. two connected clients
 * acknowledging one block — is a safe no-op, so it cannot double-grow the set; `eventId` uniquely names the
 * event within its session, so a duplicate carries no new information. The returned array is transient
 * dispatcher bookkeeping the caller (#50) may bound or drop freely — a lost record costs at most one
 * redundant push, never a missed event (the #47 unread queue remains the permanent backstop).
 */
export function recordLiveAck(
  acknowledged: readonly EventKey[],
  sessionId: string,
  eventId: number,
): readonly EventKey[] {
  if (acknowledged.some((ack) => ack.sessionId === sessionId && ack.eventId === eventId)) {
    return acknowledged; // already acknowledged — one event is recorded once, never twice.
  }
  // Freeze the key so the pointer-only ladder's runtime-immutability discipline holds here too — a
  // consumer cannot mutate a recorded ack's session/event out from under a later suppression check.
  return [...acknowledged, Object.freeze({ sessionId, eventId })];
}

/**
 * The best-effort suppression decision (#49 AC1–AC4): should the push for `wake` be suppressed because a
 * live client already acknowledged that same event? `true` iff `wake`'s `(sessionId, eventId)` is present
 * in the `acknowledged` set — otherwise `false` ("send"). Pure membership: no clock, no `now`.
 *
 * The decision suppresses ONLY on a POSITIVE ack and proceeds on ABSENCE, which is the whole safety of the
 * filter — every race (the ack not yet recorded, AC4; an event not yet enqueued) leaves the key absent and
 * so tiebreaks toward SENDING, never toward dropping a needed wake. Matched on BOTH `sessionId` and
 * `eventId` so acknowledging event A never suppresses a different event B (#49 AC3), including two events in
 * DIFFERENT sessions that share the same per-session `eventId` integer. Reads `acknowledged`, returns a
 * boolean, mutates nothing (inputs may be frozen).
 */
export function isPushSuppressed(acknowledged: readonly EventKey[], wake: EventKey): boolean {
  return acknowledged.some((ack) => ack.sessionId === wake.sessionId && ack.eventId === wake.eventId);
}
