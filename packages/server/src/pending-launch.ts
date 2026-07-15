// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The PENDING-LAUNCH registry (#33) — the bookkeeping that closes the gap between a launch and
 * the launched worker's own registration, so that gap can never leave a ghost behind (`SRV-B-003`).
 *
 * A UC2 launch (#31) and the registration that completes it are TWO separate events, seconds
 * apart and on different transports: the server brings a terminal up (`POST /api/sessions`), and
 * the patched `claude` inside it then registers itself over the bridge (§2, `POST /v1/sessions`).
 * Between the two, the session is REAL but not yet live — and if the worker never registers (it
 * crashed on boot, the binary was wrong, the operator killed the window), the terminal the server
 * spawned would linger forever with nothing to reap it: a **half-registered ghost**.
 *
 * This module makes that in-between state EXPLICIT and BOUNDED. A launch that brings a surface up:
 *
 *   1. mints the session id and places a `registering` {@link Session} in the registry — so the
 *      launched session is visible in `GET /api/sessions` from LAUNCH (the operator watches it come
 *      up) rather than only from registration;
 *   2. records a {@link PendingLaunch} here, holding the launch's identity ({@link PendingLaunch.cwd}
 *      + {@link PendingLaunch.permissionMode}), the terminal handle, and an ARMED eviction timer.
 *
 * Exactly one of two things then happens — the state is transient by construction:
 *
 *   - **claimed** ({@link claimPendingLaunch}) — the worker registers, the §2 leg matches the
 *     registration to its pending launch, and the session advances in place (same id) to
 *     `connecting`. The timer is disarmed; the terminal handle stays owned by the server for
 *     shutdown teardown.
 *   - **evicted** ({@link evictPendingLaunch}) — the timer fires first. The session is dropped from
 *     the registry (`GET /api/sessions` stops showing it), its terminal is CLOSED (the spawned child
 *     is reaped, so no orphan process outlives its session), and its UI relay is reaped.
 *
 * **Correlation (why cwd + permissionMode, and where it stops).** The worker's §2 registration
 * carries no launch id — it ships in `ccctl-patch` (a separate repo) and speaks the current build's
 * OBSERVED wire, which ccctl does not get to extend unilaterally. What that wire DOES carry is the
 * session context's `cwd` and the `permission_mode`, and a launched worker is rooted at exactly the
 * cwd the server launched it at, under exactly the mode the server passed it. That pair is therefore
 * the strongest correlation available without a wire change. A registration that matches NO pending
 * launch is not a launched session at all — it is a UC1 attach — and is left to mint its own fresh
 * id, exactly as before this module existed.
 *
 * The pair is a HEURISTIC, not an identity, and this module is built to be SAFE about that rather
 * than to pretend otherwise. Two disciplines carry that:
 *
 *   1. **Canonicalize, or the key silently never matches.** The operator's `cwd` is a raw string
 *      (`/tmp/proj`, a symlink, a trailing slash, the wrong case on a case-insensitive disk);
 *      the worker reports what `getcwd(3)` gives it, which is FULLY RESOLVED (`/private/tmp/proj` on
 *      macOS, and in the directory's real case). Comparing the two verbatim fails on every
 *      non-canonical path — and a missed claim is not a benign no-op: it leaves the timer armed on a
 *      session that DID register, and 10s later that timer CLOSES A LIVE SESSION'S TERMINAL. So both
 *      sides are put through {@link canonicalCwd} before they are ever compared, and the launch itself
 *      is rooted at the resolved path ({@link resolveLaunchCwd}).
 *   2. **Never assert a mapping the key cannot support, and never gamble with a terminal.** One launch
 *      per (cwd, mode) is the ordinary case, and there the key is decisive: the registration reuses
 *      that launch's id, the row the operator is watching advances in place, and a launch that never
 *      registers is evicted in full — row AND terminal. But TWO launches in one directory under one
 *      mode make the key identify NEITHER, and two things follow, both of them refusals to guess:
 *
 *        - Neither may LEND ITS ID ({@link PendingLaunch.ambiguous}) — a registration there is minted a
 *          fresh id instead. A wrong-but-confident session↔terminal mapping would steer the operator
 *          into the other conversation, breaking the namespace's never-cross-wired invariant (#20); an
 *          honestly-anonymous session merely forgoes the convenience of the id shown at launch.
 *        - Once ANY worker registers in that group, none of the group's terminals may be CLOSED by
 *          eviction ({@link PendingLaunch.mayHoldLiveWorker}) — that worker could be in any of them.
 *          Their rows are still evicted on timeout (the list stays honest, which is what AC3 promises),
 *          but the surfaces are left to shutdown. Two launches where only one worker comes up is the
 *          case that makes this concrete: the claim cannot know WHICH one came up, so a per-launch
 *          eviction would close the live worker's terminal half the time.
 *
 *      Both marks are STICKY, because consuming one member of a group does not make the survivors
 *      identifiable: the registration that consumed it could have come from any of them.
 *
 * What remains, and what would fix it: a UC1 attach that registers from the same directory under the
 * same mode as a pending launch is INDISTINGUISHABLE from that launch's own worker, so it CLAIMS that
 * launch — taking its session id (so the operator's launch row now addresses a different conversation,
 * the very cross-wire the ambiguity rule above exists to prevent) and disarming its eviction timer (so
 * if the launched worker then dies on boot, its ghost is never reaped). Closing that needs a launch
 * token the server hands the worker and the worker echoes back (an argv/env addition on both sides of
 * `ccctl-patch`), which is the real fix and a separate item; nothing on today's wire distinguishes the
 * two — the §2 `source` field is free-form and carries no pinned launch/attach value.
 *
 * Shaped after the sibling eviction policy the worker channel already runs (#173,
 * `worker-channel.ts`): a one-shot `.unref()`ed timer, disarmed by the event that makes eviction
 * moot, and an eviction that reaps the session, its relay, and its resources together.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createRegisteringSession, type PermissionMode, type Session } from "@ccctl/core";
