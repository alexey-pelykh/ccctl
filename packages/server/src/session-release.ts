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
