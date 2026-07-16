// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The EMERGENCY-STOP ingress — the browser's (and the CLI's) `POST /api/sessions/{id}/stop`, the
 * safety valve for a free-running session that must be halted right now (#76; `SRV-B-016`).
 *
 * The mirror image of the launch ingress (`ui-session-launch.ts`), and deliberately built to its
 * shape: a shared core ({@link stopSession}) both entry points call, so the HTTP and programmatic
 * paths cannot drift apart about which stops are legal; every refusal a typed
 * {@link StopFailureCode} mapped to one status; a browser-facing camelCase wire. That module is where
 * a session BEGINS and this is where one ENDS, so the symmetry is the point rather than a stylistic
 * echo — the same server, the same operator, the same two clients (#77's stop button and
 * `ccctl stop <session>`, which is why the core is shared rather than inlined into the handler).
 *
 * **Why this is not a `/command` subtype, which is the obvious place to put it.** `POST
 * /api/sessions/{id}/command` already carries an `interrupt` verb, and a stop looks like its big
 * brother. It cannot live there, and the reason is structural rather than aesthetic: every command
 * subtype is pushed WORKER-WARD down that session's held-open §4 downstream, so `ui-command.ts` fails
 * closed `409` when there is no live worker channel, and the whole §4 surface is shut to a session
 * that has not registered (#33). Those are exactly the sessions an emergency-stop is FOR — the worker
 * that stopped answering, the launch that hung before it ever checked in. A command-subtype stop would
 * be unable to fire in its own use case. The two verbs are opposites: `interrupt` ASKS the worker to
 * stop and needs it listening; a stop KILLS THE SURFACE THE WORKER RUNS ON and needs only the handle
 * this server has held since it launched it.
 *
 * **Why `POST …/stop` rather than `DELETE /api/sessions/{id}`.** `force` has to ride the request, and
 * a DELETE body has no defined semantics (RFC 9110 §9.3.5). The alternative spelling, `?force=true`,
 * would be this server's first query-param read — every route today is matched on `.pathname` alone —
 * and, worse, query params invite truthy coercion: `?force=maybe` reading as `true` fails open IN THE
 * DESTRUCTIVE DIRECTION, which is the one direction nothing here may fail. A JSON body parsed by a
 * fail-closed {@link parseStopOptions} is the shape both other control-plane ingresses already use.
 * `stop` is also just a leg of the namespace `matchUiSessionRoute` already shapes (`…/{id}/{leg}`),
 * so it costs that matcher nothing, while a bare-id DELETE would mean teaching it to match a path it
 * currently, deliberately, does not.
 *
 * **What a stop must never do is succeed quietly.** An operator hits stop because a session must be
 * halted NOW; the whole value of the verb is that they can believe its answer and stop watching. So
 * every branch that did not kill says so, with a status and a typed code — a refusal is an error here,
 * not a 200 with a disappointing body (`ccctl stop X && echo done` must not print `done`) — and the
 * one branch that killed reports the terminal state it produced.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session } from "@ccctl/core";
import { readJsonBody, writeJson } from "./http-response.js";
import { consumePendingLaunch, type PendingLaunchConsumeState } from "./pending-launch.js";
import { closeSession, type SessionCloseState } from "./session-close.js";
import type { LaunchedSession, SurfaceLiveness } from "./session-launcher.js";
import { stopLaunchedSession } from "./session-release.js";
import { reapWorkerChannel, type WorkerChannelReapState } from "./worker-channel.js";

/**
 * Hard ceiling on a stop body (4 KiB). A stop carries one boolean, so this is enormous already —
 * unlike a launch (1 MiB, which must fit a pasted seed prompt) there is nothing here that could ever
 * legitimately be large. Sized to the payload rather than copied from a neighbour: the cap's job is to
 * bound a malformed or hostile `Content-Length` on the one ingress whose verb is destructive, and a
 * megabyte of slack on a 20-byte body is slack with no purpose.
 */
const MAX_STOP_BODY_BYTES = 4 * 1024;

/**
 * WHY a stop did not stop a session (#76) — the pinned, machine-readable discriminant #77's stop
 * button and `ccctl stop` switch on, so a refusal is a typed answer rather than prose to pattern-match.
 * Mirrors {@link LaunchFailureCode}, and partitions the same way: by WHO MUST ACT, and by whether
 * anything CAN act.
 *
 *   - the request names nothing this server can stop — `unknown-session` (no such session);
 *   - this server HOLDS NO HANDLE to the session's terminal — `no-surface`. It did not launch it, so
 *     it cannot kill it. Permanent, and the operator acts at the terminal itself;
 *   - this server WILL NOT kill it, and the operator can change that — `taken-over` (they are driving
 *     it at their desk; `force` overrides, which is precisely what AC3 scopes force to);
 *   - this server WILL NOT kill it, and NOTHING changes that — `ambiguous-surface` (the terminal may
 *     be running a DIFFERENT session's live worker) and `liveness-unknown` (the backend could not read
 *     it). Force does not reach either; see {@link stopSession} and `session-release.ts` for why each
 *     is a refusal force must not overrule rather than a strictness worth relaxing;
 *   - the operator's request is malformed — `malformed-request`;
 *   - anything else — `stop-failed`, the honest catch-all for a teardown that could not be completed
 *     for a reason this server cannot classify. The exact sibling of `spawn-failed` at the other end
 *     of a session's life, and it exists for the same reason: a code this server cannot name must not
 *     reach the wire as one it can, and a stop that failed must never be reported as one that worked.
 */
export type StopFailureCode =
  | "unknown-session"
  | "no-surface"
  | "ambiguous-surface"
  | "taken-over"
  | "liveness-unknown"
  | "malformed-request"
  | "stop-failed";

/** The pinned {@link StopFailureCode} set, in one place, for the guard, the status map, and the tests. */
export const STOP_FAILURE_CODES: readonly StopFailureCode[] = [
  "unknown-session",
  "no-surface",
  "ambiguous-surface",
  "taken-over",
  "liveness-unknown",
  "malformed-request",
  "stop-failed",
];

/** Runtime guard for {@link StopFailureCode} — fails closed on anything outside the pinned set. */
export function isStopFailureCode(value: unknown): value is StopFailureCode {
  return typeof value === "string" && (STOP_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The typed reject of {@link stopSession} — an `Error` naming its {@link StopFailureCode}. The
 * `message` stays the human-facing, actionable sentence; the `code` is what a program branches on.
 * The exact shape of {@link SessionLaunchError} at the other end of a session's life.
 */
export class SessionStopError extends Error {
  /** The machine-readable reason this stop did not stop the session. */
  readonly code: StopFailureCode;

  constructor(code: StopFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStopError";
    this.code = code;
  }
}

/**
 * Whether `value` is a {@link SessionStopError} — structural rather than `instanceof` (so an error
 * that crossed a module boundary is still read as typed), but failing CLOSED on the code itself, so an
 * errno-bearing throw (which also carries a string `code`) can never smuggle a foreign code onto the
 * wire. Mirrors {@link isSessionLaunchError}.
 */
export function isSessionStopError(value: unknown): value is SessionStopError {
  return value instanceof Error && isStopFailureCode((value as { code?: unknown }).code);
}

/**
 * The ONE mapping from a {@link StopFailureCode} to the HTTP status that carries it — a single
 * exhaustive record, so a new code cannot be added without `tsc` demanding its status here. The same
 * shape, and the same reasoning, as {@link LAUNCH_FAILURE_STATUS}.
 *
 * `409` carries every refusal, and that is a deliberate reading rather than a shrug. Each one is a
 * well-formed request against a real session whose CURRENT STATE is what declines it — the operator
 * has it, the terminal may hold someone else's worker, the backend cannot see it, this server never
 * launched it. That is a conflict with the resource's state, which is exactly what 409 means, and each
 * can resolve without the request changing at all (detach, and the same stop succeeds). It is
 * emphatically not a `403`: nothing here is about permission — the operator is allowed, the server
 * simply cannot prove the kill is safe. Nor `501` for `no-surface`: this server implements stop
 * perfectly well, it just holds no handle to THIS session's terminal.
 *
 * `502` for `stop-failed` matches the launch side's `spawn-failed`: the request was good, and the host
 * could not complete what we asked of it.
 */
const STOP_FAILURE_STATUS: Record<StopFailureCode, number> = {
  "unknown-session": 404,
  "no-surface": 409,
  "ambiguous-surface": 409,
  "taken-over": 409,
  "liveness-unknown": 409,
  "malformed-request": 400,
  "stop-failed": 502,
};

/** The "no such session" reason — mirrors the wording every other session-addressed ingress answers. */
function unknownSessionReason(sessionId: string): string {
  return `ccctl: no session ${sessionId}`;
}

/**
 * The "this server holds no handle to that terminal" reason. Names the ONE thing the operator can do
 * about it, because the bare fact is not actionable — and deliberately does not guess WHY we hold no
 * handle (this server genuinely cannot tell a session it never launched from one whose launch it can
 * no longer attribute), since a guessed cause would be a fabricated claim the operator might act on.
 */
function noSurfaceReason(sessionId: string): string {
  return (
    `ccctl: session ${sessionId} was not launched by this server, so it holds no handle to that session's ` +
    "terminal and cannot stop it. End it at the terminal it is running in, or steer it with an `interrupt`."
  );
}

/**
 * The "the operator has this one" refusal (AC3). Carries the surface's own attach hint, which turns a
 * refusal into an instruction: the operator is told WHERE the session they asked to stop actually is,
 * and both of the moves available to them. Echoing the hint back is the same reflex as
 * {@link invalidCwdReason} echoing the offending path — the fact alone leaves the operator stuck.
 */
function takenOverReason(sessionId: string, hint: string): string {
  return (
    `ccctl: session ${sessionId} has been taken over — it is being driven at a terminal, and this server ` +
    `will not kill a session someone is working in. Reach it with \`${hint}\`, or re-send this stop with ` +
    "`{ force: true }` if you are sure."
  );
}

/**
 * The "the backend could not read this surface" refusal. Distinct from {@link takenOverReason} because
 * they are DIFFERENT NEWS and only one of them is the operator's doing — and force is deliberately not
 * offered here, since forcing on a reading nobody could take is how a stop reports a kill that did not
 * happen (`session-release.ts` § `FORCED_STOP_BY_LIVENESS`).
 */
function livenessUnknownReason(sessionId: string): string {
  return (
    `ccctl: session ${sessionId}'s terminal could not be read — its backend did not answer, so this server ` +
    "cannot tell whether the surface is still there or who has it, and will not kill what it cannot see. " +
    "If the backend itself is gone, the terminal went with it."
  );
}

/**
 * The "this terminal may be running someone else's worker" refusal — #33's ambiguity rule, reaching
 * emergency-stop. Spells out the whole situation, because it is genuinely surprising to be told that a
 * session you named cannot be stopped, and the reason is not about the session you named at all.
 */
function ambiguousSurfaceReason(sessionId: string): string {
  return (
    `ccctl: session ${sessionId} was launched alongside another in the same directory under the same ` +
    "permission mode, and a worker has since registered from one of them — so this server cannot tell which " +
    "of those terminals is which, and killing this one may kill the other session's live worker. Not even " +
    "`force` overrides this: it authorizes stopping the session you named, not one you did not. End this " +
    "terminal by hand."
  );
}

/** The "malformed stop body" reason — names the shape a stop must take, so the caller can fix it. */
const MALFORMED_STOP_BODY = "ccctl: malformed stop body (expected JSON `{}` or `{ force: boolean }`)";

/**
 * What one stop DID to a session — the two ways a stop can leave a session GONE, kept distinct on the
 * wire because they are different facts even though both satisfy the operator's request.
 *
 *   - `stopped` — this server killed the surface. The child is signalled and reaped.
 *   - `already-exited` — the surface had already gone (the worker exited, the operator closed the
 *     window) and there was nothing left to kill. Reported as a SUCCESS, not an error: the operator
 *     asked for the session to be stopped and the session is stopped, which is the whole of what they
 *     wanted. Distinguishing it is what keeps the answer honest — "I killed it" and "it was already
 *     dead" are not the same sentence, and the second one is worth knowing.
 */
export type StopOutcomeWire = "stopped" | "already-exited";

/**
 * The `POST /api/sessions/{id}/stop` success body — WHICH session was stopped, HOW it ended, and the
 * terminal {@link SessionStatus} it reached. A browser-facing projection (camelCase), matching
 * {@link LaunchAcceptedWire} at the other end of a session's life.
 *
 * `status` is the AC's "transitions to a terminal state, reflected to clients", carried literally: the
 * status is not asserted by this module, it is what the terminal transition RETURNED
 * (`session-close.ts`), so the wire cannot claim a transition the server did not make. It is `closed`
 * for a session that was running and `errored` for one that had already failed — a stop does not
 * overwrite the diagnosis of a session that had already reached a terminal state of its own.
 */
export interface StopAcceptedWire {
  /** The session that was stopped — the id the request named. */
  readonly sessionId: string;
  /** HOW it ended: this server killed the surface, or the surface was already gone. */
  readonly outcome: StopOutcomeWire;
  /** The terminal status the session reached — what the transition actually produced. */
  readonly status: Session["status"];
}

/**
 * The `POST /api/sessions/{id}/stop` FAILURE body — the human-facing `error` sentence every ccctl
 * fail-closed branch answers, plus the machine-readable {@link StopFailureCode}. The exact shape of
 * {@link LaunchFailureWire}, so a client that only reads `.error` works on both.
 */
export interface StopFailureWire {
  /** The human-facing, actionable reason. */
  readonly error: string;
  /** The machine-readable discriminant a UI switches on. */
  readonly code: StopFailureCode;
}

/** Answer a stop failure: its mapped status, its human `error`, and its machine-readable `code`. */
function writeStopFailure(res: ServerResponse, error: SessionStopError): void {
  const body: StopFailureWire = { error: error.message, code: error.code };
  writeJson(res, STOP_FAILURE_STATUS[error.code], body);
}

/**
 * Normalize ANY throw from the stop path into a typed {@link SessionStopError}: a refusal this module
 * classified passes through verbatim; anything else — a backend's `close()` that rejected, most of all
 * — becomes an honest `stop-failed` carrying the original as `cause`, so nothing is swallowed.
 * Mirrors {@link toLaunchFailure}, and matters more here: the alternative to typing an unclassifiable
 * teardown failure is REPORTING IT AS A SUCCESS, which is the one answer this ingress must never give.
 */
function toStopFailure(error: unknown): SessionStopError {
  if (isSessionStopError(error)) {
    return error;
  }
  return new SessionStopError("stop-failed", "ccctl: the session's terminal could not be torn down", {
    cause: error,
  });
}

/** What a stop request may ask for beyond the session it names in the URL. */
export interface SessionStopOptions {
  /**
   * Whether the operator EXPLICITLY authorized killing a session they have taken over (AC3). Defaults
   * to `false` everywhere it is absent — the default must be the non-destructive one.
   */
  readonly force: boolean;
}

/**
 * Parse a stop body into {@link SessionStopOptions}, or `null` when it is not a JSON object with an
 * optional BOOLEAN `force`.
 *
 * `force` must be literally `true`. No coercion, ever: `"true"`, `1`, `"yes"` and `"force"` are all
 * truthy in JavaScript and none of them is an operator saying yes — they are a client with a bug, a
 * form serializer, or a hand-written curl. Everywhere else in this codebase a fail-closed parse
 * protects the server from a malformed request; here it protects a session the operator is working in
 * from being killed by a string. The one rule that makes it safe is that the failure direction is
 * NON-destructive: anything that is not exactly `true` is not force, so the worst a wrong `force` can
 * do is refuse a stop, which the operator sees and can redo.
 *
 * A non-boolean `force` is REFUSED rather than read as `false` — a caller who wrote `force: "true"`
 * believes they forced it, and quietly answering the refusal they did not ask about would teach them
 * their spelling works. Absent is a different thing entirely, and is fine: it is a caller who did not
 * ask to force.
 */
export function parseStopOptions(value: unknown): SessionStopOptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { force } = value as Record<string, unknown>;
  if (force === undefined) {
    return { force: false };
  }
  if (typeof force !== "boolean") {
    return null;
  }
  return { force };
}

/**
 * The per-server state a stop reads: the session registry (which says whether the named session EXISTS
 * — the gate every stop passes first), the launched surfaces keyed by session id (which says whether
 * this server can reach that session's terminal at all), the pending launches (which say whether
 * reaching it is SAFE — #33's ambiguity rule — and which a completed stop CONSUMES), and — via
 * {@link SessionCloseState} and {@link WorkerChannelReapState} — what ending the session touches. A
 * structural slice, like every other state seam in this package.
 *
 * It is a WIDE slice, and that width is the honest measure of what a stop is: the one operation that
 * retires a live session outright, so it must answer for everything a session accumulated across every
 * module that gave it something. A narrower slice would not be a simpler stop, only a leakier one —
 * each field here is a collection something else populated and nothing else will ever come back for
 * (see the retirement block in {@link stopSession}).
 */
export interface SessionStopState extends SessionCloseState, WorkerChannelReapState, PendingLaunchConsumeState {
  /** Terminals this server owns, keyed by the session id they were launched for (#76's addressing). */
  readonly launchedSurfaces: Map<string, LaunchedSession>;
}

/**
 * The ONE mapping from the reading a refused stop was decided from to the code that reports it. Kept
 * as an exhaustive `Record<SurfaceLiveness, StopFailureCode>` for the same reason the rule it mirrors
 * is one: a new reading cannot be added without `tsc` demanding the code a refusal on it would answer.
 *
 * Only the two readings that CAN refuse have a truthful entry. `alive-server-owned` and `exited` never
 * reach this map — every table in `session-release.ts`, forced or not, dispositions them to
 * `tear-down` / `no-op` — so their entries exist to satisfy exhaustiveness and are filed as
 * `stop-failed`: if one ever DID arrive here, the honest report is that something the server cannot
 * explain happened, not a refusal it can name. That is the same instinct as the `unknown` cell in the
 * release rule — a value this server does not expect must not be dressed up as one it does.
 */
const REFUSAL_BY_LIVENESS: Record<SurfaceLiveness, StopFailureCode> = {
  "alive-server-owned": "stop-failed",
  "taken-over": "taken-over",
  exited: "stop-failed",
  unknown: "liveness-unknown",
};

/**
 * Build the typed refusal for a stop the rule declined, from the reading it declined on. The reading
 * is the one the DECISION was made on ({@link StopOutcome}), never a fresh probe — re-reading to
 * build the message would report a second observation the decision was not made on, which is how an
 * answer and its reason come apart.
 */
function refusal(sessionId: string, liveness: SurfaceLiveness, hint: string): SessionStopError {
  const code = REFUSAL_BY_LIVENESS[liveness];
  if (code === "taken-over") {
    return new SessionStopError(code, takenOverReason(sessionId, hint));
  }
  if (code === "liveness-unknown") {
    return new SessionStopError(code, livenessUnknownReason(sessionId));
  }
  return new SessionStopError(code, `ccctl: session ${sessionId} could not be stopped`);
}

/**
 * STOP one session: kill its terminal (honoring the safety envelope) and drive it to its terminal
 * state — the shared core behind BOTH the HTTP ingress and the programmatic
 * {@link CcctlServer.stopSession}, so neither entry point can stop a session the other would refuse.
 * The same single-seam discipline {@link launchSession} applies at the other end of a session's life,
 * and for a sharper reason: #77 adds a `ccctl stop` CLI verb, so a rule enforced at the HTTP handler
 * is a rule the CLI walks around.
 *
 * The guards run in order of what they are asking, cheapest and most decisive first:
 *
 *   1. **Does this session exist?** No → `unknown-session`. This gate is also what makes the surface
 *      map safe to consult at all: an ambiguous launch's entry outlives its dropped row, and it is
 *      this lookup — not a rule about ambiguity — that keeps a stop from ever reaching it.
 *   2. **Can this server reach its terminal?** No handle → `no-surface`. A session registered over §2
 *      that this server never launched (a UC1 attach) is real, listed and steerable, and its process
 *      is not ours to kill. Answering anything but a refusal here would be a lie in the operator's
 *      hands — and specifically the lie that ends their attention on a session that is still running.
 *   3. **Is killing it SAFE?** — #33's `mayHoldLiveWorker` → `ambiguous-surface`. Force does not
 *      reach this one (below).
 *   4. **May we kill it?** — the rule (`session-release.ts` § {@link stopLaunchedSession}), which
 *      probes the surface and decides by an exhaustive table honoring `force`.
 *
 * **Why `force` does not override `mayHoldLiveWorker`, and this is not the timid choice.** That mark
 * does not mean "the operator has it" — it means TWO launches shared a (cwd, mode), a worker
 * registered from one of them, and nothing on the wire says which terminal it is in (#33 §
 * Correlation). So the surface behind THIS session's id may be running a DIFFERENT session's live
 * worker, and killing it is the coin flip #33 explicitly refused to take. Force is the operator
 * consenting to destroy THE SESSION THEY NAMED; it is not consent to destroy one they did not, and
 * they cannot give that consent on the other session's behalf — that is #20's never-cross-wired
 * invariant, which no flag on this request may spend. The residual cost is a terminal window the
 * operator closes by hand; the alternative is killing a live session that no one asked about. As
 * everywhere else in this envelope, those costs are not comparable, so this does not balance them.
 *
 * Rejects with a typed {@link SessionStopError} on every path that did not stop the session. Resolves
 * with the CLOSED session — what the terminal transition produced — on the two paths that leave it
 * gone (we killed it; it was already gone), which is what the caller reflects to the operator.
 */
export async function stopSession(
  state: SessionStopState,
  sessionId: string,
  options: SessionStopOptions,
): Promise<{ readonly outcome: StopOutcomeWire; readonly session: Session }> {
  if (!state.sessions.has(sessionId)) {
    throw new SessionStopError("unknown-session", unknownSessionReason(sessionId));
  }
  const launched = state.launchedSurfaces.get(sessionId);
  if (launched === undefined) {
    throw new SessionStopError("no-surface", noSurfaceReason(sessionId));
  }
  if (state.pendingLaunches.get(sessionId)?.mayHoldLiveWorker === true) {
    throw new SessionStopError("ambiguous-surface", ambiguousSurfaceReason(sessionId));
  }
  // The rule. A `close()` that rejects propagates — the caller types it `stop-failed` rather than
  // letting a failed teardown be reported as a stop that worked.
  const { disposition, liveness } = await stopLaunchedSession(launched, options.force);
  if (disposition === "leave-running") {
    // Refused, and the surface is untouched. The session stays exactly as it was: still listed, still
    // steerable, still the operator's — a refusal changes nothing, which is what makes it safe to retry.
    throw refusal(sessionId, liveness, launched.attachment.hint);
  }
  // The surface is GONE — we tore it down, or it had already exited. Both leave the session over, so
  // both end it the same way, and everything the session owned is retired HERE, past the last refusal:
  // a stop that refused must leave the world exactly as it found it (that is what makes a refusal safe
  // to retry, and what keeps a refused ghost's eviction timer armed).
  //
  //   - the HANDLE, first: it names a surface that no longer exists, and leaving it would have shutdown
  //     re-close a dead terminal (and, for a reused id, someone else's);
  //   - the PENDING LAUNCH (#33), for the reason `consumePendingLaunch` gives: a surviving record keeps
  //     the `(cwd, mode)` that IS the §2 correlation key, so it poisons the operator's next launch in
  //     that same directory. A stop is the third path to consume one, and the one where forgetting
  //     bites hardest — stop-the-runaway-then-relaunch-it is not an exotic path, it is THE
  //     emergency-stop workflow, so the poisoned launch is the operator's very next action;
  //   - the WORKER CHANNEL (#173), for the reason `reapWorkerChannel` gives: the eviction check that
  //     would otherwise reap it bails on a session whose row is gone, and the next line drops that row.
  //     Nothing else will ever come back for it.
  state.launchedSurfaces.delete(sessionId);
  consumePendingLaunch(state, sessionId);
  reapWorkerChannel(state, sessionId);
  const closed = closeSession(state, sessionId);
  if (closed === undefined) {
    // The session was there at the gate and is not here now — an eviction reaped it while we were
    // probing (a stop and the #173 grace timer can genuinely race). Nothing is wrong: the operator
    // asked for it to be over and it is over, by another hand. Report what is true.
    throw new SessionStopError("unknown-session", unknownSessionReason(sessionId));
  }
  return { outcome: disposition === "tear-down" ? "stopped" : "already-exited", session: closed };
}

/**
 * Handle `POST /api/sessions/{id}/stop` — stop the ONE session named in the URL (never inferred, #20)
 * and answer `200` with its {@link StopAcceptedWire}: which session, how it ended, and the terminal
 * state it reached.
 *
 * Every failure answers a status AND a typed {@link StopFailureWire} `code`: a non-POST method (405 —
 * the one branch with no stop code, since no stop was attempted), a body that could not be read or
 * parsed (400 `malformed-request`), or any typed refusal / teardown failure from {@link stopSession}
 * (mapped through {@link STOP_FAILURE_STATUS}).
 *
 * The refusals are NOT pre-checked here — the shared core owns them and this handler projects whatever
 * it throws. That is the point: a pre-check duplicated here is a second copy of the rule, and #77's
 * `ccctl stop` would only obey the copy that lives in the core.
 */
export function handleSessionStop(
  req: IncomingMessage,
  res: ServerResponse,
  state: SessionStopState,
  sessionId: string,
): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    writeJson(res, 405, { error: `ccctl: ${req.method ?? "?"} not allowed on the session stop path` });
    return;
  }
  void readJsonBody(req, MAX_STOP_BODY_BYTES).then(async (result) => {
    if (!result.ok) {
      // An unreadable body (over the cap, or not JSON) — `readJsonBody` already chose the status
      // (413 / 400); carry its reason, and type it as the malformed request it is.
      const body: StopFailureWire = { error: result.message, code: "malformed-request" };
      writeJson(res, result.status, body);
      return;
    }
    const options = parseStopOptions(result.value);
    if (options === null) {
      writeStopFailure(res, new SessionStopError("malformed-request", MALFORMED_STOP_BODY));
      return;
    }
    try {
      const { outcome, session } = await stopSession(state, sessionId, options);
      const body: StopAcceptedWire = { sessionId, outcome, status: session.status };
      writeJson(res, 200, body);
    } catch (error) {
      // Typed by the guard that refused it or the rule that could not complete it; anything
      // unclassifiable becomes an honest `stop-failed` rather than a success nobody can trust.
      const failure = toStopFailure(error);
      // Error trail (#61): an emergency-stop was refused or could not complete — a session the operator
      // asked to kill may still be live. The typed code IS the diagnosis (unknown-session / taken-over /
      // ambiguous-surface / stop-failed / …), named to the session it concerns.
      state.logger.log({
        category: "error",
        level: "warn",
        event: "stop-failed",
        sessionId,
        detail: `${failure.code}: ${failure.message}`,
      });
      writeStopFailure(res, failure);
    }
  });
}