import { closeSessionRelay, type SessionEventRelays } from "./event-stream.js";
import type { LaunchedSession, SessionLaunchOptions } from "./session-launcher.js";
import { releaseLaunchedSession } from "./session-release.js";

/**
 * Default window (10s) a launched session may stay `registering` before it is evicted as a ghost —
 * the "default ~10s" of the AC. Generous next to a healthy worker's boot (which registers in well
 * under a second) yet short enough that a dead launch does not linger in the operator's list.
 * Overridable per server ({@link ServerConfig.registrationTimeoutMs}) — a test passes a short value
 * to exercise eviction deterministically, and a slow host can raise it.
 */
export const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * One launched-but-not-yet-registered session: the id its `registering` {@link Session} is keyed
 * on, the launch identity the §2 registration is matched against, the terminal handle to reap if
 * it never arrives, and the armed eviction timer.
 */
export interface PendingLaunch {
  /** The session id minted at launch — the key of both the `registering` session and this record. */
  readonly sessionId: string;
  /**
   * The working directory the session was LAUNCHED at — half of the §2 correlation key, and stored
   * ALWAYS in its {@link canonicalCwd} form, because the other half of the comparison (what the
   * worker reports) is canonical whether we like it or not.
   */
  readonly cwd: string;
  /** The permission mode the session was LAUNCHED under — the other half of the correlation key. */
  readonly permissionMode: PermissionMode;
  /** The launched terminal's handle — CLOSED on eviction (reaping the child), retained on a claim. */
  readonly launched: LaunchedSession;
  /** The armed one-shot eviction timer; cleared on a claim or at shutdown. */
  readonly timer: ReturnType<typeof setTimeout>;
  /**
   * Whether this launch SHARES its (cwd, mode) pair with another pending launch — set the moment a
   * second launch of the same pair is tracked, and never cleared. An ambiguous launch is tracked and
   * evicted exactly like any other; what it may no longer do is LEND ITS ID to a registration, since
   * the pair no longer says which of the two that registration came from ({@link claimPendingLaunch}).
   */
  readonly ambiguous: boolean;
  /**
   * Whether this launch's TERMINAL might be the one a worker that already registered is running in —
   * set on every survivor of a group when an {@link ambiguous} claim lands on it ({@link
   * claimPendingLaunch}), because that worker could have come from any of the group's terminals.
   *
   * It gates the destructive half of eviction, and only that half: such a launch is still evicted on
   * timeout (its row leaves the list — AC3), but its terminal is NOT closed, because closing it would
   * be a coin flip against a live session. The handle stays owned by the server and is torn down at
   * shutdown. Never set for the ordinary one-launch-per-directory case, which therefore still reaps
   * its ghost's terminal in full.
   */
  readonly mayHoldLiveWorker: boolean;
}

