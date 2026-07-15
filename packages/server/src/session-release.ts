// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The SAFE-TEARDOWN rule (#35) — the "probe before you kill" policy every server teardown passes
 * through, so a session the operator has taken over locally is never killed by ccctl's own cleanup.
 * Traces to SRV-B-003 (safety).
 *
 * **The hazard, concretely.** A ccctl session's surface is a REAL terminal the operator can sit down
 * at — that is the launcher port's defining guarantee (`session-launcher.ts`), and the tmux backend
 * hands out the attach command to prove it (`select-window -t @3 ; attach -t ccctl`). So the surface
 * this server launched and the surface a human is typing in are THE SAME OBJECT. Every teardown path
 * therefore points at something that may, right now, have a person behind it. Before this module,
 * both of ccctl's teardowns closed unconditionally:
 *
 *   - **shutdown** ({@link releaseLaunchedSessions}) closed every tracked handle;
 *   - **the ghost-reaper timer** (`pending-launch.ts` § {@link evictPendingLaunch}) closed a launch's
 *     terminal ~10s after launch when no worker had registered — the sharper edge of the two, because
 *     a takeover is itself a reason no worker ever registers. That function spells out why its
 *     10-second window is exactly when a takeover happens.
 *
 * **The rule.** Read the surface's {@link SurfaceLiveness} FIRST, then act on it, and only one of the
 * four readings authorizes a kill ({@link RELEASE_BY_LIVENESS}). The asymmetry is the whole point and
 * it is deliberate: a surface we wrongly leave up is a stray terminal window the operator can close in
 * one keystroke, while a surface we wrongly kill is destroyed work with no undo. Those costs are not
 * comparable, so the rule does not balance them — it is biased, on purpose, and `unknown` is filed on
 * the safe side of that bias rather than being resolved into a guess.
 *
 * **Why a module, rather than a check at each teardown.** There are two teardown paths today and both
 * must obey; a check per path is two copies of a rule, and the second copy is the one someone forgets.
 * This is the same "single place a launch can be refused" discipline `launchSession`
 * (`ui-session-launch.ts`) applies to the other end of a session's life — one seam, so the HTTP and
 * programmatic paths cannot drift apart about which launches are legal. Here: one seam, so no teardown
 * can drift apart about which surfaces are killable.
 *
 * **Where the rule stops (stated plainly).** It is only ever as good as the reading a backend gives
 * it — this module has no window onto the process world of its own, by construction, and cannot
 * second-guess a backend that answers wrongly. What it does guarantee is that a backend which CANNOT
 * answer (a probe that throws, or one that returns a word outside the pinned set) is not silently
 * optimized into "kill it": both normalize to `unknown` at {@link readLiveness}, which is do-not-kill.
 * The per-backend readings themselves are specified and tested where they are produced —
 * `session-launcher-tmux.ts` and `session-launcher-pty.ts`.
 */

import { isSurfaceLiveness, type LaunchedSession, type SurfaceLiveness } from "./session-launcher.js";

/**
 * What a release DOES to a surface — the disposition the rule decides from a
 * {@link SurfaceLiveness} reading ({@link decideRelease}) and then applies
 * ({@link releaseLaunchedSession}). Decision and report are one vocabulary rather than two parallel
 * ones, because the rule faithfully executes what it decided: there is no outcome a disposition does
 * not already name.
 *
 *   - `tear-down` — close the surface (reap the child). The ONLY destructive disposition.
 *   - `leave-running` — the surface is up and is NOT ours to kill; walk away and leave it running.
 *   - `no-op` — the surface is already gone; there is nothing to do and nothing to report.
 *
 * `leave-running` and `no-op` are distinct despite both being non-destructive, and the difference is
 * the caller's, not the rule's: after `no-op` the surface is GONE (a caller may forget the handle),
 * while after `leave-running` it is very much alive and merely not ours right now — the operator may
 * detach at any moment and hand it back, so the server keeps the handle and re-probes at its next
 * teardown. Collapsing the two would make ccctl forget a live surface it still owns.
 */
