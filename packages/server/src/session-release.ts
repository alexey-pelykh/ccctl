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
 * five readings authorizes a kill ({@link RELEASE_BY_LIVENESS}). The asymmetry is the whole point and
 * it is deliberate: a surface we wrongly leave up is a stray terminal window the operator can close in
 * one keystroke, while a surface we wrongly kill is destroyed work with no undo. Those costs are not
 * comparable, so the rule does not balance them — it is biased, on purpose, and BOTH non-answers
 * (`host-unreachable`, `surface-indeterminate`) are filed on the safe side of that bias rather than
 * being resolved into a guess. #197 split those two apart, but not here: the split changed what FORCE
 * and the post-close re-read may do with them, and ccctl's own unprompted teardown — which has no
 * operator asking for anything — treats a surface it cannot read as untouchable either way.
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
 * optimized into "kill it": both normalize to `host-unreachable` at {@link readLiveness}, which is
 * do-not-kill under every table here, forced or not.
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
 * Read it as the safety property itself, because that is what it is: of five readings, exactly ONE —
 * `alive-server-owned`, the only one that says the surface is still ours — authorizes a kill. Every
 * other reading, including the operator's (`taken-over`) and both honest non-answers
 * (`host-unreachable`, `surface-indeterminate`), leaves the surface alone. A leaked process is
 * preferred over destroying live operator work; that sentence is this table.
 *
 * **The two non-answers share a cell here, and #197's split does NOT reach this table.** Elsewhere
 * they diverge, because elsewhere someone is ASKING: force can spend a kill down a channel it knows
 * works ({@link FORCED_STOP_BY_LIVENESS}), and a post-close re-read can refuse to believe one taken
 * down a channel it knows is broken ({@link stopLaunchedSession}). This table has neither. It is
 * ccctl's OWN unprompted teardown — shutdown, and a timer — where nobody asked for anything and there
 * is nobody to answer. "The channel works" would license a kill that no operator requested, on a
 * surface this rule cannot see, purely because the not-seeing was of a tidier kind. That is not a
 * reason to kill; it is the same guess under a better name.
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
  // Could not reach the host that would know. NOT resolved into a guess — one of the two guesses kills
  // live work, so the ambiguous case is biased to not killing (the AC's "`unknown` … is treated as do
  // not kill", which #197 split in two without moving either half off this side).
  "host-unreachable": "leave-running",
  // Reached the host; it would not say. The channel works — which is exactly the fact FORCE trades on
  // and this table has no use for: nobody asked us to kill anything. See above.
  "surface-indeterminate": "leave-running",
};

/**
 * Decide what a teardown may do to a surface reporting `liveness` — the rule, PURE over its input, so
 * the safety property is a table one can read rather than control flow one has to simulate. Total by
 * construction: every {@link SurfaceLiveness} has a disposition ({@link RELEASE_BY_LIVENESS}).
 *
 * Takes a reading a caller has already NARROWED to the pinned set; an unrecognized answer is
 * normalized to `host-unreachable` at the boundary that receives it ({@link readLiveness}), not here —
 * the same split `isLaunchFailureCode` / `toLaunchFailure` draw between narrowing a foreign value and
 * deciding over a known one.
 */
export function decideRelease(liveness: SurfaceLiveness): ReleaseDisposition {
  return RELEASE_BY_LIVENESS[liveness];
}