/**
 * The slice of server state the pending-launch registry operates on — held by the launch ingress
 * ({@link SessionLaunchState}) and, since the §2 registration is where a launch is CLAIMED, by the
 * bridge ({@link BridgeState}) too. A claim can retire a placeholder row outright (an ambiguous pair,
 * see {@link claimPendingLaunch}), so the claim leg genuinely needs the same reach eviction does —
 * a narrower "just the map" slice would be a lie about what registration can do.
 */
export interface PendingLaunchState {
  /** Launches awaiting their worker's registration, keyed by the session id minted at launch. */
  readonly pendingLaunches: Map<string, PendingLaunch>;
  /** Sessions tracked by the server — a launch adds its `registering` session here; eviction removes it. */
  readonly sessions: Map<string, Session>;
  /** Terminals this server owns — eviction closes the evicted launch's and drops it from the set. */
  readonly launchedSessions: Set<LaunchedSession>;
  /** The per-session UI event relays — reaped on eviction so an evicted ghost leaves none behind. */
  readonly eventRelays: SessionEventRelays;
  /** How long a session may stay `registering` before it is evicted (ms). */
  readonly registrationTimeoutMs: number;
}

/**
 * Canonicalize a working directory into the form the WORKER will report — the ONE function both
 * sides of the correlation go through, because a key canonicalized on only one side is a key that
 * never matches.
 *
 * The worker reports its own `getcwd(3)`, and that is the only spelling that matters: fully resolved,
 * symlinks followed, no trailing slash, no `.` / `..`, and — on a case-insensitive filesystem — with
 * the directory's REAL case, not the case the operator typed. An operator's string is none of those
 * things (`/tmp/proj` on macOS is really `/private/tmp/proj`; `/src/App/` may be typed `/src/app`).
 * It does NOT expand `~` — a shell does that before the path ever reaches the wire, and a `~` that
 * survives to here is a literal directory name.
 *
 * `realpathSync.NATIVE`, not `realpathSync`, is what closes that gap. They differ in exactly the way
 * that matters here: the JavaScript implementation resolves symlinks but preserves the case it was
 * given, while the native one goes through `realpath(3)` — the same kernel call `getcwd(3)` answers
 * from — and normalizes case too. On macOS's default (case-insensitive) filesystem the JS realpath of
 * `…/mixedcase` stays `…/mixedcase` while the process launched there reports `…/MixedCase`, so the
 * comparison misses; the native realpath answers `…/MixedCase` and it matches. `pending-launch.test.ts`
 * pins this against the kernel itself rather than against either implementation's docs: it asserts this
 * function agrees with what a process ACTUALLY launched at the path reports as its cwd.
 *
 * Falls back to a purely LEXICAL resolve when the path cannot be walked on this host (it was deleted
 * between the launch and the registration; a permission blocks the walk): a normalized absolute path
 * is still a far better key than the raw string, and — decisively — the §2 registration leg must
 * never throw over bookkeeping.
 */
