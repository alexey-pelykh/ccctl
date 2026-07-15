// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The **unread "needs-you" queue** (#47) — the reliability ladder's non-negotiable backstop: a persisted
 * queue of blocking `requires_action` events, reconciled over the tunnel on reconnect, so a blocking event
 * is NEVER permanently missed even when its at-most-once push is lost.
 *
 * **Why a queue at all — push is at-most-once.** The reliability ladder has three rungs. Rung 1 (#43) is
 * live delivery: a `requires_action` transition raises the blocking `ccctl_session_needs_input` event onto
 * the session's live SSE relay ({@link https://ccctl | reconcileNeedsInput} → `event-stream.ts`), reaching a
 * CONNECTED client immediately. Rung 2 (#45/#46/#50) is a push wake that pulls a BACKGROUNDED/closed client
 * back — but a push is fundamentally at-most-once: it can be coalesced away by its `Topic` (#46), dropped on
 * expiry, or silently lost when a subscription lapses. So neither the live relay (misses a disconnected
 * client) nor the push (misses a lost/coalesced wake) is a guarantee on its own. Rung 3 — THIS module — is
 * the guarantee: every blocking event is also enqueued to a PERSISTED queue and reconciled on the next
 * reconnect, so **the queue, not the at-most-once push, is the source of truth** (AC3).
 *
 * **Pure operations over the persisted shape, mirroring the codebase idiom.** The unread queue's SHAPE
 * ({@link https://ccctl | UnreadEntry}, {@link https://ccctl | SessionStoreSnapshot.unread}) and its file
 * persistence (`session-store-file.ts`, 0600 JSON round-trip) already shipped (#22/#23). What was missing —
 * and what this module adds — is the OPERATIONS on that queue: {@link enqueueUnread}, {@link reconcileUnread},
 * {@link ackUnread}. Each is a pure function over `readonly UnreadEntry[]` that mutates nothing (the input
 * may be frozen), the same pure-and-injectable stance as `session-reconcile.ts`
 * (`reconcileRecordedLaunches`) and `push-payload.ts` (`toPushPayload`). Persistence is not re-implemented
 * here — a caller saves the returned array as `SessionStoreSnapshot.unread` through the existing store, and
 * the queue survives a daemon restart because that JSON round-trip preserves it exactly (AC4).
 *
 * **`eventId`, not `at`, is the order + ack key.** #47 added the required `eventId` to `UnreadEntry` (core
 * version bump 2→3): the per-session SSE `Last-Event-ID` the event was broadcast under (the monotonic
 * `event-stream.ts` cursor). It is the ORDER key ({@link reconcileUnread} delivers a session's entries in
 * `eventId` order, AC2's "ordered by `Last-Event-ID`") and the ACK key ({@link ackUnread} removes the entry
 * a reconnecting client acknowledges by the id it saw, AC4). `at` (epoch-ms) is kept for wall-clock
 * provenance, not ordering — it can tie within a millisecond, and it is not the handle a client transmits.
 *
 * **Acknowledged == absent (ack-by-removal).** There is no `acked` flag: an acknowledged entry is REMOVED
 * from the queue, so `unread` always means exactly "the un-acked set", and {@link reconcileUnread} is a
 * straight read of what remains. This is the same referential-discipline `session-store-file.ts`
 * (`persistableSnapshot`) already applies to the array, and it is why "acknowledged" survives a restart with
 * no extra state: the pruned array is what `save()` writes. A per-session ack watermark would be a second,
 * driftable source of truth AND wrong (needs-you `eventId`s are sparse — interleaved with all other
 * broadcasts — and a later block can be addressed before an earlier one, so "acked ⟺ eventId > watermark"
 * would silently mark an earlier un-addressed block read); per-entry presence is both sufficient and correct.
 *
 * **Pure + unwired, by design (the #45/#46 stance).** Like the push-payload shapes, these operations are
 * frozen and unit-tested against the AC but not yet wired into a live path — the store itself is still
 * unwired (`session-reconcile.ts`: "nothing in the daemon calls `load()` or `save()`"). The ONE load-bearing
 * dependency the wiring slice must close: {@link enqueueUnread} takes `eventId` as a PARAMETER, but
 * `broadcastEvent` (`event-stream.ts`) currently returns `void` — it assigns the per-session id internally
 * and discards it. To feed a real `eventId` at enqueue, the wiring must make `broadcastEvent` RETURN the id
 * it assigned (a `void → number` change, backward-compatible, server-only), threaded from
 * `reconcileNeedsInput` into {@link enqueueUnread}. Stated here rather than hand-waved, exactly as
 * `session-reconcile.ts` names its unwired feed.
 *
 * **A latent, currently-unreachable caveat** (named so the wiring slice inherits it): `eventId` resets to 1
 * per process (`event-stream.ts` `nextEventId`), so ordering by it inverts chronology across a restart ONLY
 * if a session keeps its id across a worker re-register — which today it does not (`session-reconcile.ts`:
 * re-registration mints a fresh id). If same-session re-adoption ever lands, add `at` as the secondary sort
 * (it is wall-clock, restart-monotonic). Not a today-risk.
 *
 * Traces SRV-B-007 (c).
 */

import type { UnreadEntry } from "@ccctl/core";

/**
 * Enqueue a blocking needs-you entry to the unread queue (#47 AC1) — the persisted record that a
 * `requires_action` event OCCURRED, independent of whether its live delivery or push wake reached anyone.
 *
 * Appends `entry` and returns a new array, or returns `unread` unchanged when an entry with the same
 * `(sessionId, eventId)` is already present. Never mutates `unread` (which may be frozen).
 * **Idempotent per event identity**: a retried emission of the SAME broadcast cannot double-badge one
 * blocking event — `eventId` uniquely names the event within its session, so a duplicate carries no new
 * information. The returned array is the value a caller persists as `SessionStoreSnapshot.unread`; the
 * queue's survival across a restart is the store's JSON round-trip, not this function's concern.
 */
export function enqueueUnread(unread: readonly UnreadEntry[], entry: UnreadEntry): readonly UnreadEntry[] {
  if (unread.some((existing) => existing.sessionId === entry.sessionId && existing.eventId === entry.eventId)) {
    return unread; // already enqueued — one event badges once, never twice.
  }
  return [...unread, entry];
}

/**
 * Reconcile a session's un-acknowledged entries on reconnect (#47 AC2/AC3) — the un-acked set for
 * `sessionId`, ordered by {@link UnreadEntry.eventId} ascending (AC2's "ordered by `Last-Event-ID`").
 *
 * **Takes NO client cursor, deliberately.** Delivery is decided by ACK STATE alone: every entry still
 * present for the session is un-acked (ack removes — see {@link ackUnread}) and therefore delivered. It is
 * NOT filtered by the client's live `Last-Event-ID`. That distinction is the whole point of the backstop
 * (AC3): a needs-you at `eventId=5` whose push was lost, on a session whose live SSE cursor later advanced
 * to 40, MUST still be delivered — a `eventId > lastEventId` filter would drop it (5 < 40) and silently lose
 * the one blocking event the queue exists to guarantee. The `eventId` is the ORDER key here, never a
 * delivery cutoff. Pure: reads `unread`, returns a fresh ordered array, mutates nothing.
 */
export function reconcileUnread(unread: readonly UnreadEntry[], sessionId: string): readonly UnreadEntry[] {
  return unread.filter((entry) => entry.sessionId === sessionId).sort((left, right) => left.eventId - right.eventId);
}

/**
 * Acknowledge an entry by the id the client saw (#47 AC4) — remove the `(sessionId, eventId)` entry from the
 * queue so it is never re-delivered on a later reconnect. "Acknowledged" IS absence: the returned array is
 * the un-acked set minus this entry, and persisting it is what makes the acknowledgement survive a daemon
 * restart.
 *
 * **Idempotent and precisely keyed.** Acking an `eventId` not present (already acked, or never enqueued), or
 * the right `eventId` under the wrong `sessionId`, is a safe no-op returning the queue unchanged — so a
 * double-ack (e.g. two clients acknowledging the same block) cannot error or corrupt the queue. Keyed on
 * BOTH `sessionId` and `eventId` because `eventId` is a PER-SESSION cursor (`event-stream.ts`): the same
 * integer names different events in different sessions, so the session must scope the match. Pure: returns a
 * NEW array, never mutates `unread` (which may be frozen).
 */
export function ackUnread(unread: readonly UnreadEntry[], sessionId: string, eventId: number): readonly UnreadEntry[] {
  return unread.filter((entry) => !(entry.sessionId === sessionId && entry.eventId === eventId));
}
