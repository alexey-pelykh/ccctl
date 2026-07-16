// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — emergency-stop logic (pure, DOM-free).
 *
 * The safety-valve leg of the zero-build UI (#77, `UI-B-012`). Where `launch.js` owns the control
 * that brings a session INTO BEING, this module owns the one that ENDS it: what a stop looks like
 * on the wire, and how the server's answer — a kill, an already-dead surface, or a TYPED refusal —
 * reads back to the operator.
 *
 * `app.js` is the thin shell: it reads the selected session, builds a body here, POSTs it to
 * {@link sessionStopPath}, and paints whatever this module says the answer means. Keeping the
 * build/decode decisions here (DOM-free) makes the whole stop contract unit-testable without a
 * browser, exactly as the launch / decode / steer / list decisions are.
 *
 * **Why the path lives here and not in `command.js`, beside the other per-session legs.** A stop is
 * not a steer. `command.js` is the STEER module, and the server is emphatic that the two verbs are
 * opposites (`ui-session-stop.ts`): `interrupt` ASKS the worker to stop and needs it listening; a
 * stop KILLS THE SURFACE THE WORKER RUNS ON and needs only the handle the server has held since it
 * launched it — which is precisely why a stop is NOT a `/command` subtype server-side (a command
 * fails closed with no live worker channel, and those are exactly the sessions an emergency-stop is
 * FOR). Filing the stop path under the steer module would blur the boundary the server took pains to
 * draw. `devices.js` owns `DEVICES_PATH` for the same reason; `launch.js` defines no path only
 * because a launch POSTs to the collection root the list already GETs.
 *
 * The cost of that split is visible right below: this is the FIRST leaf module here to import a
 * sibling (the other seven import nothing at all), because owning the stop path still means building
 * it on the session root `command.js` owns. That is the trade taken deliberately — a route root used
 * by two modules is a CONTRACT, and a second hand-copy of `SESSIONS_PATH` could drift from the first
 * silently, which is exactly the failure the mirrored-constants note below accepts only where there
 * is no alternative. A one-line `trimmed` re-declared per module is cheap; a duplicated route root is
 * not.
 *
 * The server shapes are MIRRORED here as constants, deliberately NOT imported: this module is served
 * to the browser as-is (no bundler, no build), so it stays dependency-free vanilla ESM. The mirrored
 * contract (`ui-session-stop.ts`, camelCase per ADR-001):
 *
 *   request  → SessionStopOptions = { force?: boolean }
 *   200      → StopAcceptedWire   = { sessionId: string, outcome: StopOutcomeWire, status: SessionStatus }
 *   StopOutcomeWire               = "stopped" | "already-exited"
 *   failure  → StopFailureWire    = { error: string, code: StopFailureCode }
 *
 * `StopFailureCode` is the pinned discriminant that says WHICH refusal it is, so the operator is told
 * what to do rather than that something broke. The server owns the set and partitions it by WHO must
 * act and by whether anything CAN act: nothing to stop (`unknown-session`), this server holds no
 * handle (`no-surface`), it will not kill it and the operator CAN change that (`taken-over` and
 * `liveness-indeterminate` — force overrides), it will not and NOTHING changes that
 * (`ambiguous-surface`, `liveness-unknown`), the request is malformed (`malformed-request`), or the
 * teardown could not be completed (`stop-failed`). As in `launch.js`, this module mirrors NO copy of
 * that set: it READS a code rather than validating one ({@link stopFailureCode}), so a local copy would
 * gate nothing while still going stale. The only codes it names are {@link TAKEN_OVER_CODE} and
 * {@link LIVENESS_INDETERMINATE_CODE} — not to validate the set, but because those are exactly the
 * refusals this UI can act on ({@link isForceable}). What pins this module against the REAL server —
 * rather than against a second hand-copy of itself — is the stop-flow spec in `@ccctl/e2e`, which
 * drives it against a live ingress.
 */

/** Same-origin root of the session namespace — IMPORTED from `command.js`, which owns it. */
import { SESSIONS_PATH } from "./command.js";

/**
 * Same-origin path the browser POSTs a stop to, per session (#20), so a stop addresses exactly one
 * session and can never land on another — the invariant that matters most on the one verb that
 * destroys what it addresses. Session ids are server-minted UUIDs (no embedded `/`), so the id goes
 * on the path verbatim, matching the server's exact segment split and `command.js`'s sibling paths.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionStopPath(sessionId) {
  return `${SESSIONS_PATH}/${sessionId}/stop`;
}

/**
 * The refusal an operator can do something about from this UI (`ui-session-stop.ts`): the session has
 * been taken over — someone is driving it at a terminal — and the server will not kill a session a
 * human may be working in. It refuses because it CANNOT KNOW whether that human is there; the operator
 * hitting stop IS that human, saying they want it stopped. See {@link isForceable}.
 */
export const TAKEN_OVER_CODE = "taken-over";

/**
 * The other refusal force resolves (#197): the session's backend REACHED its host and the host would
 * not say what the surface is. The server will not kill what it cannot see unless asked — but the
 * channel to the surface demonstrably works, so a forced kill really travels and the server really
 * verifies that it landed. It refuses for want of the operator's say-so, which is the same thing
 * {@link TAKEN_OVER_CODE} is missing, and the same thing this button supplies.
 *
 * Not to be confused with its sibling `liveness-unknown`, which is NOT forceable and never becomes so:
 * there the host could not be reached at all, so a kill would travel the same dead path and be reported
 * on by nobody. Two codes, because they are two situations — one the operator can end from here, one
 * they cannot. See {@link isForceable}.
 */
export const LIVENESS_INDETERMINATE_CODE = "liveness-indeterminate";

/**
 * What {@link stopFailureCode} reads when the answer carries no usable code at all. Not a
 * `StopFailureCode` — it is the ABSENCE of one, and it is REACHABLE against a correct server: the
 * ingress's `405` branch answers `{ error }` with no `code` (no stop was attempted, so there is no
 * stop failure to type), and a tunnel or proxy can interpose a body of its own. Mirrors
 * `launch.js`'s {@link UNKNOWN_LAUNCH_FAILURE_CODE}.
 */
export const UNKNOWN_STOP_FAILURE_CODE = "unknown";

/** Trim a value to a string, or the empty string when it is not one (mirrors `command.js` / `launch.js`). */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the stop body. Bare (`{}`) by default; `{ force: true }` ONLY when force is literally `true`.
 *
 * Force is OMITTED rather than sent as `false`, which is the same "a blank optional is absent, not
 * empty" reflex `launch.js`'s {@link launchRequest} applies — and it is load-bearing here rather
 * than tidy. The server's parse is fail-closed and refuses anything that is not exactly a boolean
 * (`"true"`, `1`, `"yes"` are all truthy in JavaScript and none of them is an operator saying yes),
 * so a body that never mentions force cannot be misread as forcing. The failure direction is the
 * non-destructive one by construction: the default body is the one that CANNOT kill a session
 * someone is working in.
 *
 * Only a literal `true` forces, mirroring the server's own rule rather than restating it loosely —
 * a caller who passes a truthy non-boolean gets the NON-forcing body, so a UI bug can only ever
 * under-force. The parameter is optional so the common call is `stopRequest()`: the plain stop.
 *
 * @param {{ force?: unknown }} [options] - the escalation's intent; absent is the plain stop.
 * @returns {{ force?: true }}
 */
export function stopRequest(options) {
  return options?.force === true ? { force: true } : {};
}

/**
 * The typed code a failure answer carries — the server's `code` VERBATIM whenever it is a non-blank
 * string, and {@link UNKNOWN_STOP_FAILURE_CODE} when there is no usable code at all.
 *
 * Passing an unrecognized code through rather than checking it against a local copy of the set is
 * the same choice `launch.js`'s {@link launchFailureCode} and `sessions.js`'s {@link activityLabel}
 * make: if the server grows a code this build predates, the operator should see the server's word
 * for what happened — drift that is VISIBLE is a bug report, drift that is hidden is a mystery. The
 * UI is a READER of this set, not an enforcer of it; the server is the side that must fail closed on
 * a code it does not know. That is exactly why no mirrored copy of the set lives here: it could only
 * go stale, never gate.
 *
 * Defensive over any decoded value (a non-object, a null, an array, a non-string code): never
 * throws, and degrades to {@link UNKNOWN_STOP_FAILURE_CODE}.
 *
 * @param {unknown} payload - a decoded `StopFailureWire`, or any value.
 * @returns {string}
 */
export function stopFailureCode(payload) {
  const code = trimmed(payload?.code);
  return code === "" ? UNKNOWN_STOP_FAILURE_CODE : code;
}

/**
 * Whether the stop control must STAY disabled now that a stop attempt has settled, rather than
 * being re-rendered from the current selection.
 *
 * TRUE for exactly one case: the stop SUCCEEDED and the selection still names the session it
 * killed. That row is already gone — `session-close.ts` drops it, because a retained row would
 * hold its `maxSessions` slot forever — so the control is offering to stop something that no
 * longer exists, and the server would answer `unknown-session`.
 *
 * This is a race, not a formality. The picker's refresh is deliberately not awaited by the caller
 * (it re-arms its own timer), so this predicate is consulted while that GET is still in flight and
 * the selection STILL NAMES THE SESSION WE JUST KILLED. Re-enabling here would re-open the very
 * window the caller's in-flight guard exists to close, one step later: a second tap fires a second
 * stop at the dead row, the server refuses it, and since a cleared selection never rewrites a
 * success line, that red refusal becomes the permanent final word on a stop that fully worked —
 * "shown a failure for a stop that succeeded", which is the outcome that guard names.
 *
 * Every other ending re-renders from the selection instead, and each is deliberate:
 *
 *   - a refusal (`stopped === false`) touches no state — the session is still there and a retry is
 *     safe, which is what makes refusals retryable at all;
 *   - an unreachable server is the same, since a kill nobody answered for cannot be claimed;
 *   - a DIFFERENT session selected mid-flight is live, and stoppable.
 *
 * Keyed on the `sessionId` the attempt was FOR, never on the live selection alone: those are the
 * same value only until the operator moves, and conflating them is how a control gets disabled
 * against a session that is perfectly alive.
 *
 * @param {object} settled
 * @param {boolean} settled.stopped - whether the attempt ended in an accepted stop.
 * @param {string|null} settled.currentSessionId - the selection as it stands now.
 * @param {string} settled.sessionId - the session the attempt was aimed at.
 * @returns {boolean}
 */
export function keepStopControlDisabled({ stopped, currentSessionId, sessionId }) {
  return stopped === true && currentSessionId === sessionId;
}

/**
 * Whether a refusal is one the operator can override from here — i.e. whether to offer the "Stop
 * anyway" escalation ({@link stopRequest} with force).
 *
 * TRUE for exactly {@link TAKEN_OVER_CODE} and {@link LIVENESS_INDETERMINATE_CODE} and nothing else,
 * which is the server's rule read faithfully rather than a caution of this UI's own. Both are refusals
 * the server makes for want of the operator's explicit say-so, and force is that say-so; every other
 * refusal is one force does not reach, and offering it there would be offering a button that cannot
 * work. On the two that most invite it that is actively harmful:
 *
 *   - `ambiguous-surface` — the terminal may be running a DIFFERENT session's live worker. Force is
 *     the operator consenting to destroy the session they NAMED; nobody can give that consent on
 *     another session's behalf (#20), so not even force overrides it.
 *   - `liveness-unknown` — the backend could not REACH the host that would read the surface. Forcing
 *     there sends the kill down the very channel that just failed, and reports "stopped" on the word
 *     of nobody, which is the one answer an emergency-stop must never give.
 *
 * That second one is why this is a two-code list rather than a `startsWith("liveness-")` test (#197):
 * the two liveness refusals READ alike and behave as opposites — one is the operator's to end, one is
 * beyond them and beyond force. The server draws that line in `session-release.ts` and spends two wire
 * codes stating it; matching on the shared prefix would erase it here and hand back the button the
 * server will refuse.
 *
 * Both are refusals force must not overrule rather than strictness worth relaxing, and the server
 * enforces that regardless — this only keeps the UI from PROMISING an override the server will
 * refuse. A code this build does not recognize is not forceable either: the honest default for an
 * unknown refusal is not to offer a destructive escalation against it. That default is what kept this
 * UI correct-if-conservative against a server that grew `liveness-indeterminate` before it did — it
 * hid a real escalation, which is the safe way to be wrong.
 *
 * @param {unknown} code - a code from {@link stopFailureCode}, or any value.
 * @returns {boolean}
 */
export function isForceable(code) {
  return code === TAKEN_OVER_CODE || code === LIVENESS_INDETERMINATE_CODE;
}

/**
 * Read a failed stop into the three things the operator is shown: the TYPED `code` (which refusal it
 * is), the human `message` (what to do about it), and whether this UI can offer to override it
 * (`forceable`).
 *
 * The message is the server's own `error` sentence, used verbatim and never re-derived here — the
 * same choice, for the same reason, as `launch.js`'s {@link launchFailure}: every ccctl fail-closed
 * branch already writes an actionable sentence, and it writes a BETTER one than this module could —
 * it echoes the session's own attach hint (`taken-over`), explains why an ambiguous terminal cannot
 * be killed even with force, says what it means when a backend cannot be read. A per-code sentence
 * table here would be a second, worse copy of prose the server already owns, and it would drift.
 *
 * `forceable` is the one thing this module adds rather than carries, and it earns that: the server's
 * `taken-over` sentence names its remedy in WIRE words — "re-send this stop with `{ force: true }`"
 * — which is exactly right for the CLI and curl, and meaningless to someone holding a phone. The
 * escalation control IS that sentence's translation for this surface. Deriving it from the typed
 * code rather than from the prose is the whole point of the code existing (`ui-session-stop.ts`
 * calls it "the pinned, machine-readable discriminant #77's stop button and `ccctl stop` switch on").
 *
 * Every half is defensive, because not every failure answer comes from ccctl's typed ingress: the
 * `405` branch answers `{ error }` with no code, a tunnel or proxy can interpose an HTML error page
 * (so `payload` is `null` — the caller could not parse JSON), and a hostile body is arbitrary bytes.
 * A missing / blank / non-string `error` falls back to a sentence naming the status, so the operator
 * is never shown an empty line or the word "undefined".
 *
 * @param {number} status - the answer's HTTP status (the browser's `Response.status`).
 * @param {unknown} payload - the decoded `StopFailureWire`, or `null` when the body was not JSON.
 * @returns {{ code: string, message: string, forceable: boolean }}
 */
export function stopFailure(status, payload) {
  const error = trimmed(payload?.error);
  const code = stopFailureCode(payload);
  return {
    code,
    message: error === "" ? `ccctl: stop failed (HTTP ${status})` : error,
    forceable: isForceable(code),
  };
}

/**
 * The one-line confirmation an accepted stop reads as: WHICH session is over, HOW it ended, and the
 * terminal state it reached.
 *
 * All three come from the server's `200` body. The two outcomes are kept as DIFFERENT SENTENCES
 * because they are different facts, even though both satisfy the operator's request: `stopped` means
 * this server killed the surface; `already-exited` means the surface had already gone (the worker
 * exited, the operator closed the window) and there was nothing left to kill. Both are successes —
 * the operator asked for the session to be over and it is over — but "I killed it" and "it was
 * already dead" are not the same sentence, and the second one is worth knowing. Collapsing them
 * would be this UI claiming a kill the server explicitly declined to claim.
 *
 * `status` is the terminal {@link SessionStatus} the server's transition RETURNED — `closed` for a
 * session that was running, `errored` for one that had already failed (a stop does not overwrite the
 * diagnosis of a session that had already reached a terminal state of its own). Carried, never
 * re-derived: the server does not assert it either, so neither may this.
 *
 * Defensive over any decoded value, matching this module's never-throws posture: a missing id reads
 * as `"(unknown session)"` (a stop the server accepted but would not name is still a stop the
 * operator must be told about), an unrecognized outcome degrades to a neutral sentence rather than
 * guessing which of the two it was, and a missing status drops that half of the line rather than
 * printing a dangling separator.
 *
 * @param {unknown} payload - a decoded `StopAcceptedWire`, or any value.
 * @returns {string}
 */
export function describeStopAccepted(payload) {
  const sessionId = trimmed(payload?.sessionId);
  const outcome = trimmed(payload?.outcome);
  const status = trimmed(payload?.status);
  const name = sessionId === "" ? "(unknown session)" : sessionId;
  let head;
  if (outcome === "stopped") {
    head = `stopped ${name}`;
  } else if (outcome === "already-exited") {
    head = `${name} had already exited`;
  } else {
    // An outcome this build does not recognize: report the session is over without inventing which
    // of the two ways it ended — the same read-don't-enforce posture as `stopFailureCode`.
    head = `${name} is stopped`;
  }
  return status === "" ? head : `${head} — ${status}`;
}
