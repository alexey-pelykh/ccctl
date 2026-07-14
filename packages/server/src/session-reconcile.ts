// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The ORPHAN-REAPER (#34) — the across-restart reconciliation a daemon runs BEFORE it begins
 * serving, so a recorded session handle whose surface died while the daemon was down is evicted, and
 * one whose surface is still alive is retained/rehydrated. The restart-time sibling of the in-process
 * ghost-reaper (`pending-launch.ts`, #33): that one bounds the gap between a launch and its worker's
 * registration WITHIN one process's lifetime; this one bounds the gap a RESTART opens, when the in-memory
 * registry is gone but the surfaces the previous daemon launched may still be up. Traces to SRV-B-003
 * (safety) / SRV-B-002 (support).
 *
 * **Why a restart needs reconciling at all.** A launched ccctl surface can OUTLIVE the daemon that
 * launched it. The tmux backend (#29) opens each session as a window in a shared `ccctl` tmux session,
 * and the tmux SERVER is a separate process — it keeps every window running across a `ccctl serve`
 * restart. So after a restart the daemon faces two populations it must tell apart: surfaces it recorded
 * launching that are STILL ALIVE (the operator may have `tmux attach`ed and taken one over locally),
 * and ones that DIED while it was down (the window was closed, the worker exited). The owned-pty
 * fallback (#30) is the other pole — it owns its child, so its surface dies WITH the daemon and its
 * record is always reaped on the next start. The reaper reconciles the RECORDS to that reality; it
 * never touches the surfaces.
 *
 * **Match by a launch-marker, never a raw PID (AC5).** The correlation key is a {@link LaunchMarker} —
 * an opaque, durable handle to the launched surface that still names the SAME surface after a restart.
 * For the tmux backend that is the window's `#{window_id}` (`@N`), which tmux guarantees is unique for
 * the life of its server and never renumbers — unlike a `session:index`, which tmux DOES renumber (see
 * `session-launcher-tmux.ts` § {@link https://ccctl | TMUX_TARGET_FORMAT}). A raw PID is exactly the
 * wrong key: the OS recycles PIDs, so a dead session's PID may name an unrelated live process on the
 * next start, and probing by it would retain a ghost (or, if anything ever acted on it, endanger a
 * stranger). The marker is minted by the backend that knows how to name its own surface durably; this
 * module only compares it.
 *
 * **Records only — never kill (AC4), by construction.** The reaper's sole input for the live/dead
 * decision is a {@link ProcessLivenessProbe}, a READ-ONLY port that answers "is the surface this marker
 * names still up?" and nothing else. There is no teardown handle anywhere in this module's types, so
 * "the reaper never kills a live process" is not a discipline to remember — it is a thing the code
 * cannot do. Reconciliation partitions RECORDS ({@link reconcileRecordedLaunches}) and rehydrates the
 * survivors into the registry ({@link rehydrateRetainedSessions}); a surface, live or dead, is never
 * signalled. A surface the operator took over locally is therefore left running, exactly as the AC's
 * "a taken-over process is left running" requires.
 *
 * **Pure + injectable, wired to run before serving.** Like `pending-launch.ts`, the logic here is pure
 * over its inputs and unit-tested in isolation (`session-reconcile.test.ts`) with a fake probe; the daemon
 * wires it into {@link https://ccctl | startServer} (`index.ts`) so it runs synchronously BEFORE the
 * listener opens (AC5) — the reconcile sits ahead of `createServer`/`listen`, and a test pins that ordering
 * rather than trusting the line number.
 *
 * **What is NOT here yet, stated precisely.** Nothing FILLS the recorded-handle input in production: no
 * daemon caller configures a {@link ServerConfig.livenessProbe}, so the reaper is a verified no-op today
 * and no session is ever rehydrated. That feed is genuinely bigger than "wire up the store", and it is
 * worth naming rather than hand-waving, because the shape it needs does not exist:
 *
 *   - **No launch ever yields a marker.** This is the FIRST missing step, and it is in this package: a
 *     {@link LaunchedSession} is `{ attachment, close() }` with no marker accessor. The tmux backend does
 *     capture the durable `#{window_id}` it would need — but keeps it in a CLOSURE, where the only way it
 *     escapes is interpolated into the human-facing {@link TerminalAttachment.hint} string. So a marker must
 *     first be surfaced on the port (a `LaunchedSession.marker`, returned by the tmux backend and recorded at
 *     {@link trackPendingLaunch}) before there is any value to persist at all. `asLaunchMarker` has no
 *     production caller today for exactly this reason.
 *   - {@link ISessionStore} is still UNWIRED — #23 shipped the file backend, but nothing in the daemon calls
 *     `load()` or `save()`, so no snapshot is ever written for a restart to read.
 *   - The persisted shape CANNOT carry a marker. {@link SessionStoreSnapshot} is `{ version, sessions,
 *     unread }` and a {@link Session} has neither a marker nor a `cwd` — so a {@link RecordedLaunch} is not
 *     derivable from a snapshot today. Supplying one is a `@ccctl/core` schema change PLUS a
 *     {@link SESSION_STORE_SNAPSHOT_VERSION} bump (the precedent: `2` was the `notificationsDegraded` bump).
 *   - Persisting the `cwd` alongside the marker is what would let a returning worker RE-ADOPT its rehydrated
 *     row instead of minting a second one — see {@link rehydrateRetainedSessions}, which names that bound and
 *     the un-reaped-row bound it ships with.
 *   - The wired caller must also SAVE the reconciled snapshot back. Eviction here is an in-memory verdict:
 *     a dead record that is never written out survives on disk and is re-probed (and re-evicted) on every
 *     subsequent restart, which makes "the session record is evicted" true only for the running process.
 *
 * So: the seam, the marker keying, the read-only probe, the `registering` refusal and the before-serving
 * wiring are complete and tested — but until the chain above lands, NO daemon caller configures a
 * {@link ServerConfig.livenessProbe}, so the reaper does not run in the shipped daemon at all. It is a
 * correct, exercised seam awaiting its feed, not a live guarantee; treating it as the latter would be exactly
 * the "status ≠ gate" mistake, against a safety trace (SRV-B-003).
 */

import type { Session } from "@ccctl/core";

/**
 * An opaque, durable handle to a launched surface that still names the SAME surface after a daemon
 * restart — the key the reaper reconciles by (AC5), deliberately NOT a raw PID (which the OS recycles).
 * The backend that launched the surface mints it in a form only it has to interpret: the tmux backend
 * (#29) uses the window's `#{window_id}` (`@N`); the owned-pty fallback (#30), whose surface never
 * survives the daemon, has no durable marker to record. A branded string — this module compares markers
 * for identity and hands them to the probe; it never parses one. Branded (rather than a bare `string`)
 * so a PID, an operator input, or an arbitrary id cannot be passed where a durable marker is meant
 * without going through {@link asLaunchMarker}.
 */
export type LaunchMarker = string & { readonly __launchMarker: unique symbol };

/**
 * Mint a {@link LaunchMarker} from the backend-produced string that durably names a launched surface
 * (e.g. a tmux `@window_id`). The ONE narrowing seam, so a raw string — a PID, an operator input, an
 * arbitrary id — cannot stand in for a marker without passing through here, which is where the
 * "durable, backend-minted, not a PID" contract is asserted. Backends call it when they record a
 * launch; nothing else should.
 */
export function asLaunchMarker(value: string): LaunchMarker {
  return value as LaunchMarker;
}

/**
 * One recorded launched-session handle — the persisted FACE of a launch, as the reaper sees it on the
 * next start: the {@link Session} row the previous daemon tracked, plus the {@link LaunchMarker} that
 * durably names the surface it is running on. Reconciliation probes the marker and either REHYDRATES
 * the session (its surface is still up) or EVICTS the record (its surface is gone). It carries no
 * teardown handle, by design (see the module doc): the reaper reconciles records, it does not reach a
 * surface.
 */
export interface RecordedLaunch {
  /** The recorded session row — re-seeded into the registry verbatim when its surface is still alive. */
  readonly session: Session;
  /** The durable handle to this session's launched surface — the key liveness is probed by (AC5). */
  readonly marker: LaunchMarker;
}

/**
 * The READ-ONLY liveness oracle the reaper decides by: given a {@link LaunchMarker}, answer whether the
 * surface it names is STILL UP. This is the module's ENTIRE window onto the process world — and it is
 * intentionally a one-way window. It can OBSERVE that a surface is alive or dead; it cannot act on one,
 * so no reconciliation path can kill a live process (AC4).
 *
 * Synchronous, like the codebase's other host-touching launch predicates ({@link resolveLaunchCwd},
 * `defaultWorkerBinaryProbe` — both per-launch pre-flights; this is the only one that runs pre-serve): the
 * reaper runs once, before the listener opens, and a sync predicate keeps that step a straight-line "load →
 * reconcile → serve" with no re-entrancy hazard. A real backend answers it cheaply against a single
 * enumeration it captured up front — e.g. the tmux backend runs one `tmux list-windows -F '#{window_id}'`
 * and closes over the resulting live-id set, so each per-marker check is an in-memory membership test. That
 * shape is also why a probe does not throw: the fallible enumeration happens in the caller's closure, before
 * the reaper ever runs.
 */
export type ProcessLivenessProbe = (marker: LaunchMarker) => boolean;

/**
 * The reconciliation verdict: the records whose surfaces are still alive (to REHYDRATE) and the ones
 * whose surfaces are gone (to EVICT). A total partition of the input — every recorded handle lands in
 * exactly one side — so nothing is silently dropped.
 */
export interface ReconcileOutcome {
  /** Records whose surface the probe found ALIVE — rehydrated into the registry (AC3). */
  readonly retained: readonly RecordedLaunch[];
  /** Records whose surface the probe found GONE — evicted, never re-seeded (AC2). */
  readonly evicted: readonly RecordedLaunch[];
}

/**
 * Reconcile recorded launched-session handles against live processes (#34, AC1/AC2/AC3/AC5): probe each
 * record's {@link LaunchMarker} and partition into the survivors to rehydrate and the orphans to evict.
 * PURE — it reads only the probe and returns a verdict; it mutates no state and, having no teardown
 * handle to reach for, kills nothing (AC4). The caller applies the verdict
 * ({@link rehydrateRetainedSessions} seeds the survivors; the evicted are simply not seeded).
 *
 * Probes each record's marker and NOTHING else — not the session id, not a PID — so "matches processes
 * by a launch-marker" is literally what the correlation does. Order-preserving within each side, so the
 * rehydrated registry keeps the recorded launch order: a determinism the tests pin and an operator's
 * session list quietly benefits from.
 *
 * **A `registering` record is evicted regardless of liveness** — and it is not even probed, because its
 * surface's liveness cannot change the answer. `@ccctl/core` § {@link SessionStatus} states the invariant
 * outright: *"A `registering` session must never be RESTORED … a `registering` row rehydrated from a
 * persisted snapshot would be precisely the ghost this status exists to prevent."* The two things that
 * could ever resolve such a row — the pending-launch record its §2 registration would claim, and the
 * eviction timer holding it — lived in the PREVIOUS process and died with it (`pending-launch.ts`). So a
 * restored one is immortal by construction: nothing can claim it (`rejectIfRegistering` 409s every worker
 * leg) and nothing is left to evict it. Its ROW therefore goes; its SURFACE is untouched and left running,
 * exactly as AC4 requires — this reaper reconciles records, never processes. AC3's "retained/rehydrated"
 * governs the RESOLVABLE sessions; it cannot reach a row core forbids restoring. This is the same rule
 * `persistableSnapshot` (`session-store-file.ts`) enforces on both save and load, applied at the other
 * boundary that can re-seed a registry — and note a `registering` record is the one MOST likely to have a
 * live marker (its terminal came up seconds before the restart), so this is the common case, not a corner.
 */
export function reconcileRecordedLaunches(
  records: readonly RecordedLaunch[],
  probe: ProcessLivenessProbe,
): ReconcileOutcome {
  const retained: RecordedLaunch[] = [];
  const evicted: RecordedLaunch[] = [];
  for (const record of records) {
    if (record.session.status === "registering" || !probe(record.marker)) {
      evicted.push(record);
    } else {
      retained.push(record);
    }
  }
  return { retained, evicted };
}

/**
 * The slice of server state the reaper rehydrates INTO — just the session registry. A structural slice
 * (like {@link PendingLaunchState}) so the seam stays decoupled from the HTTP wiring in `index.ts`.
 */
export interface ReconcileState {
  /** The session registry — a surviving recorded handle's session is re-seeded here on rehydrate. */
  readonly sessions: Map<string, Session>;
}

/**
 * Rehydrate the survivors of a reconciliation into the registry (AC3): re-seed each retained record's
 * {@link Session} under its own id, so a session whose surface outlived the daemon reappears in
 * `GET /api/sessions` on the next start rather than vanishing. Re-seeding by id is idempotent — a second
 * rehydrate over the same survivors is a no-op — and it restores the RECORD only: the worker CHANNEL
 * (the in-memory §4/§5 downstream) is not a persisted thing, so a rehydrated session honestly reports no
 * live worker ({@link CcctlServer.hasLiveWorker} is `false`; a steer fails closed) until one is attached.
 *
 * `registering` rows are skipped here as well as at classification ({@link reconcileRecordedLaunches}) —
 * deliberate double enforcement, for the reason `persistableSnapshot` (`session-store-file.ts`) gives for
 * filtering on both save and load: this is the boundary that actually WRITES the registry, and *"a rule
 * that lives only in a doc comment is a rule that holds only until someone does not read it."* A caller
 * that assembles `retained` by some other route still cannot poison the session list with a row core
 * forbids restoring.
 *
 * **Two bounds a caller must close before wiring this in production** — both unreachable today (no daemon
 * caller configures a {@link ServerConfig.livenessProbe}, so nothing is ever rehydrated), and both blocked
 * on the same missing persisted shape as the production feed itself (see the module doc):
 *
 *   1. **A rehydrated session cannot be RE-ADOPTED by its returning worker.** {@link claimPendingLaunch}
 *      only ever lends an id out of `pendingLaunches`, which rehydration does not (and structurally cannot)
 *      populate — its slice is `{ sessions }` alone. So a worker that re-registers after the restart mints a
 *      FRESH id (`environments-bridge.ts`) and the operator sees TWO rows for one surface. Closing it needs
 *      the launch's correlation key (its `cwd` + mode) persisted alongside the marker — and `Session` carries
 *      neither, which is precisely the core schema change the module doc names.
 *   2. **A rehydrated session is not reachable by any eviction path.** Every eviction is channel-rooted
 *      (`scheduleEviction` needs a `WorkerChannelRecord`; `evictPendingLaunch` needs a `pendingLaunches`
 *      entry) and there is no sweep over `state.sessions`, so a rehydrated row with no channel is never
 *      reaped WITHIN a daemon lifetime even though {@link isSessionStale} reports it stale — its liveness is
 *      only re-decided by this reaper on the NEXT restart. Bounding it needs a decision (a re-probe sweep, or
 *      an eviction that walks the registry rather than the channels), not a patch.
 */
export function rehydrateRetainedSessions(state: ReconcileState, retained: readonly RecordedLaunch[]): void {
  for (const record of retained) {
    if (record.session.status === "registering") {
      continue;
    }
    state.sessions.set(record.session.id, record.session);
  }
}
