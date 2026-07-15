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
 * **The stale-guard, seamed by #79, is ARMED here (W5-21 / #80).** AC4 of #79 — "a queued item is
 * subject to the stale-guard 'session moved on' check at fire time" — was satisfied STRUCTURALLY: the
 * fire path routes EVERY item through {@link partitionQueueForFire}'s `isStale` predicate, defaulting to
 * pass-through (nothing stale → every queued decision fires, the #79 goal). #80 now ARMS that seam: the
 * server exposes each session's monotonic message cursor (`sessions.js` `sessionCursor`), the shell
 * records the cursor the operator last viewed and captures it on each {@link queuedSteer} (its `cursor`),
 * and the shell passes {@link sessionMovedOn} as the guard — an item whose session advanced past its
 * captured cursor is held ({@link QUEUED_STALE}) with a "moved on — still send?" confirm (a "Send anyway"
 * beside the existing Cancel: confirm sends, cancel discards). The SAME {@link sessionMovedOn} guards an
 * ONLINE steer inline before it sends. `partitionQueueForFire`'s routing is unchanged from #79 — #80 only
 * supplies the predicate and the captured cursor it reads.
 *
 * A queued item (the shape the shell holds and this module transforms):
 *
 *   QueuedSteer = { id: number, sessionId: string, command: SteerCommand, cursor: number,
 *                   status: "pending" | "stale" }
 *   id       — a shell-minted monotonic handle, the CANCEL key (a stable identity a re-render preserves,
 *              never derived from array position, which cancelling an earlier item would shift).
 *   sessionId— the session the steer was composed against, captured at QUEUE time. The fire targets THIS
 *              session, never wherever the operator has since navigated — the decision was for this one.
 *   command  — the `{ subtype, payload? }` steer body `command.js` built; fired verbatim on reconnect.
 *   cursor   — the session's message cursor the operator last viewed, captured at QUEUE time (#80 AC2).
 *              {@link sessionMovedOn} compares it against the session's CURRENT cursor to decide stale.
 *   status   — "pending" while it waits, "stale" once the stale-guard held it (the session moved on) —
 *              the red, "Send anyway"/Cancel row #80's confirm prompt hangs off.
 */

/** A queued steer waiting to fire on reconnect (AC1's "visibly marked pending"). */
export const QUEUED_PENDING = "pending";

/**
 * A queued steer the stale-guard HELD because the session moved on (AC4 of #79; armed by #80). Set two
 * ways: by {@link partitionQueueForFire} on the `hold` partition when the shell's {@link sessionMovedOn}
 * guard fires at reconnect-drain time, and by the shell's online-steer hold path (`holdStaleSteer`),
 * which stamps it directly when an online steer's session has already moved on. A held item renders red
 * with a "Send anyway" (the #80 "still send?" confirm) beside its Cancel.
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
 * `cursor` is the session's message cursor the operator LAST VIEWED, captured at queue time (#80 AC2 —
 * "records the cursor the operator last viewed"). {@link partitionQueueForFire}'s armed guard compares
 * it against the session's CURRENT cursor at fire time: a session that has advanced past it moved on
 * (`stale`). Defensive — a missing / fractional / negative / non-number cursor reads as `0` (viewed
 * nothing), which fails SAFE toward the guard firing (aggressive), never a silent pass-through.
 *
 * @param {{ id?: unknown, sessionId?: unknown, command?: unknown, cursor?: unknown }} fields
 * @returns {{ id: number, sessionId: string, command: { subtype: string }, cursor: number, status: "pending" } | null}
 */
export function queuedSteer(fields) {
  const id = fields?.id;
  const sessionId = fields?.sessionId;
  const command = fields?.command;
  const cursor = fields?.cursor;
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
  const viewedCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  return { id, sessionId, command, cursor: viewedCursor, status: QUEUED_PENDING };
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
 * `isStale` DEFAULTS to "nothing is stale" (every item fires) — the safe fallback that, unarmed (as #79
 * left it), delivered every queued decision on reconnect (the #79 goal — don't lose a decision). The
 * shell now (#80) supplies the real predicate, {@link sessionMovedOn}, comparing each item's captured
 * cursor against its session's current one; this function's routing is unchanged (the seam was always
 * here — #80 only passes the argument). Fresh objects for the `hold` side (no mutation of the input items).
 *
 * @template {{ status: string }} T
 * @param {ReadonlyArray<T>} queue
 * @param {(item: T) => boolean} [isStale] - the fire-time stale-guard; defaults to never-stale (the shell passes {@link sessionMovedOn}, #80).
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

/**
 * The armed stale-guard (#80): whether a session has MOVED ON since the operator last looked — its
 * current message cursor has advanced past the cursor the operator last viewed. This is the predicate
 * the shell composes into {@link partitionQueueForFire}'s `isStale` (per queued item, comparing the
 * item's captured cursor against the session's current one) AND applies inline to an online steer
 * before sending. `true` → hold for a "moved on — still send?" confirm; `false` → send.
 *
 * "Simple + aggressive: any new message triggers the guard" (#80) — so it is a strict `>` on the raw
 * cursors, no threshold. Defensive and never-throwing: each side is coerced to a non-negative integer
 * (a missing / fractional / negative / non-number value → 0). Because the cursor is monotonic, a
 * garbled CURRENT reads as 0 and can only fail toward NOT-stale (never a false "moved on"), while a
 * garbled VIEWED reads as 0 and fails toward stale (aggressive, matching the issue's intent).
 *
 * @param {unknown} viewedCursor - the cursor the operator last viewed (a queued item's `cursor`, or the shell's viewed cursor).
 * @param {unknown} currentCursor - the session's current message cursor ({@link sessionCursor} from the poll / SSE).
 * @returns {boolean}
 */
export function sessionMovedOn(viewedCursor, currentCursor) {
  const viewed = Number.isInteger(viewedCursor) && viewedCursor >= 0 ? viewedCursor : 0;
  const current = Number.isInteger(currentCursor) && currentCursor >= 0 ? currentCursor : 0;
  return current > viewed;
}