export type ReleaseDisposition = "tear-down" | "leave-running" | "no-op";

/**
 * The ONE mapping from a {@link SurfaceLiveness} reading to what teardown may do about it — kept as a
 * single exhaustive record (a `Record<SurfaceLiveness, ReleaseDisposition>`, so a new reading cannot
 * be added without `tsc` demanding its disposition here) rather than scattered across the branches
 * that tear down. The same shape `LAUNCH_FAILURE_STATUS` (`ui-session-launch.ts`) uses for the other
 * closed set this package must decide over exhaustively.
 *
 * Read it as the safety property itself, because that is what it is: of four readings, exactly ONE —
 * `alive-server-owned`, the only one that says the surface is still ours — authorizes a kill. Every
 * other reading, including both the operator's (`taken-over`) and the honest non-answer (`unknown`),
 * leaves the surface alone. A leaked process is preferred over destroying live operator work; that
 * sentence is this table.
 */
const RELEASE_BY_LIVENESS: Record<SurfaceLiveness, ReleaseDisposition> = {
  // Alive, and nobody took it over — this server brought it up and it is still this server's to reap.
  "alive-server-owned": "tear-down",
  // Alive, and the OPERATOR has it: they are at the desk driving it by hand. Killing it destroys live
  // human work — the one thing teardown must never do (the AC's "is not killed").
  "taken-over": "leave-running",
  // Already gone (the worker exited, the operator closed the window). Nothing to close, no error to
  // raise: teardown of an already-exited surface is simply done (the AC's idempotent no-op).
  exited: "no-op",
  // The backend could not tell. NOT resolved into a guess — one of the two guesses kills live work, so
  // the ambiguous case is biased to not killing (the AC's "`unknown` … is treated as do not kill").
  unknown: "leave-running",
};

/**
 * Decide what a teardown may do to a surface reporting `liveness` — the rule, PURE over its input, so
 * the safety property is a table one can read rather than control flow one has to simulate. Total by
 * construction: every {@link SurfaceLiveness} has a disposition ({@link RELEASE_BY_LIVENESS}).
 *
 * Takes a reading a caller has already NARROWED to the pinned set; an unrecognized answer is
 * normalized to `unknown` at the boundary that receives it ({@link readLiveness}), not here — the
 * same split `isLaunchFailureCode` / `toLaunchFailure` draw between narrowing a foreign value and
 * deciding over a known one.
 */
export function decideRelease(liveness: SurfaceLiveness): ReleaseDisposition {
  return RELEASE_BY_LIVENESS[liveness];
}

