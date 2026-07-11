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
