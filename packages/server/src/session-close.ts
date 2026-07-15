// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The TERMINAL-TRANSITION seam (#76) — the one place a session ENDS.
 *
 * A session can reach its end two ways, and they could not look less alike from the outside:
 *
 *   - **its worker is terminally gone** (#173, `worker-channel.ts` § `considerEviction`) — no
 *     downstream and no heartbeat for a full grace window. Nobody asked; a timer noticed;
 *   - **the operator stopped it** (#76, `ui-session-stop.ts`) — an explicit request, with someone
 *     waiting on the answer.
 *
 * They are the same TRANSITION. Whatever ended it, a session that ends must: reach its terminal
 * {@link SessionStatus}, leave `GET /api/sessions` (the list stays honest — nothing lingers that a
 * client could still try to steer), and give up its UI relay (#176 — subscribers are ended rather than
 * left hanging on a session that no longer exists). Three steps, every time.
 *
 * **Why a module, rather than those three lines at each end.** This is the same argument
 * `session-release.ts` makes for itself, and it is the argument this codebase makes about every rule
 * with more than one obeyer: "a check per path is two copies of a rule, and the second copy is the one
 * someone forgets". The evidence that it is not hypothetical is in the FIRST copy. Before this module,
 * eviction spelled the transition:
 *
 *     state.sessions.set(sessionId, markSessionClosed(session));
 *     state.sessions.delete(sessionId);
 *
 * — a `set` immediately undone by the `delete` on the next line, against a plain `Map` nothing
 * observes. The terminal status was COMPUTED AND DISCARDED. It reads exactly like a transition and is
 * none: `markSessionClosed` had one call site in this package and its result reached nobody, so
 * `closed` was, in practice, a status no client of this server could ever see. That is what one copy
 * of a rule decays into with nothing to hold it — and it is what #76's stop would have copied, since
 * the copy is what a reader would reasonably follow.
 *
 * **What the seam changes: the terminal status now has an OBSERVER, on the path that has one.**
 * {@link closeSession} RETURNS the closed session. A caller with someone to answer puts its `status`
 * on the wire — that is emergency-stop's AC ("the stopped session transitions to a terminal state,
 * reflected to clients"), satisfied literally rather than by a line that looks like it. A caller with
 * nobody to answer (an eviction timer) ignores the return, and is correct to: the transition still
 * happened, and its reflection is the same one it always was — the row leaves the list, the relay
 * ends. So the two paths share the transition without pretending to share an audience.
 *
 * **Why the row is DELETED rather than left behind as a readable `closed`.** A lingering terminal row
 * would be the more obvious way to "reflect" a terminal state, and it is a trap — it silently breaks
 * the `maxSessions` cap (#36), which counts `state.sessions.size` and rests on exactly this property:
 * "the size rises with every session that begins and falls with every session that ends … which is why
 * a slot frees with no new plumbing". A `closed` row that lingers holds its slot forever, so stopping
 * eight sessions would leave a server permanently `at-capacity` with nothing running in it. The
 * emergency-stop's own promise — end one, free a slot — would be the first thing it broke. Retention
 * is therefore not a small addition to this module; it is a cap-semantics change plus a reaper plus a
 * TTL nobody has a number for, and none of that is what "reflected to clients" asks for.
 */

import { markSessionClosed, type Session } from "@ccctl/core";
import { closeSessionRelay, type SessionEventRelays } from "./event-stream.js";

/**
 * The slice of server state a terminal transition touches: the registry the row leaves, and the relays
 * its stream is reaped from. A structural slice, like every other state seam in this package
 * ({@link PendingLaunchState}, {@link WorkerChannelState}) — deliberately NOT the worker channel, the
 * pending launch, or the launched surface. Ending a session's LIFECYCLE is a different question from
 * retiring the RESOURCES it accumulated, and each of those has a seam that owns it: `worker-channel.ts`
 * § `reapWorkerChannel`, `pending-launch.ts` § `consumePendingLaunch`, `session-release.ts` §
 * `stopLaunchedSession`. (The worker channel could not be folded in here even if that were desirable —
 * that module imports {@link closeSession}, so reaching back for its `endDownstream` would be a cycle.)
 *
 * **What this boundary does NOT mean.** The tempting reading of the exclusions is "each caller already
 * owns the one resource it has" — true of the eviction caller, FALSE of the stop caller, and the false
 * half is the expensive one. A caller can hold a resource it does not know it holds; that is the normal
 * case, not the exotic one (a stop holds a pending launch and a worker channel it never went looking
 * for, and forgetting either is silent).
 *
 * So read the narrowness as what it actually buys — one ordering-independent, testable transition — and
 * not as a claim about completeness, which it cannot make and does not: this seam is structurally
 * incapable of noticing what its caller left behind. Whoever ends a session answers for everything that
 * session owned. {@link stopSession} carries that list explicitly, for that reason.
 */
export interface SessionCloseState {
  /** Sessions tracked by the server — the ending session's row is dropped from here. */
  readonly sessions: Map<string, Session>;
  /** The per-session UI event relays — the ending session's is reaped (#176), ending its subscribers. */
  readonly eventRelays: SessionEventRelays;
}

/**
 * END a session: drive it to its terminal status, drop its row, and reap its UI relay. Returns the
 * CLOSED session — what it became — or `undefined` when there was no such session to end.
 *
 * The return is the point (see the module note): a caller with someone to answer reflects that status
 * to them; a caller with nobody to answer ignores it. Returning `undefined` rather than throwing makes
 * this IDEMPOTENT, which both callers need for the same reason from opposite directions — an eviction
 * timer may fire against a session a stop already ended, and a stop may name one an eviction already
 * reaped. Neither is an error; the session is over either way, which is what both asked for.
 *
 * `markSessionClosed` decides the terminal status rather than a literal `"closed"` here, so its own
 * rule holds at both ends: an `errored` session STAYS `errored` — it already reached a terminal state,
 * and the reason it got there is the more useful of the two facts. A stop that reported `closed` over
 * a session that had errored out would be overwriting the diagnosis with the fact that someone
 * eventually pressed stop.
 */
export function closeSession(state: SessionCloseState, sessionId: string): Session | undefined {
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return undefined;
  }
  const closed = markSessionClosed(session);
  state.sessions.delete(sessionId);
  closeSessionRelay(state.eventRelays, sessionId);
  return closed;
}