export function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The launch pre-flight (#33): the canonical path to root a session at, or `undefined` when `cwd`
 * does not name an existing directory — it does not exist, it is a file, it is a dangling symlink,
 * it cannot be walked. The ingress answers that as the typed `invalid-cwd` failure, BEFORE any
 * backend spawns anything, so a doomed launch cannot even momentarily leave a child behind.
 *
 * Validate AND canonicalize in ONE seam, deliberately: the launch must be refused if the directory
 * is not real, and it must be ROOTED at the resolved path so the worker's own `getcwd(3)` echoes
 * back the key this registry stored. Splitting the two is exactly how you get a check that passes
 * while the correlation silently misses — and a missed correlation is not a benign no-op here, it
 * leaves an armed timer on a session that DID register.
 *
 * Synchronous by design: it runs once per launch, on a path the operator just typed, and an async
 * stat would buy nothing but a re-entrancy hazard on the ingress. Any error at all (`ENOENT`,
 * `ENOTDIR`, `EACCES`) reads as "not a usable directory" — fail closed.
 *
 * And deliberately NOT behind an injected port, unlike this codebase's other impure edges
 * (`PtySpawner`, `TmuxRunner`, `RandomBytesSource`). Those are injected because they are
 * nondeterministic or spawn processes, so a test cannot use the real thing. A directory lookup is
 * neither — and here a fake would be actively WORSE than the real filesystem: only a real directory
 * can tell you that `/tmp` resolves to `/private/tmp`, or that a case-variant path resolves to the
 * directory's real case, and those are the entire bug this function exists to prevent. A faked `stat`
 * would have answered whatever the test author believed, which is exactly the belief that was wrong.
 * The TOCTOU window against the spawn that follows is real but not material: a directory deleted in
 * that instant makes the backend fail, and the backend's failure is already typed and already leaves
 * no state behind.
 */
export function resolveLaunchCwd(cwd: string): string | undefined {
  try {
    // `.native` for the same reason {@link canonicalCwd} needs it — this is where the launch's key is
    // MINTED, so it must be minted in the worker's dialect or the two never meet.
    const resolved = realpathSync.native(resolve(cwd));
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Place a freshly-launched session in the registry as `registering` and arm its eviction timer —
 * the ONE seam a launch passes through, so no launch path can create a session that nothing will
 * ever reap. Returns the minted session id (the caller answers it to the operator, who can then
 * address the row they just created).
 *
 * The terminal handle is recorded in BOTH `launchedSessions` (so shutdown tears it down even while
 * it is still registering) and the pending record (so eviction can close that one specific
 * terminal). The timer is `.unref()`ed: a pending eviction alone must never hold the process open.
 */
export function trackPendingLaunch(
  state: PendingLaunchState,
  sessionId: string,
  options: SessionLaunchOptions,
  launched: LaunchedSession,
): void {
  // Canonicalized HERE rather than trusted from the caller: the stored cwd is one half of the key
  // every §2 registration is matched against, so the module that OWNS the key owns the form it takes
  // — a caller that forgot would not fail loudly, it would fail 10 seconds later by evicting a live
  // session. Idempotent: the ingress already rooted the terminal at this same resolved path.
  const cwd = canonicalCwd(options.cwd);
  state.sessions.set(sessionId, createRegisteringSession(sessionId, options.permissionMode));
  state.launchedSessions.add(launched);
  const timer = setTimeout(() => {
    // Fire-and-forget: the eviction's terminal half is asynchronous (it PROBES the surface before it
    // may close it, #35) and there is nobody here to await it. It never rejects, so nothing escapes.
    void evictPendingLaunch(state, sessionId);
  }, state.registrationTimeoutMs);
  timer.unref();
  state.pendingLaunches.set(sessionId, {
    sessionId,
    cwd,
    permissionMode: options.permissionMode,
    launched,
    timer,
    ambiguous: false,
    mayHoldLiveWorker: false,
  });
  markAmbiguousGroup(state, cwd, options.permissionMode);
}

/**
 * Mark EVERY pending launch that shares a (cwd, mode) pair ambiguous, once two or more of them exist
 * — the moment the correlation key stops identifying any single launch. A no-op for the ordinary case
 * of one launch per pair, which is exactly why an ordinary launch keeps the id it was handed.
 *
 * Applied to the WHOLE group, not just the newcomer, and never lifted: the first registration to
 * arrive could have come from any member of the group, so consuming one leaves the survivors just as
 * unidentifiable as they were.
 */
function markAmbiguousGroup(state: PendingLaunchState, cwd: string, permissionMode: PermissionMode): void {
  const group = [...state.pendingLaunches.values()].filter(
    (pending) => pending.cwd === cwd && pending.permissionMode === permissionMode,
  );
  if (group.length < 2) {
    return;
  }
  for (const pending of group) {
    // Re-`set` under the same key: a Map keeps its original insertion order when a key is overwritten,
    // so the group's launch order — which the claim walks oldest-first — survives the marking.
    state.pendingLaunches.set(pending.sessionId, { ...pending, ambiguous: true });
  }
}

/**
 * Match an incoming §2 registration to the pending launch that produced it and CONSUME that launch:
 * disarm its eviction timer and drop its pending record. Returns the session id the registration
 * should REUSE — so the `registering` row the operator is already watching advances in place to
 * `connecting` rather than a second row appearing beside it — or `undefined` when the caller must
 * mint a fresh id.
 *
 * Both sides of the key are put through {@link canonicalCwd} before they meet: the worker reports a
 * fully-resolved `getcwd(3)` and the operator typed a raw string, so comparing them verbatim would
 * miss on every symlinked, trailing-slashed, case-variant or relative path — and a MISSED claim is the
 * dangerous direction of this function. It leaves the timer armed on a session that DID register, and
 * the timer then closes a LIVE session's terminal out from under it.
 *
 * `undefined` is answered in two very different situations, and both are honest:
 *
 *   - **No pending launch on that pair** — this registration is not from anything this server
 *     launched; it is a UC1 attach, and it mints its own id exactly as it did before this module
 *     existed. Nothing is consumed.
 *   - **The matched launch is {@link PendingLaunch.ambiguous}** — two or more launches shared its
 *     (cwd, mode), so the key cannot say which terminal this worker is running in. The registration is
 *     NOT given that launch's id (a wrong id would cross-wire the operator's next steer into the other
 *     conversation, #20), its now-unadvanceable placeholder row is dropped, and — the part that matters
 *     — every SURVIVING member of the group is marked {@link PendingLaunch.mayHoldLiveWorker}.
 *
 * That last mark is what keeps the ambiguous case SAFE, and it is subtle enough to spell out. A claim
 * consumes the oldest match, but the worker that just registered could have been in ANY of the group's
 * terminals — so from this moment on, no terminal in that group can be proven dead. If two launches
 * share a directory and only ONE worker ever registers, the claim consumes the older record while the
 * younger one's timer is still armed; letting that timer close its terminal would be a coin flip that
 * kills the live session half the time (and leaves the actually-dead window behind). So an eviction
 * inside a claimed group still reaps the ROW — the operator's list stays honest, which is what AC3
 * promises — but no longer closes the TERMINAL, and the handle is left to shutdown. The residual cost
 * is a stray terminal window; the alternative is killing a live session, and those are not comparable.
 * (A launch token echoed back by the worker would remove the ambiguity entirely — see § Correlation.)
 *
 * A claimed terminal handle is deliberately NOT closed and NOT dropped from `launchedSessions` — the
 * session is alive now, and the server still owns its terminal until shutdown.
 */
export function claimPendingLaunch(
  state: PendingLaunchState,
  cwd: string,
  permissionMode: PermissionMode,
): string | undefined {
  // A worker reports an absolute `getcwd(3)`, always. A RELATIVE cwd on the §2 wire is therefore
  // malformed — and it is not harmlessly malformed: `canonicalCwd` would resolve it against the
  // DAEMON's own working directory, so a registration carrying `cwd: "."` could match a pending launch
  // rooted where the daemon happens to run, steal its id and disarm its eviction timer. Fail closed:
  // an unmatchable registration mints a fresh id, which is the safe outcome.
  if (!isAbsolute(cwd)) {
    return undefined;
  }
  const canonical = canonicalCwd(cwd);
  const claimed = oldestPendingLaunch(state, canonical, permissionMode);
  if (claimed === undefined) {
    return undefined;
  }
  clearTimeout(claimed.timer);
  state.pendingLaunches.delete(claimed.sessionId);
  if (!claimed.ambiguous) {
    return claimed.sessionId;
  }
  dropPlaceholder(state, claimed.sessionId);
  markGroupMayHoldLiveWorker(state, canonical, claimed.permissionMode);
  return undefined;
}

/**
 * Mark every pending launch left in a (cwd, mode) group as possibly holding the worker that just
 * registered — see {@link claimPendingLaunch}. From here their terminals are off-limits to eviction:
 * one of them may be the live session's, and nothing in the wire can say which.
 */
function markGroupMayHoldLiveWorker(state: PendingLaunchState, cwd: string, permissionMode: PermissionMode): void {
  for (const pending of [...state.pendingLaunches.values()]) {
    if (pending.cwd !== cwd || pending.permissionMode !== permissionMode || pending.mayHoldLiveWorker) {
      continue;
    }
    state.pendingLaunches.set(pending.sessionId, { ...pending, mayHoldLiveWorker: true });
  }
}

/**
 * The OLDEST pending launch on a (cwd, mode) pair, or `undefined` when none is waiting on it. Maps
 * preserve insertion order, so "first found" is "launched first" — the only ordering there is, and
 * (per {@link markAmbiguousGroup}) never one this module lets stand in for identity.
 */
function oldestPendingLaunch(
  state: PendingLaunchState,
  cwd: string,
  permissionMode: PermissionMode,
): PendingLaunch | undefined {
  for (const pending of state.pendingLaunches.values()) {
    if (pending.cwd === cwd && pending.permissionMode === permissionMode) {
      return pending;
    }
  }
  return undefined;
}

/**
 * Drop a pending launch's `registering` row and reap its UI relay — the half of teardown that is
 * about the SESSION rather than about its terminal. Shared by the two paths that leave a placeholder
 * row nothing will ever advance: eviction (the worker never came) and an ambiguous claim (a worker
 * came, but this row can no longer be proven to be the one it came from). Either way the row must go,
 * or it is an immortal ghost in `GET /api/sessions` with no timer left to reap it.
 */
function dropPlaceholder(state: PendingLaunchState, sessionId: string): void {
  state.sessions.delete(sessionId);
  closeSessionRelay(state.eventRelays, sessionId);
}

/**
 * EVICT a launch whose worker never registered — the ghost-reaper the timer fires (#33 AC3), and
 * the whole reason a launch is tracked at all.
 *
 * Idempotent and race-safe: a claim that landed first removed the record, so a timer that fires
 * afterwards finds nothing and does nothing — a session that DID register is never evicted out from
 * under itself.
 *
 * When the record IS still there, the SESSION half of the eviction is unconditional, and it is what
 * the AC asks for:
 *
 *   - the session is dropped from the registry — `GET /api/sessions` no longer shows it (the AC's
 *     "the session list no longer shows it");
 *   - its UI relay is reaped (#176) — a UI that subscribed to watch the session come up has its
 *     stream ended rather than left hanging on a session that will never exist.
 *
 * The TERMINAL half — closing the spawned child so a worker that hung on boot does not outlive the
 * session it failed to become, and dropping the handle so shutdown will not re-close it — is
 * conditional on being able to prove that terminal is dead. Two independent guards stand in front of
 * it, and they answer different questions:
 *
 *   1. **Is this terminal even ELIGIBLE to be reaped?** ({@link PendingLaunch.mayHoldLiveWorker}) —
 *      no, inside a (cwd, mode) group where some worker already registered without being attributable
 *      to a specific launch: the terminal being evicted may be the live session's. It is left open and
 *      left to shutdown, un-probed, because no reading could resolve the ambiguity anyway — the
 *      question there is "which terminal is the live worker in", and liveness cannot answer it.
 *   2. **Is it still OURS?** ({@link releaseLaunchedSession}, #35) — the surface is probed, and closed
 *      only if it is alive and still server-owned. This is the guard that matters most HERE, of
 *      anywhere in the server: an eviction fires ~10 seconds after launch, which is exactly the window
 *      in which a takeover happens. The operator launches a session, attaches to it at their desk, and
 *      drives it by hand — so no worker ever registers, which is precisely what this timer reads as
 *      "ghost". Without the probe, the reaper closes the window the operator is typing in: a launch
 *      that WORKED, reaped as a ghost. With it, the row is still evicted (the list stays honest, which
 *      is what AC3 promises) while the surface the operator took over is left running (#35 AC2).
 *
 * Reaping a stray window is a cost; killing a live session is a catastrophe, and between the two this
 * function does not gamble — at either guard.
 *
 * The handle is dropped from `launchedSessions` only when the surface is actually GONE (the release
 * tore it down, or found it already exited). A surface left running because the operator has it stays
 * owned by the server and is re-probed at shutdown — by then they may have detached and handed it
 * back. Forgetting it here would strand a live surface nothing will ever reap.
 *
 * The release itself is best-effort and never rejects ({@link releaseLaunchedSession} swallows a
 * `close()` that raced an already-gone window), so nothing can escape the timer callback that fires this.
 *
 * **The SESSION half is synchronous; only the TERMINAL half is awaited.** The row is dropped before the
 * returned promise is, so `GET /api/sessions` stops showing an evicted ghost the instant eviction runs,
 * regardless of how long probing its surface takes. The promise resolves once the terminal half has
 * settled — it exists because the probe made that half genuinely asynchronous, and a caller that must
 * know when a surface was actually released (a test, above all) should await the work rather than sleep
 * a guess at it. The timer that fires this in {@link trackPendingLaunch} ignores it, as it must: an
 * eviction is fire-and-forget from the timer's side.
 */
export async function evictPendingLaunch(state: PendingLaunchState, sessionId: string): Promise<void> {
  const pending = state.pendingLaunches.get(sessionId);
  if (pending === undefined) {
    // Already claimed (the worker registered) or already evicted — nothing to reap.
    return;
  }
  clearTimeout(pending.timer);
  state.pendingLaunches.delete(sessionId);
  dropPlaceholder(state, sessionId);
  if (pending.mayHoldLiveWorker) {
    // A worker registered somewhere in this launch's (cwd, mode) group and could be sitting in THIS
    // terminal. The row is gone (the list is honest), but the surface stays up — shutdown owns it now.
    return;
  }
  if ((await releaseLaunchedSession(pending.launched)) === "leave-running") {
    // The operator took this surface over (or its liveness could not be read). It is alive and not
    // ours to reap, so the server KEEPS the handle: if they detach before shutdown, shutdown's own
    // release will find it server-owned again and tear it down properly.
    return;
  }
  // The surface is gone — we closed it, or it had already exited. Nothing left for shutdown to do.
  state.launchedSessions.delete(pending.launched);
}

/**
 * Disarm every pending eviction — invoked on shutdown, before the launched terminals are released
 * wholesale ({@link releaseLaunchedSessions}). Without this, a server that closes while a launch is
 * still registering leaves an armed timer whose callback would run against a dead server's state.
 * The records are dropped, not evicted: shutdown releases every launched terminal anyway, so
 * evicting here would only double-release them.
 */
export function clearPendingLaunches(state: PendingLaunchState): void {
  for (const pending of state.pendingLaunches.values()) {
    clearTimeout(pending.timer);
  }
  state.pendingLaunches.clear();
}