/**
 * The FORCED half of the emergency-stop rule (#76) — what an operator who has EXPLICITLY asked for a
 * kill may do to a surface reporting `liveness`. Read it against {@link RELEASE_BY_LIVENESS} above:
 * the two tables differ in **exactly two cells**, and those cells are the whole of what `force` means.
 * They are the same sentence twice: force is the operator supplying a fact the rule was missing, and
 * it may be spent only where the kill it authorizes can actually LAND.
 *
 * **`taken-over` → `tear-down` is the first flipped cell, and the reason is not "the rule was too
 * strict".**
 * #35 refuses to kill a taken-over surface because ccctl CANNOT KNOW whether a human is there, and a
 * wrong guess destroys live work with no undo. Force does not overrule that judgement — it dissolves
 * its premise. The operator who sends `force` is the human the rule was protecting, and they are
 * saying they want it stopped. The rule's question was never "should this be killable?" but "does
 * anyone want it killed?", and nobody could answer it until now. That is the safety valve #76 exists
 * to be: "let the operator force-stop a running session … for a free-running session that should be
 * halted immediately".
 *
 * **`surface-indeterminate` → `tear-down` is the second, and it is what #197 bought.** The backend
 * REACHED the host and the host would not say — so this rule does not know what the surface is, but it
 * does know the channel to it WORKS. That is precisely the premise a forced kill needs: `close()` will
 * travel. The operator asked for a kill and a kill is what they get. Force is refused here only if one
 * believes force means "kill it only when we already knew enough not to need force", which is not a
 * rule, it is a tautology.
 *
 * **This cell is only safe BECAUSE of a rule that lives elsewhere, so do not read it alone.** A kill
 * that travels is not a kill that landed, and this table cannot tell the difference — a backend may be
 * coy AND have a `close()` that silently fails (tmux's swallows every `kill-window` error). What makes
 * the flip honest is {@link stopLaunchedSession}'s CONFIRMATION rule: a kill decided on a reading that
 * saw nothing must be positively confirmed `exited`, never merely un-refuted. Without it this cell
 * reports "stopped" over a live runaway — the exact answer the cell below spends a paragraph refusing
 * to give. The two are one design; changing either without the other re-opens the sin.
 *
 * **`host-unreachable` → `leave-running` does NOT flip, and that is deliberate rather than timid.**
 * The tempting reading is that force means "kill it whatever you saw"; where the host itself could not
 * be reached, force is a NO-OP THAT LIES:
 *
 *   - the owned pty (#30) can never report it — that backend owns its child and observes its exit
 *     directly, so its probe is TOTAL (`alive-server-owned` / `exited`) and this cell is unreachable;
 *   - tmux (#29) reports it only when the tmux CLI could not be reached AT ALL — and, as that probe
 *     says, "a dead tmux server has taken our window with it". The surface is already gone. Worse:
 *     `close()` runs `kill-window` through the SAME runner the probe just failed on, and swallows its
 *     error — so a forced kill here would resolve `tear-down` having done nothing, and this server
 *     would report a session "stopped" that is not. That is the one answer an emergency-stop must
 *     never give (its whole value is that the operator can BELIEVE it);
 *   - and `host-unreachable` is also where {@link readLiveness} files an answer OUTSIDE the pinned set.
 *     Forcing on it would kill on a word this server has just said it does not understand.
 *
 * The unifying reason is one sentence: **a kill cannot travel a channel that is down.** Force gives
 * this rule the operator's consent, which is the only thing `taken-over` was missing; it cannot give
 * it a working runner, which is the thing this cell is missing. Consent does not reconnect a socket.
 * So `host-unreachable` stays on the do-not-kill side under force, matching the AC, which carves out
 * exactly `taken-over` ("do not kill a detached-taken-over session without an explicit force") and says
 * nothing about a reading nobody could take. `exited` needs no flip either — force cannot make a
 * surface that is already gone any more gone.
 *
 * **What the split cost, stated rather than glossed — a backend that reports the wrong half.** Before
 * #197 both non-answers were one word and force flipped neither, so a backend could not mislead this
 * table about them. Now it can: a backend that reports `surface-indeterminate` when its channel is in
 * fact broken will have a forced kill spent down that broken channel. It does not become a lie, and the
 * reason is the confirmation rule above rather than anything this table knows: the re-read will not read
 * `exited` (nothing was killed), so the operator is told `stop-failed`. But it is a refusal reached the
 * long way — a kill attempted where the old rule would not have tried. That residue is why
 * {@link SurfaceLiveness} tells backends to report `host-unreachable` when in doubt, and why the pty's
 * probe stays total rather than growing a cautious `catch`.
 *
 * A `Record<SurfaceLiveness, ReleaseDisposition>` for the same reason {@link RELEASE_BY_LIVENESS} is
 * one: a new reading cannot be added without `tsc` demanding its FORCED disposition too, so the two
 * halves of the rule can never drift apart about a reading only one of them knows.
 */
