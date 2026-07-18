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
 * client could still try to steer), SAY SO on its UI stream (#196 — {@link sessionClosedEvent}), and
 * give up its relay (#176 — subscribers are ended rather than left hanging on a session that no longer
 * exists). Four steps, every time.
 *
 * **Why the third step exists at all — "reflected to clients" had exactly one client (#196).** #76's
 * AC4 was satisfied for whoever INITIATED the stop: `stopSession` returns what this seam returns, and
 * the handler puts its `status` on the wire. A client that was merely WATCHING the session got the
 * fourth step and nothing else — a bare `res.end()`, which is what a dropped connection also looks
 * like. So the watcher could not tell "the session ended" from "my link died": its EventSource read the
 * end as a fault, painted a reconnect over a link that was perfectly fine, and retried into a 404;
 * only the next session-list poll, up to an interval later, revealed the row was gone — and even then
 * it learned the session's ABSENCE, never its terminal STATUS. The reflection AC4 asks for is a fact
 * about the session, and a fact told to one client is not a fact reflected to clients. The frame is
 * that fact, told on the way out.
 *
 * **Why a module, rather than those four lines at each end.** This is the same argument
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

import {
  markSessionClosed,
  type JsonValue,
  type Logger,
  type RequiresActionEnrichment,
  type Session,
  type SessionStatus,
} from "@ccctl/core";
import { broadcastEvent, closeSessionRelay, type SessionEventRelays } from "./event-stream.js";
import { cleanupHookInstall, type HookInstall } from "./hook-settings-installer.js";

/**
 * The `type` discriminant of the TERMINAL frame (#196) this seam broadcasts onto a session's UI stream
 * as it ends — the last thing a watcher reads before the relay is reaped, and the only thing that tells
 * it the end was the SESSION's and not its own connection's.
 *
 * Namespaced `ccctl_`, the third of its family (`worker-channel.ts` § {@link SESSION_IDLE_EVENT_TYPE} /
 * § {@link SESSION_NEEDS_INPUT_EVENT_TYPE}) and for their reason: a server-SYNTHESIZED frame shares the
 * relay with verbatim worker payloads, so it must live where a real `stream-json` message cannot
 * collide with it. The browser's decoder keys a transcript line on `control_event` and surfaces
 * everything else verbatim, so the namespace is also what stops this frame from being RENDERED as
 * something the worker said. It is a ccctl fact about the session, not a line of the transcript.
 *
 * **Why it lives here rather than beside its two siblings.** `worker-channel.ts` imports this module,
 * so this module cannot import it back — the cycle the module note already calls out. That constraint
 * points the same way the design does anyway: each module owns the frame it emits, and this is the only
 * place a session ends.
 */
export const SESSION_CLOSED_EVENT_TYPE = "ccctl_session_closed";

/**
 * The terminal frame's payload (#196): a {@link SESSION_CLOSED_EVENT_TYPE}-typed object NAMING the
 * session and carrying the terminal {@link SessionStatus} it reached — self-describing, so a watcher
 * needs no out-of-band context to read it, and identical in substance to what the stop's initiator gets
 * back on the wire. That sameness is the point: one fact, told to everyone who was listening.
 *
 * The status is the CLOSED session's, never a literal `"closed"`, so {@link markSessionClosed}'s rule
 * reaches the watcher too — an `errored` session reports `errored`, and the watcher reads the diagnosis
 * rather than the fact that someone eventually pressed stop.
 *
 * Deliberately carries NO `notification_class` (#44), unlike its two siblings. That marking is a
 * HANDLING policy for a notification — urgency, batching, re-nudging — and this is not a notification:
 * nothing should be woken for it, and re-raising "it ended" at a later date is meaningless. Stamping
 * one to look consistent with the family would be a lie the push pipeline could act on.
 *
 * A {@link JsonValue}, so it rides the same per-session relay as any worker payload.
 */
function sessionClosedEvent(sessionId: string, status: SessionStatus): JsonValue {
  return { type: SESSION_CLOSED_EVENT_TYPE, session_id: sessionId, status };
}

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
  /** The per-session UI event relays — the ending session's watchers are told (#196), then it is reaped (#176). */
  readonly eventRelays: SessionEventRelays;
  /**
   * The per-session `AskUserQuestion` enrichment buffer (#264) — the ending session's entry is dropped here
   * too. A session that closes while still in `requires_action` never fires the transition-out drop (close
   * moves `status`, not `activity`), so without this the decoration would outlive the session's row: a
   * bounded but real per-closed-session leak, exactly the kind {@link closeSessionRelay} exists to prevent.
   */
  readonly requiresActionEnrichments: Map<string, RequiresActionEnrichment>;
  /**
   * A launch's `AskUserQuestion` hook install record (#262, #78 Option A), keyed by ccctl session id —
   * cleaned up here whether or not it was ever consumed by `worker-channel.ts` § `reconcileHookHandoff`.
   * A session that closes with a handoff file still unread (no `AskUserQuestion` was ever asked, or one
   * was asked but never correlated before the session ended) would otherwise leave its settings + handoff
   * files on disk for the daemon's life — the same per-closed-session leak {@link requiresActionEnrichments}
   * above exists to prevent for its own map.
   *
   * This path covers the GRACEFUL close only, and cannot cover more: it reads a map that dies with the
   * process, so a `SIGKILL`/OOM/restart strands every file a then-live launch had written. That
   * across-restart half is `hook-install-sweep.ts` (#275), which reaps by the owner-PID stamp in the
   * filename — the one record of an install that outlives this map.
   */
  readonly hookInstalls: Map<string, HookInstall>;
  /** The structured-log sink (#61) — every session death is emitted here, so a created-but-never-closed leak is diagnosable. */
  readonly logger: Logger;
}

/**
 * END a session: drive it to its terminal status, drop its row, tell its watchers, and reap its UI
 * relay. Returns the CLOSED session — what it became — or `undefined` when there was no such session
 * to end.
 *
 * The return is the point for the caller's OWN audience (see the module note): a caller with someone to
 * answer reflects that status to them; a caller with nobody to answer ignores it. The broadcast (#196)
 * is the other half of the same sentence — the audience this seam can see FOR ITSELF, and therefore the
 * one no caller has to remember. That is why "reflected to clients" is now true on the eviction path
 * too, which never had anyone to answer: a watcher of a session whose worker went terminally silent
 * learns the same way, from the same line, without `worker-channel.ts` knowing this happened.
 *
 * Returning `undefined` rather than throwing makes this IDEMPOTENT, which both callers need for the same
 * reason from opposite directions — an eviction timer may fire against a session a stop already ended,
 * and a stop may name one an eviction already reaped. Neither is an error; the session is over either
 * way, which is what both asked for.
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
  // TELL the watchers, THEN reap (#196) — the order is the whole feature, and it fails WORSE than it
  // looks if swapped. `closeSessionRelay` does not merely end the subscribers: it clears the set AND
  // DELETES the relay. So a broadcast moved below it would not write to dead responses — `relayFor`
  // would hand it a FRESH, EMPTY relay and it would write to nobody at all, then leave that resurrected
  // relay behind with one buffered event, no subscribers, and nothing left to ever reap it: a leak per
  // closed session, for the daemon's life. (Measured, not reasoned: swapped, the subscriber records 0
  // writes and `eventRelays.has(id)` stays true.) It is the hazard `fireIdleEvent` guards against in so
  // many words — "a broadcast would lazily resurrect a relay for a session that no longer exists" — and
  // the reason this line goes ABOVE rather than below. Both calls are synchronous and Node is
  // single-threaded, so nothing can interleave: every subscriber alive to be reaped is alive to be told.
  //
  // Routed through `broadcastEvent` rather than writing the frame here, so the terminal frame is put on
  // the stream the ONE way anything is put on a stream — which is what earns it a real monotonic
  // `Last-Event-ID` (`event-stream.ts` § `broadcastEvent`), like every frame before it. A client tracks
  // that cursor (#80), and a farewell that skipped the id would be the one event on the stream that did
  // not advance it. The buffering `broadcastEvent` also does is spent immediately by the reap on the
  // next line — correct rather than wasteful: retaining a farewell for a reconnect that can only 404 is
  // exactly what should be thrown away.
  broadcastEvent(state.eventRelays, sessionId, sessionClosedEvent(sessionId, closed.status));
  closeSessionRelay(state.eventRelays, sessionId);
  // Drop any buffered `AskUserQuestion` enrichment (#264) — a session closing WHILE in `requires_action`
  // never trips the transition-out drop (close moves `status`, not `activity`), so this is where that
  // decoration is reaped. A no-op when nothing is buffered (`Map.delete` of an absent key).
  state.requiresActionEnrichments.delete(sessionId);
  // Clean up this session's `AskUserQuestion` hook install (#262) — its settings + handoff files —
  // whether or not the handoff was ever consumed. A no-op (both `cleanupHookInstall` and `Map.delete`
  // tolerate an absent entry) for a session whose hook install failed at launch, or one that never had
  // an `AskUserQuestion` call at all.
  const hookInstall = state.hookInstalls.get(sessionId);
  if (hookInstall !== undefined) {
    cleanupHookInstall(hookInstall);
    state.hookInstalls.delete(sessionId);
  }
  // The one terminal-transition log (#61): every session death — a #173 eviction or a #76 stop —
  // funnels through here, so a `created` with no matching `closed` is a leaked slot the trail exposes.
  // `markSessionClosed` preserves an `errored` status, so the terminal `status` here is the diagnosis
  // (why it ended), not just "closed".
  state.logger.log({
    category: "session",
    level: "info",
    event: "closed",
    sessionId,
    status: closed.status,
    detail: `session ended (${closed.status})`,
  });
  return closed;
}