/**
 * The FORCED half of the emergency-stop rule (#76) — what an operator who has EXPLICITLY asked for a
 * kill may do to a surface reporting `liveness`. Read it against {@link RELEASE_BY_LIVENESS} above:
 * the two tables differ in **exactly one cell**, and that cell is the whole of what `force` means.
 *
 * **`taken-over` → `tear-down` is the flipped cell, and the reason is not "the rule was too strict".**
 * #35 refuses to kill a taken-over surface because ccctl CANNOT KNOW whether a human is there, and a
 * wrong guess destroys live work with no undo. Force does not overrule that judgement — it dissolves
 * its premise. The operator who sends `force` is the human the rule was protecting, and they are
 * saying they want it stopped. The rule's question was never "should this be killable?" but "does
 * anyone want it killed?", and nobody could answer it until now. That is the safety valve #76 exists
 * to be: "let the operator force-stop a running session … for a free-running session that should be
 * halted immediately".
 *
 * **`unknown` → `leave-running` does NOT flip, and that is deliberate rather than timid.** The
 * tempting reading is that force means "kill it whatever you saw"; against the backends this codebase
 * actually ships, force-on-`unknown` is a NO-OP THAT LIES:
 *
 *   - the owned pty (#30) can never report it — that backend owns its child and observes its exit
 *     directly, so its probe is TOTAL (`alive-server-owned` / `exited`) and this cell is unreachable;
 *   - tmux (#29) reports it only when the tmux CLI could not be reached AT ALL — and, as that probe
 *     says, "a dead tmux server has taken our window with it". The surface is already gone. Worse:
 *     `close()` runs `kill-window` through the SAME runner the probe just failed on, and swallows its
 *     error — so a forced kill here would resolve `tear-down` having done nothing, and this server
 *     would report a session "stopped" that is not. That is the one answer an emergency-stop must
 *     never give (its whole value is that the operator can BELIEVE it);
 *   - and `unknown` is also where {@link readLiveness} files an answer OUTSIDE the pinned set. Forcing
 *     on it would kill on a word this server has just said it does not understand.
 *
 * So `unknown` stays on the do-not-kill side under force, matching the AC, which carves out exactly
 * `taken-over` ("do not kill a detached-taken-over session without an explicit force") and says
 * nothing about a reading nobody could take. `exited` needs no flip either — force cannot make a
 * surface that is already gone any more gone.
 *
 * **That argument is about the BACKENDS, though, not about the word — and the port is public, so say
 * where it stops.** {@link ISessionLauncher} and {@link SurfaceLiveness} ship from this package's entry
 * point, so a backend this repo has never seen could report `unknown` TRANSIENTLY — a host that timed
 * out, a probe that raced a reconnect — with a `close()` that works perfectly. Force is refused there
 * too, and for that backend the refusal is simply wrong: a killable surface this rule declines to kill.
 * The cell stays put anyway because the tie-breaker is not which reading is more likely but which error
 * an operator can survive. A refusal is visible and routable (`liveness-unknown` names the reading
 * rather than blaming a takeover, and the surface is still theirs to end by hand); a force that reports
 * "stopped" having done nothing is neither, and it ends their attention on a live runaway. What would
 * move this cell is a backend that can distinguish "I could not reach the host" from "I reached it and
 * it would not answer" — a distinction the port cannot express today, and the honest fix to make if a
 * third backend ever needs one.
 *
 * A `Record<SurfaceLiveness, ReleaseDisposition>` for the same reason {@link RELEASE_BY_LIVENESS} is
 * one: a new reading cannot be added without `tsc` demanding its FORCED disposition too, so the two
 * halves of the rule can never drift apart about a reading only one of them knows.
 */
const FORCED_STOP_BY_LIVENESS: Record<SurfaceLiveness, ReleaseDisposition> = {
  // Alive and ours — already killable unforced; force changes nothing.
  "alive-server-owned": "tear-down",
  // THE FLIPPED CELL. The operator has it, and the operator is the one asking. See above.
  "taken-over": "tear-down",
  // Already gone. Force cannot make it more gone.
  exited: "no-op",
  // NOT flipped: unreachable on the pty, already-gone-and-unkillable on tmux, and the home of an
  // answer this server could not narrow. Forcing here would report a kill that did not happen.
  unknown: "leave-running",
};

/**
 * Decide what an emergency STOP (#76) may do to a surface reporting `liveness`, given whether the
 * operator EXPLICITLY forced it — the rule, PURE over its inputs, exactly as {@link decideRelease} is.
 *
 * Unforced, this IS {@link decideRelease} — the same table, by delegation rather than by a copy of it.
 * That is load-bearing: an unforced stop is not "like" ccctl's own teardown, it IS ccctl's own
 * teardown, and a second table saying so in its own words would be exactly the second copy of a rule
 * this module opens by refusing to keep. Forced, it reads {@link FORCED_STOP_BY_LIVENESS} — where the
 * ONE flipped cell is a thing a reader can see, rather than an `if (force && liveness === "taken-over")`
 * buried in control flow.
 */
