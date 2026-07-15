// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — optimistic offline-steer queue decisions (pure, DOM-free).
 *
 * Steering is an upstream `fetch()` POST that rides the same request path as the session-list
 * heartbeat (`command.js` / `app.js`), so when that heartbeat is down the link is `offline` (#75) and a
 * steer cannot be delivered. Rather than drop the operator's decision — a brief tunnel drop must not
 * lose a redirect the operator just made (#79 goal) — this module owns the decisions behind an
 * OPTIMISTIC queue: a steer submitted while offline is held locally, marked pending, and fired IN ORDER
 * when the heartbeat (re)connects, while still cancellable before it fires.
 *
 * Like `command.js` / `connection.js` / `sessions.js` / `needs-you.js`, the decisions live here
 * (DOM-free) so they are unit-testable without a browser; `app.js` stays the thin shell that reads the
 * connection verdict, enqueues on offline, paints the pending list, wires each Cancel, and — on
 * reconnect — drains the queue through {@link partitionQueueForFire} and POSTs each survivor in order.
 * The queue is a plain array the shell owns (as it owns `renderedSessions` / the `needsYou` map); this
 * module is its pure transforms, holding no state of its own.
 *
 * **The stale-guard is a SEAM here, W5-21 (#80) is its home.** AC4 — "a queued item is subject to the
 * stale-guard 'session moved on' check at fire time" — is satisfied STRUCTURALLY: the fire path routes
 * EVERY item through {@link partitionQueueForFire}'s `isStale` predicate, so the guard has one place to
 * live and #80 arms it without restructuring the queue. #80 (which DEPENDS ON this item) owns the guard
 * itself: it exposes the server's monotonic per-session message cursor, has the web-ui record the cursor
 * the operator last viewed + send it with a steer, and prompts "this session moved on — still send?"
 * (confirm sends, cancel discards). Building any of that HERE would be scope-bleed into #80. So this
 * module ships the seam with an honest pass-through default (`isStale` defaults to "nothing is stale" →
 * every queued decision fires on reconnect, which IS the #79 goal); #80 replaces the shell's call with a
 * cursor-compare guard whose held items surface as {@link QUEUED_STALE} for its confirm prompt. This is
 * the same mirror-ahead posture `needs-you.js` (#53) takes toward its still-unwired server route.
 *
 * A queued item (the shape the shell holds and this module transforms):
 *
 *   QueuedSteer = { id: number, sessionId: string, command: SteerCommand, status: "pending" | "stale" }
 *   id       — a shell-minted monotonic handle, the CANCEL key (a stable identity a re-render preserves,
 *              never derived from array position, which cancelling an earlier item would shift).
 *   sessionId— the session the steer was composed against, captured at QUEUE time. The fire targets THIS
 *              session, never wherever the operator has since navigated — the decision was for this one.
 *   command  — the `{ subtype, payload? }` steer body `command.js` built; fired verbatim on reconnect.
 *   status   — "pending" while it waits, "stale" once the fire-time stale-guard held it (the session
 *              moved on) — the seam #80's confirm prompt hangs off.
 */

/** A queued steer waiting to fire on reconnect (AC1's "visibly marked pending"). */
export const QUEUED_PENDING = "pending";

/**
 * A queued steer the fire-time stale-guard HELD because the session moved on (AC4). Set by
 * {@link partitionQueueForFire} on the `hold` partition; until #80 arms the guard nothing is ever marked
 * stale (the default guard holds nothing), and a held item is cancel-only until #80 adds "still send?".
 */
export const QUEUED_STALE = "stale";

/**
 * The connection-health verdict that queues a steer instead of sending it — mirrors `connection.js`'s
 * `OFFLINE` (not imported: like every pure module here this stays dependency-free vanilla ESM). Only a
 * `failed` heartbeat is `offline`; `reconnecting` is not queued (the request path may still carry it),
 * matching the authority `connection.js` gives the poll leg.
 */
export const OFFLINE = "offline";

/**
 * Whether a submitted steer should be QUEUED rather than sent now — true exactly when the link is
 * offline (#75). `reconnecting` and `live` both send: only a confirmed-down heartbeat means the POST
 * cannot land, so only then is the optimistic queue the right home. Defensive over any string.
 *
 * @param {unknown} verdict - a `connection.js` connection-health verdict, or any value.
 * @returns {boolean}
 */
export function shouldQueueSteer(verdict) {
  return verdict === OFFLINE;
}

/**
 * Build one pending queued steer from the shell's inputs — stamping {@link QUEUED_PENDING} — or `null`
 * when the inputs are not a usable steer, so the shell never queues a keyless / targetless item. The
 * `command` is the non-null `{ subtype }` body `command.js` already built (the shell only reaches here
 * with one), and `sessionId` is the selected session (non-null at the call site); this fails closed
 * anyway, the same defensive posture as `needs-you.js`'s `decodeUnreadEntry`. Returns a FRESH object
 * (the `command` is carried by reference — it is an immutable value the shell just built and drops).
 *
 * @param {{ id?: unknown, sessionId?: unknown, command?: unknown }} fields
 * @returns {{ id: number, sessionId: string, command: { subtype: string }, status: "pending" } | null}
 */
export function queuedSteer(fields) {
  const id = fields?.id;
  const sessionId = fields?.sessionId;
  const command = fields?.command;
  if (!Number.isInteger(id)) {
    return null;
  }
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return null;
  }
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command) ||
    typeof command.subtype !== "string"
  ) {
    return null;
  }
  return { id, sessionId, command, status: QUEUED_PENDING };
}

/**
 * Remove the queued steer with `id` from `queue` (AC3: "cancel a still-pending queued item before it
 * fires"), returning a NEW array with the rest in order — never mutating the input, so the shell's
 * re-render reads a fresh list. An `id` not present leaves the queue unchanged (an idempotent cancel: a
 * Cancel tap that raced the item already firing is a harmless no-op).
 *
 * @template {{ id: number }} T
 * @param {ReadonlyArray<T>} queue
 * @param {number} id
 * @returns {T[]}
 */
export function cancelQueued(queue, id) {
  return queue.filter((item) => item.id !== id);
}

/**
 * Partition the queue for firing on reconnect (AC2 + AC4): walk it in FIFO order and route EVERY item
 * through the `isStale` stale-guard seam (AC4 — "subject to the stale-guard check at fire time"). An
 * item the guard passes goes to `send` (kept {@link QUEUED_PENDING}); one it holds goes to `hold`
 * (re-stamped {@link QUEUED_STALE}). Both partitions preserve the queue's order, so the shell POSTs the
 * `send` list sequentially and the sends land in the order they were composed (AC2: "sent in order"),
 * and replaces the queue with `hold` so a held (stale) item stays visible + cancellable.
 *
 * `isStale` DEFAULTS to "nothing is stale" (every item fires): W5-21's per-session message cursor is
 * #80's to expose, so until it lands the honest behavior is to deliver every queued decision on
 * reconnect (the #79 goal — don't lose a decision). #80 replaces the shell's call with a cursor-compare
 * guard; this function's routing is unchanged (the seam is already here). Fresh objects for the `hold`
 * side (no mutation of the input items).
 *
 * @template {{ status: string }} T
 * @param {ReadonlyArray<T>} queue
 * @param {(item: T) => boolean} [isStale] - the fire-time stale-guard; defaults to never-stale (#80 arms it).
 * @returns {{ send: T[], hold: T[] }}
 */
export function partitionQueueForFire(queue, isStale = () => false) {
  const send = [];
  const hold = [];
  for (const item of queue) {
    if (isStale(item)) {
      hold.push({ ...item, status: QUEUED_STALE });
    } else {
      send.push(item);
    }
  }
  return { send, hold };
}
