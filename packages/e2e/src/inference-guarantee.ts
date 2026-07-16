// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The load-bearing correctness claim of ccctl, as a pure assertion.
 *
 * ccctl redirects the session **control** channel to the local server, but must
 * NEVER proxy or reroute **model** traffic — inference and billing stay on
 * `api.anthropic.com` under the user's own subscription. This module encodes
 * that guarantee as {@link assertInferenceUntouched}, a pure function over a set
 * of {@link ObservedConnection}s: it is bidirectional, so it fails both when
 * control traffic escapes to Anthropic AND when inference traffic is caught
 * being pointed at the local server (the regression the whole system exists to
 * prevent).
 *
 * The function is intentionally transport-free: it consumes observations and
 * renders a verdict. WHERE the observations come from is the harness's job — the
 * skeleton E2E grounds each one in a real server's own receipt record (see
 * `traffic-harness.ts`), and the later credentialed suite will feed it
 * observations from a real patched worker reaching the real `api.anthropic.com`.
 * Keeping the verdict pure lets both the always-on unit test and the E2E share
 * exactly one definition of "inference untouched".
 */

/**
 * The two endpoints the one-session flow can reach. `"local-server"` is the
 * ccctl control-plane server on loopback; `"anthropic"` is `api.anthropic.com`
 * (or, in the skeleton, its loopback stand-in). An observation is attributed to
 * one of these by asking the receiver, never by trusting the sender.
 */
export type TrafficReceiver = "local-server" | "anthropic";

/**
 * Which leg of the flow produced a connection: `"control"` is session-control
 * traffic (registration, worker channel, steering, event stream); `"inference"`
 * is a model / general-API call.
 */
export type TrafficLeg = "control" | "inference";

/**
 * One observed outbound connection, attributed to the endpoint that actually
 * received it.
 *
 * The attribution is meant to be RECEIVER-grounded: `receivedBy` is filled from
 * the endpoint that logged the inbound connection (the ccctl server's session
 * record, or the Anthropic stand-in's request log), and `intendedHost` is the
 * `Host` that connection carried, read off that same receiver — not a
 * destination a client merely claims it "would" reach. That grounding is what
 * satisfies the "real outbound connection, not a mock's self-reported
 * destination" acceptance criterion; this type only records the result.
 */
export interface ObservedConnection {
  /** Which leg of the flow opened the connection. */
  readonly leg: TrafficLeg;
  /** The endpoint that actually received the connection (from its own record). */
  readonly receivedBy: TrafficReceiver;
  /** The `Host` the connection carried, as seen by the receiver. */
  readonly intendedHost: string;
  /**
   * The session this connection belongs to, when the receiver could attribute it —
   * read from the receiver's own record (the marker the request carried, echoed back
   * out of the stand-in's log), NEVER from the sender's own variable.
   *
   * Optional because attribution is not always feasible: AC-5's full-flow clause is
   * "per-session where attribution is feasible, else aggregate" (#67). `undefined`
   * means "this observation is aggregate-only" — it still counts for the aggregate
   * clauses of {@link assertInferenceUntouched}, but it can never satisfy a
   * per-session coverage requirement (see {@link assertEverySessionInferenceUntouched}),
   * so an unattributable observation is never mistaken for a session's proof.
   */
  readonly sessionId?: string | undefined;
}

/** What {@link assertInferenceUntouched} checks the observations against. */
export interface InferenceGuaranteeExpectation {
  /** The host inference MUST reach, unproxied (e.g. `api.anthropic.com`). */
  readonly inferenceHost: string;
}

/**
 * Thrown by {@link assertInferenceUntouched} when the inference-untouched
 * guarantee is violated. A typed error (not a bare `Error`) so a caller — a
 * test, a future gate — can distinguish a guarantee breach from any other
 * failure and surface the specific `message`.
 */
export class InferenceGuaranteeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceGuaranteeViolation";
  }
}

/**
 * Assert the inference-untouched guarantee over a set of observed connections.
 * Throws {@link InferenceGuaranteeViolation} on any breach; returns normally
 * only when every clause below holds. The clauses are bidirectional — the point
 * is that BOTH directions of leakage are caught, not just the happy path:
 *
 *   1. Session-control traffic is observed reaching the local server, and none
 *      of it reaches Anthropic.
 *   2. Inference traffic is observed reaching `inferenceHost`, and none of it
 *      reaches the local server (this clause catches the regression: inference
 *      pointed at the local server).
 *
 * Fails closed on a degenerate input: zero control OR zero inference
 * observations is a violation, never a vacuous pass — "nothing was observed" is
 * not evidence the guarantee holds.
 */