const FORCED_STOP_BY_LIVENESS: Record<SurfaceLiveness, ReleaseDisposition> = {
  // Alive and ours — already killable unforced; force changes nothing.
  "alive-server-owned": "tear-down",
  // FLIPPED CELL 1. The operator has it, and the operator is the one asking. See above.
  "taken-over": "tear-down",
  // Already gone. Force cannot make it more gone.
  exited: "no-op",
  // NOT flipped: unreachable on the pty, already-gone-and-unkillable on tmux, and the home of an
  // answer this server could not narrow. A kill cannot travel a channel that is down, so forcing here
  // would report a kill that did not happen.
  "host-unreachable": "leave-running",
  // FLIPPED CELL 2 (#197). We reached the host, so the kill will TRAVEL — and the post-close re-read
  // verifies that it landed. Unforced this is do-not-kill like every other non-answer; forced, the
  // operator has supplied the one thing missing, and nothing about the channel stands in the way.
  "surface-indeterminate": "tear-down",
};

/**
 * Decide what an emergency STOP (#76) may do to a surface reporting `liveness`, given whether the
 * operator EXPLICITLY forced it — the rule, PURE over its inputs, exactly as {@link decideRelease} is.
 *
 * Unforced, this IS {@link decideRelease} — the same table, by delegation rather than by a copy of it.
 * That is load-bearing: an unforced stop is not "like" ccctl's own teardown, it IS ccctl's own
 * teardown, and a second table saying so in its own words would be exactly the second copy of a rule
 * this module opens by refusing to keep. Forced, it reads {@link FORCED_STOP_BY_LIVENESS} — where the
 * TWO flipped cells are a thing a reader can see, rather than an `if (force && (liveness ===
 * "taken-over" || liveness === "surface-indeterminate"))` buried in control flow. That the flipped set
 * GREW (#197) without this function changing a line is the table's whole return on being a table.
 */
export function decideStop(liveness: SurfaceLiveness, force: boolean): ReleaseDisposition {
  return force ? FORCED_STOP_BY_LIVENESS[liveness] : decideRelease(liveness);
}

/**
 * Take one surface's liveness reading, FAILING CLOSED to `host-unreachable` — the boundary between a
 * backend's answer and the rule that decides by it.
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
 *
 * **Why `host-unreachable` is the fail-closed target and not `surface-indeterminate` (#197).** Of the
 * five readings it is the most conservative — the ONLY one that is do-not-kill even under force AND is
 * refused as evidence by the post-close re-read. Both of the above are cases where this server learned
 * NOTHING: a throw means the ask itself did not complete, and a word outside the set means the answer
 * was unintelligible, which is not better than silence. Filing either under `surface-indeterminate`
 * would assert the one thing neither establishes — that the channel works — and would hand force a
 * premise this function has no basis for. Failing closed means choosing the reading that assumes least,
 * and that is this one.
 */