export function decideStop(liveness: SurfaceLiveness, force: boolean): ReleaseDisposition {
  return force ? FORCED_STOP_BY_LIVENESS[liveness] : decideRelease(liveness);
}

/**
 * Take one surface's liveness reading, FAILING CLOSED to `unknown` — the boundary between a backend's
 * answer and the rule that decides by it.
 *
 * Two ways a backend can fail to answer, one outcome, and it is the safe one:
 *
 *   - **the probe THREW** — tmux vanished mid-shutdown, a runner rejected, a native module is gone.
 *     The backend knows nothing about its surface, and "I cannot see it" must never be optimized into
 *     "it must be mine". Catching here is also what lets the port promise that a probe MAY reject
 *     ({@link LaunchedSession.liveness}), so no backend ever has to invent an answer to avoid throwing.
 *   - **the probe answered OUTSIDE the pinned set** — a drifted build, a hand-rolled handle, a value
 *     that crossed a module boundary. Narrowed through {@link isSurfaceLiveness} exactly as
 *     `isSessionLaunchError` narrows a foreign error's code, and for the same reason: a word this
 *     server does not know must not be read as one it does — least of all fall through to the kill.
 */
async function readLiveness(launched: LaunchedSession): Promise<SurfaceLiveness> {
  try {
    const reading = await launched.liveness();
    return isSurfaceLiveness(reading) ? reading : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * RELEASE one launched surface (#35): probe its liveness, decide by {@link RELEASE_BY_LIVENESS}, and
 * tear it down ONLY if it is still this server's. Returns the {@link ReleaseDisposition} it applied,
 * so a caller can tell "the surface is gone" (`tear-down` / `no-op` — forget the handle) from "it is
 * alive and not ours right now" (`leave-running` — keep the handle and re-probe at the next teardown).
 *
 * The ordering is the safety property, not an implementation detail: probe FIRST, act SECOND. A
 * release that closed and then probed would satisfy every verdict this function reports while killing
 * precisely the session it exists to spare, so `session-release.test.ts` pins the ORDER rather than
 * trusting the shape of the code.
 *
 * The close is BEST-EFFORT and never rejects: `close()` is idempotent and may find the surface already
 * gone (the operator closed the window in the instant between the probe and the close — a benign race,
 * and the AC's already-exited no-op arriving a moment late). Its reject is swallowed for the same
 * reason both callers already swallowed it: this runs inside a shutdown path and inside a timer
 * callback, where a stray reject is an unhandled rejection rather than anything anyone can act on.
 * Resolving `tear-down` there is honest — the surface is gone either way, which is what the caller
 * asked for and what the disposition reports.
 */
export async function releaseLaunchedSession(launched: LaunchedSession): Promise<ReleaseDisposition> {
  const disposition = decideRelease(await readLiveness(launched));
  if (disposition !== "tear-down") {
    return disposition;
  }
  try {
    await launched.close();
  } catch {
    // Best-effort: the surface may have gone in the instant since the probe. Nothing to act on, and a
    // reject escaping into a shutdown path or a timer callback helps no one.
  }
  return disposition;
}

/**
 * What one STOP did to a surface — the {@link ReleaseDisposition} it applied AND the
 * {@link SurfaceLiveness} it decided from. The reading is carried out because a stop, unlike ccctl's
 * own teardown, has SOMEONE TO ANSWER, and the two readings that decline a kill are not the same news:
 *
 *   - `taken-over` — "you have this open at your desk" (actionable: detach, or send `force`);
 *   - `unknown` — "the backend could not tell us" (a different fact, and a different fix).
 *
 * {@link ReleaseDisposition} collapses both to `leave-running`, which is exactly right for a teardown
 * (both mean do-not-kill and there is nobody to tell) and exactly wrong for a request whose caller is
 * waiting to be told WHY. Reporting a refusal as "you have it open" when the truth is "tmux did not
 * answer" fabricates a claim the operator would act on — the thing this codebase refuses to do
 * everywhere it would be easy (`atCapacityReason` names the real numbers; `at-capacity` ships no
 * guessed `Retry-After`). Carrying the reading the rule ALREADY read is also what keeps the answer
 * honest: re-probing to build the message would be reading the surface twice and reporting the second
 * one, which can differ from the one the decision was made on.
 */
export interface StopOutcome {
  /** What the stop DID — the disposition {@link decideStop} authorized and this function applied. */
  readonly disposition: ReleaseDisposition;
  /** The reading it was decided FROM — so a refusal can say which refusal it is. */
  readonly liveness: SurfaceLiveness;
}

/**
 * How long a stop waits for a surface's `close()` to finish before giving up on it (5s) — generous
 * next to a healthy teardown (a signalled worker reaps in milliseconds) and short enough that an
 * operator gets an answer rather than a spinner.
 *
 * It exists because **#76 is the first `close()` caller with anyone waiting on it.** The port lets
 * `close()` take as long as it takes, and the owned pty (#30) takes that literally: it signals the
 * child and then `await`s the child's own exit, UNBOUNDED, because "teardown is not 'done' until it
 * has exited" (`session-launcher-pty.ts`). Under the two callers that existed before this one that is
 * exactly right and costs nothing — shutdown is already ending, and the ghost-reaper's timer is
 * fire-and-forget, so neither has a deadline to miss. A stop does. A child that does not die on the
 * signal (the pty's `kill()` sends SIGHUP; a wedged or signal-ignoring worker outlives it) leaves that
 * `await` pending forever, and the HTTP request holding it never answers — which also keeps
 * `httpServer.close()` from ever completing, since Node will not close a server with a live request on
 * it. One stuck child would take the daemon's shutdown with it.
 *
 * The bound is on the STOP path only, deliberately: it is the caller's deadline, not a new contract on
 * the port, so no backend has to learn about it and shutdown's own teardown keeps its existing (and
 * correct) "wait for the reaping" behavior.
 */
export const STOP_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * Await a surface's `close()` for at most `timeoutMs`, REJECTING if it outlives that — the bound
 * {@link STOP_TEARDOWN_TIMEOUT_MS} explains.
 *
 * The timer is `.unref()`ed (a pending stop must never hold the process open) and always cleared, so
 * a fast close does not leave a 5-second handle behind on the loop.
 *
 * **No sink is needed on the abandoned close, and the reason is worth stating because the opposite is
 * the intuitive guess.** When the timeout wins, `closing` is still pending and nothing here awaits it
 * any more — which looks exactly like the setup for an unhandled rejection if that close rejects a
 * minute later. It is not: `Promise.race` has already attached its own handlers to BOTH promises, so
 * `closing` counts as handled for the rest of its life no matter who won. (Verified rather than
 * reasoned: the same race, sink deleted, late-rejecting loser — zero unhandled rejections.) A
 * `.catch(() => {})` here would be a line whose only justification is a hazard that does not exist.
 */
async function closeWithinTimeout(launched: LaunchedSession, timeoutMs: number): Promise<void> {
  const closing = launched.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the surface did not finish closing within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([closing, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * STOP one launched surface at the operator's explicit request (#76): probe its liveness, decide by
 * {@link decideStop} (honoring `force`), tear it down only if that authorizes it — and then CHECK THAT
 * THE TEARDOWN ACTUALLY HAPPENED. The emergency-stop sibling of {@link releaseLaunchedSession} — same
 * probe-FIRST-act-SECOND ordering, same single seam, two deliberate differences (both below, and both
 * the same difference underneath: a stop has someone to answer).
 *
 * Both live here rather than one of them at a call site because this module is where the answer to
 * "may this surface be closed?" is kept, and there is now more than one asker. A forced `close()`
 * reached from a handler would be a SECOND unguarded edge — and the port names exactly one: "a direct
 * `close()` is the unguarded edge and is reserved for the rule itself" ({@link LaunchedSession.close}).
 * It would also have to re-implement {@link readLiveness}'s fail-closed narrowing, which is the most
 * safety-critical code in this file and the last thing that should exist twice.
 *
 * **A failed `close()` REJECTS here, where {@link releaseLaunchedSession} swallows it — and that is
 * not an inconsistency.** Read that swallow's own reason: it runs "inside a shutdown path and inside a
 * timer callback, where a stray reject is an unhandled rejection rather than anything anyone can act
 * on". A stop is neither. It is a request, with an operator on the other end of it, and the ONE thing
 * they need from an emergency-stop is to be able to believe its answer. Swallowing here would resolve
 * `tear-down` — "stopped" — on a surface that is still running, which is worse than any error: it
 * ends the operator's attention on a session that needed it. The rationale did not transfer, so
 * neither did the behavior; the caller maps the reject to a typed `stop-failed` (`ui-session-stop.ts`).
 *
 * **And a `close()` that RESOLVES is a claim, not a proof — so the stop re-reads the surface.** This is
 * the same sentence as the paragraph above, applied to the failure mode that does not announce itself.
 * `close()` resolving means "the backend believes it is done", and a backend can believe that while the
 * surface is up: the owned pty latches `closed` before it awaits the reaping, so once a close has been
 * ABANDONED by {@link closeWithinTimeout} above, every later `close()` on that handle returns
 * instantly — cheerfully, and to a still-running child. Without this check the operator's retry after a
 * `stop-failed` would answer "stopped" about the very session that just refused to die, which is the
 * one answer {@link FORCED_STOP_BY_LIVENESS} spends a paragraph refusing to give for `unknown`. A rule
 * cannot argue that and then trust an unverified close two functions later.
 *
 * The re-read only CONTRADICTS on `alive-server-owned` — the single reading that PROVES the close did
 * not work. `exited` is the success it expects; `unknown` and `taken-over` are ambiguous and are read
 * as "cannot contradict the close" rather than as failure. Fail-OPEN, unusually for this module — but
 * this is a check on OUR OWN work rather than the do-not-kill rule, and its two errors are not
 * symmetrical: what it catches is a live runaway reported dead, and what it would cost is telling the
 * operator to go hunt a session that is already gone.
 *
 * **What fail-open lets through, stated rather than glossed.** The benign `unknown` is a tmux window
 * that died along with the tmux server that went down in the same instant — nothing to report. But
 * tmux's `close()` swallows EVERY `kill-window` error, so a kill that failed is only ever catchable
 * here; and if the runner is broken rather than the window, this probe reads `unknown` from that same
 * broken runner and cannot contradict. So a live tmux window CAN still be reported stopped, in the
 * narrow race where the runner breaks between the decision probe and the kill (a window ~two tmux
 * spawns wide, and one a single failing `kill-window` does not open — that leaves the window up and is
 * caught, read back as `alive-server-owned`). Closing it properly needs the port to distinguish "I
 * could not reach the host" from "I reached it and the window is up" — the same missing distinction
 * {@link FORCED_STOP_BY_LIVENESS} names for `unknown`, and the same honest fix.
 *
 * The destructive path pays for the extra probe; `no-op` and `leave-running` never reach it.
 */
export async function stopLaunchedSession(
  launched: LaunchedSession,
  force: boolean,
  timeoutMs: number = STOP_TEARDOWN_TIMEOUT_MS,
): Promise<StopOutcome> {
  const liveness = await readLiveness(launched);
  const disposition = decideStop(liveness, force);
  if (disposition !== "tear-down") {
    return { disposition, liveness };
  }
  // Deliberately UNGUARDED — see above. A close that fails must reach the operator, not a `catch`.
  await closeWithinTimeout(launched, timeoutMs);
  if ((await readLiveness(launched)) === "alive-server-owned") {
    throw new Error("the surface reported a successful close but is still running");
  }
  return { disposition, liveness };
}