export function assertInferenceUntouched(
  observed: readonly ObservedConnection[],
  expectation: InferenceGuaranteeExpectation,
): void {
  const { inferenceHost } = expectation;
  const control = observed.filter((connection) => connection.leg === "control");
  const inference = observed.filter((connection) => connection.leg === "inference");

  // Clause 1 — session-control traffic reaches the local server (and only it).
  if (control.length === 0) {
    throw new InferenceGuaranteeViolation("no session-control traffic was observed reaching the local server");
  }
  const escapedControl = control.find((connection) => connection.receivedBy !== "local-server");
  if (escapedControl) {
    throw new InferenceGuaranteeViolation(
      `session-control traffic reached ${escapedControl.receivedBy}, not the local server`,
    );
  }

  // Clause 2 — inference traffic reaches api.anthropic.com (and never the local
  // server). The `receivedBy !== "anthropic"` check is what fails the regression
  // where inference is redirected at the local control plane.
  if (inference.length === 0) {
    throw new InferenceGuaranteeViolation(`no inference traffic was observed reaching ${inferenceHost}`);
  }
  const reroutedInference = inference.find((connection) => connection.receivedBy !== "anthropic");
  if (reroutedInference) {
    throw new InferenceGuaranteeViolation(
      `inference traffic reached ${reroutedInference.receivedBy}, not ${inferenceHost} — ` +
        "the control plane must never proxy or reroute model traffic",
    );
  }
  const wrongHost = inference.find((connection) => connection.intendedHost !== inferenceHost);
  if (wrongHost) {
    throw new InferenceGuaranteeViolation(
      `inference traffic carried host ${wrongHost.intendedHost}, expected ${inferenceHost}`,
    );
  }
}

/** What {@link assertEverySessionInferenceUntouched} checks the observations against. */
export interface SessionInferenceExpectation extends InferenceGuaranteeExpectation {
  /**
   * Every session the flow carried — each one MUST have its own observed inference
   * reaching {@link InferenceGuaranteeExpectation.inferenceHost}. This is the set the
   * coverage clause is checked against, so it must be the flow's OWN record of what it
   * carried (the ids the server minted), not a count the caller hopes for.
   */
  readonly expectedSessionIds: readonly string[];
}

/**
 * Assert the inference-untouched guarantee across EVERY session of a multi-session flow —
 * the full-flow-gate form of {@link assertInferenceUntouched} (issue #67, traces E2E-B-002).
 *
 * The skeleton's aggregate claim answers "did inference reach Anthropic?"; a gate carrying
 * ≥2 concurrent sessions plus a launched one must answer the strictly stronger "did EVERY
 * session's inference reach Anthropic?" — otherwise one session quietly proxied through the
 * local control plane hides behind its siblings' honest traffic, and the aggregate stays
 * green while the guarantee is broken for a real user's session.
 *
 * This does NOT re-define "inference untouched" — clause 1 DELEGATES to
 * {@link assertInferenceUntouched}, which remains the single definition of the bidirectional
 * claim. Clause 2 adds the one thing per-session attribution makes newly checkable:
 *
 *   1. **The shared bidirectional claim** — control reached the local server and only it;
 *      inference reached `inferenceHost` and NEVER the local server. This is the clause that
 *      fails the gate on a redirect (AC-3), including a redirect that carries no session
 *      attribution at all — which, in the stand-in harness, is every redirect there is: a leg
 *      the Anthropic stand-in never took leaves no record to attribute it from (see
 *      `traffic-harness.ts` § observeInferenceLeg).
 *   2. **Per-session coverage** (AC-2) — every id in `expectedSessionIds` has at least one
 *      inference observation OF ITS OWN reaching `inferenceHost`. This is the clause that
 *      NAMES a session whose inference was never proven, and it is receiver-grounded in the
 *      negative: the absence of a session's marker in the stand-in's log is the stand-in's own
 *      testimony, made non-vacuous by the liveness canary (#134) the caller pairs it with.
 *
 * Fails closed throughout: an empty `expectedSessionIds`, or a carried session with no
 * inference observation attributed to it, is a violation — never a vacuous pass. "We observed
 * nothing for this session" is not evidence its inference was untouched, and a gate that let
 * it pass would report green for a flow it never actually exercised.
 */
export function assertEverySessionInferenceUntouched(
  observed: readonly ObservedConnection[],
  expectation: SessionInferenceExpectation,
): void {
  const { inferenceHost, expectedSessionIds } = expectation;

  // Clause 1 — the shared bidirectional claim, unchanged and undiluted.
  assertInferenceUntouched(observed, { inferenceHost });

  // Clause 2 — per-session coverage. Fails closed on a degenerate carry: a gate that
  // carried no sessions proves nothing about a multi-session guarantee.
  if (expectedSessionIds.length === 0) {
    throw new InferenceGuaranteeViolation(
      "no sessions were carried, so no per-session inference guarantee was proven — " +
        "an empty flow is not evidence the guarantee holds",
    );
  }
  // Deliberate, knowing redundancy: given clause 1 above, every surviving inference observation
  // ALREADY has `receivedBy === "anthropic"` and the right host (it would have thrown otherwise),
  // and a `sessionId` of `undefined` could never match a carried id anyway. These sub-clauses are
  // therefore inert TODAY and no test can prove them. They are kept so that this clause is correct
  // STANDALONE — it states the full condition for "this observation proves this session", rather
  // than silently inheriting it from the delegate above. In a gate whose failure mode is a false
  // green on a credential-leak guarantee, a clause that does not depend on a neighbour holding is
  // worth three redundant comparisons.
  const covered = new Set(
    observed
      .filter(
        (connection) =>
          connection.leg === "inference" &&
          connection.sessionId !== undefined &&
          connection.receivedBy === "anthropic" &&
          connection.intendedHost === inferenceHost,
      )
      .map((connection) => connection.sessionId),
  );
  const uncovered = expectedSessionIds.filter((sessionId) => !covered.has(sessionId));
  if (uncovered.length > 0) {
    throw new InferenceGuaranteeViolation(
      `no inference reaching ${inferenceHost} was observed for session(s) ${uncovered.join(", ")} — ` +
        "every carried session must be proven, not just the flow in aggregate",
    );
  }
}