async function readLiveness(launched: LaunchedSession): Promise<SurfaceLiveness> {
  try {
    const reading = await launched.liveness();
    return isSurfaceLiveness(reading) ? reading : "host-unreachable";
  } catch {
    return "host-unreachable";
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
 * own teardown, has SOMEONE TO ANSWER, and the three readings that decline a kill are not the same news:
 *
 *   - `taken-over` — "you have this open at your desk" (actionable: detach, or send `force`);
 *   - `host-unreachable` — "the backend could not reach the host that would tell us" (a different fact,
 *     and one nothing the operator can send will change);
 *   - `surface-indeterminate` — "the backend reached the host and it would not say" (different again,
 *     and actionable: `force` resolves this one, #197).
 *
 * {@link ReleaseDisposition} collapses all three to `leave-running`, which is exactly right for a teardown
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
 * instantly — cheerfully, and to a still-running child. tmux's close latches the same way, one line
 * before its `kill-window`, so this is not the pty's quirk but the shape of an idempotent teardown.
 * Without this check the operator's retry after a `stop-failed` would answer "stopped" about the very
 * session that just refused to die, which is the one answer {@link FORCED_STOP_BY_LIVENESS} spends a
 * paragraph refusing to give for `host-unreachable`. A rule cannot argue that and then trust an
 * unverified close two functions later.
 *
 * The re-read CONTRADICTS on three readings — two SIGHTINGS and one blindness:
 *
 *   - **`alive-server-owned`** and **`taken-over`** — the readings that PROVE the close did not work.
 *     Both are positive sightings of a live surface; they disagree only about WHO holds it, which is
 *     the decision probe's question, not this one's. Here, existing is the whole finding. `taken-over`
 *     is not an ambiguity this rule is being cautious about: the port defines it as "the surface is up,
 *     and the operator has it", and tmux reports it only for a window still in its enumeration — a
 *     killed window is not listed and reads `exited`. So there is no such thing as a `taken-over`
 *     reading of a closed surface, and a backend that produced one would be contradicting the port.
 *   - **`host-unreachable`** — the reading that proves this server CANNOT KNOW whether the close
 *     worked. Not the same fact, and not a lesser one: it is a `close()` no observation confirmed.
 *
 * `exited` is the success it expects; only `surface-indeterminate` is genuinely ambiguous — a reachable
 * host DECLINING to describe a surface — and it alone is read as "cannot contradict the close" rather
 * than as failure. Fail-OPEN there, unusually for this module, because that is a check on OUR OWN work
 * rather than the do-not-kill rule, and what it would cost is telling the operator to go hunt a session
 * that is already gone.
 *
 * **…with ONE exception, and it is the exception that makes force-on-`surface-indeterminate` safe: a
 * kill decided on a reading that SAW NOTHING must be CONFIRMED, not merely un-refuted.** Fail-open
 * leans on a fact the ordinary stop has and this one does not — that the DECISION probe saw the
 * surface. A stop that read `alive-server-owned`, closed, and then got a coy answer is choosing between
 * two stories about a surface it definitely observed, and the close is the better-evidenced one. But
 * when force flipped `surface-indeterminate`, the decision probe did not see the surface EITHER: no
 * observation anywhere in this stop ever established what it was, before or after. Falling open there
 * is not "trusting our own work", it is reporting a teardown that nothing at all witnessed — the same
 * emptiness this function rejects one branch above for `host-unreachable`, arriving by a different
 * road. So on that path only `exited` — the reading that positively proves the surface gone — is a
 * success, and every other answer is `stop-failed`.
 *
 * **This rule is not free, and it is not free for #197's OWN backend — say so.** The tempting sentence
 * is that the issue's case (indeterminacy reported TRANSIENTLY, "with a `close()` that works perfectly")
 * passes this check unchanged, because a close that lands reads `exited` right after. That does not
 * follow. `surface-indeterminate` means the host WOULD NOT SAY; a backend coy because it is loaded is
 * likely to still be coy a millisecond later, and the kill landing does not make it talk. Such a stop —
 * surface genuinely gone — is REJECTED here, and the retry does not rescue it: the re-read is coy again,
 * so it is `stop-failed` until a restart. (What the retry DOES is backend-specific and does not change
 * that. The port asks `close()` for idempotence, not for a latch — a conforming backend may re-send its
 * kill, and both shipped ones instead latch and send nothing. Either way the refusal is driven by the coy
 * re-read, not by the second kill.) The flip's target backend passes only when the transience clears
 * inside the close → re-read window.
 *
 * The rule is kept because it CANNOT tell that backend from the other one, which is the entire reason it
 * exists: a backend can be coy AND have a `close()` that silently fails, exactly as tmux's does (it
 * swallows every `kill-window` error). Without this rule that backend gets a forced kill, a swallowed
 * failure, a coy re-read, and a `200 { outcome: "stopped" }` over a live runaway — the module's cardinal
 * sin, made newly reachable by the very flip that is supposed to be an improvement. Two surfaces nobody
 * ever saw, distinguishable only by which one is fatal to guess wrong about; the alarm is the same trade
 * this module takes everywhere else. The flip earns its safety from the verification, not the reading.
 *
 * **Why `host-unreachable` moved to the contradicting side (#197), when it used to fail open.** It is
 * the reading tmux gives when its CLI could not be reached — and tmux's `close()` swallows EVERY
 * `kill-window` error, so a kill that failed is ONLY ever catchable here. Under the old single
 * `unknown` this probe read the failure from that same broken runner and could not contradict it, so a
 * live tmux window could still be reported stopped, in the narrow race where the runner breaks between
 * the decision probe and the kill. The split is what makes the difference legible: an unreachable host
 * means the kill went into a channel that was down and the verification came back from that same down
 * channel. Two unknowns do not make a success; believing the close there is believing NOBODY.
 *
 * **What contradicting it costs, stated rather than glossed — this is a real trade, and the cost is
 * bigger than a wasted trip.** The benign `host-unreachable` is a tmux window that died along with the
 * tmux server: the surface IS gone, and this now reports `stop-failed` about it. Worse, the stop's OWN
 * successful kill can CAUSE that reading rather than merely coincide with it — killing the last window
 * of the ccctl session destroys the session, and with no other session the tmux server exits, so the
 * very next `list-windows` finds nothing to talk to. (Narrow: the session's bootstrap window normally
 * survives, so a worker window is not the last one. Not impossible.)
 *
 * And the cost does not stop at the message. This function REJECTS, so `stopSession`
 * (`ui-session-stop.ts`) never reaches its retirement block: the handle, the row, the pending launch and
 * the worker channel all survive, the session stays listed, and the operator's retry now reads
 * `host-unreachable` at the DECISION probe and is refused `409 liveness-unknown` — "forcing would not
 * help". So the true cost is a session that is over, still listed, and unstoppable through the API until
 * a tmux server exists again or the daemon restarts. Say that plainly rather than "they go and check".
 *
 * It is accepted anyway, because the two errors still are not comparable. A stuck row is visible, inert
 * and kills nothing, and the daemon restart named above does clear it. That restart is the WHOLE
 * recovery story, and it is worth resisting the urge to pad it: the reaper (#34) does not collect this.
 * It is gated on a `livenessProbe` that no production caller configures — its own module says so twice
 * ("the reaper is a verified no-op today", `session-reconcile.ts`) — and even fully wired it runs at
 * startup, BEFORE the listener opens, so it could never reach a row stuck in a RUNNING daemon. Citing it
 * here would be this codebase's own "status ≠ gate" mistake, against a safety trace (SRV-B-003), in the
 * one paragraph whose job is to price the cost honestly.
 *
 * "Stopped" about a live runaway is none of those things: it ends the operator's attention on the one
 * session that needed it, which is the single failure an emergency-stop exists to prevent. Between an
 * alarm that is sometimes needless and a silence that is sometimes fatal, this module takes the alarm,
 * exactly as it does everywhere else it has had to choose. The refusal is at least honest about itself:
 * `stop-failed` says the teardown could not be COMPLETED, never that the surface is up.
 *
 * **And the `taken-over` contradiction costs MORE than that one, so it does not get to be the quiet
 * clause.** Where an unreachable host at least implies a dead tmux server (a restart is coming anyway),
 * the poisoned-handle path leaves a LIVE runaway that is permanently unstoppable through the API: force
 * a taken-over window, have `kill-window` fail, and tmux's close has already latched — so the retry
 * sends no kill, re-reads `taken-over`, and is refused here, forever, while the surface keeps running.
 * That is the sharper edge of the trade and it is stated deliberately. Two things justify it. It is not
 * new: the identical latch already shaped the `alive-server-owned` contradiction, which is the same rule
 * on a window nobody took. And the alternative is strictly worse — falling open there returned
 * `200 { outcome: "stopped" }` about that same live runaway, which is the cardinal sin bought at the
 * price of the operator never learning. A door that will not open beats a door that lies about being
 * shut; the operator still has tmux, and the daemon restart still collects the row.
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
  const verdict = await readLiveness(launched);
  if (verdict === "alive-server-owned" || verdict === "taken-over") {
    // Both are POSITIVE SIGHTINGS of a live surface, and a sighting refutes the close outright. They
    // differ only in who holds it, which is a question for the DECISION probe and not for this one:
    // here the surface's mere existence is the whole finding. (`taken-over` is not this rule being
    // cautious about an ambiguity — the port defines it as "the surface is up, and the operator has
    // it", and tmux only reports it for a window still in its enumeration; a killed window is not
    // listed and reads `exited`.)
    throw new Error("the surface reported a successful close but is still running");
  }
  if (verdict === "host-unreachable") {
    // #197: the close claimed success and the host that would confirm it cannot be reached — through
    // the same channel the close itself travelled. Nothing observed this teardown, so nothing may
    // report it as one. (tmux swallows `kill-window`'s error, so this is the only place a failed kill
    // is catchable at all.)
    throw new Error("the surface reported a successful close but its host could not be reached to confirm it");
  }
  if (liveness === "surface-indeterminate" && verdict !== "exited") {
    // #197, the CONFIRMATION rule — see above. Force killed a surface NOBODY had seen, so the usual
    // fail-open has nothing to fall back on: the decision probe did not observe this surface either.
    // Only `exited` proves the kill landed; anything else is a stop reporting a teardown that no
    // observation anywhere supports.
    throw new Error("the surface reported a successful close but nothing has ever confirmed it is gone");
  }
  return { disposition, liveness };
}
