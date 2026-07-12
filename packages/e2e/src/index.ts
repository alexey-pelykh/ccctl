// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/e2e` — end-to-end test harness (placeholder).
 *
 * Target scenario the suite will exercise:
 *
 *   patched headless Claude Code worker
 *     -> @ccctl/server (loopback)
 *     -> SSE to a UI client
 *     -> and, critically, inference STILL hits api.anthropic.com
 *
 * The last leg is the load-bearing assertion: ccctl steers the control channel
 * but must never intercept or reroute model traffic — billing and inference
 * stay on Anthropic under the user's own subscription.
 *
 * The scenario constants below name the intended shape. Four skeletons are now
 * wired, hermetically (loopback only, no patched worker or credentials):
 *
 *   - the AC-5 inference-untouched guarantee — {@link assertInferenceUntouched}
 *     (the pure claim) plus the `traffic-harness` that grounds it in real,
 *     receiver-observed connections (see `inference-untouched.e2e.test.ts`);
 *   - the bridge wire-conformance oracle — {@link assertServerSpeaksBridgeContract}
 *     (`bridge-wire-conformance`), which pins the current environments-bridge flow's
 *     contract face independently and asserts the REAL `@ccctl/server` speaks it,
 *     including the two-token boundary, so a green hermetic run implies
 *     interoperability, not just internal consistency (#124);
 *   - the one-session control-plane flow — register → session-create → work-poll →
 *     per-session channel → phone view + steer, driven end-to-end by
 *     `one-session-harness` (see `one-session-flow.e2e.test.ts`), which PRODUCES the
 *     control-leg fixture the AC-5 assertion runs against; and
 *   - the account-Bearer non-persisting pass-through canary (#60) —
 *     {@link assertBearerNeverObserved}, the runtime complement to core's
 *     compile-time credential-omission proof, asserted observationally over the
 *     one-session flow (see `bearer-canary.e2e.test.ts`).
 *
 * The full happy path with a REAL patched worker and a real egress to
 * api.anthropic.com lands in a later, credentialed wave.
 */

/** The host that inference MUST continue to reach, unproxied. */
export const ANTHROPIC_INFERENCE_HOST = "api.anthropic.com";

/** Describes one end-to-end scenario the suite intends to run. */
export interface E2EScenario {
  readonly name: string;
  /** Host inference is expected to reach (asserted unchanged). */
  readonly inferenceHost: string;
}

/** The canonical happy-path scenario. */
export const CONTROL_PLANE_SCENARIO: E2EScenario = {
  name: "patched worker -> server -> SSE, inference unproxied",
  inferenceHost: ANTHROPIC_INFERENCE_HOST,
};

// The inference-untouched guarantee (the load-bearing correctness claim), the
// traffic harness that grounds it in real, receiver-observed connections, the
// bridge wire-conformance oracle (the current environments-bridge flow's pinned
// contract face + the mock bridge's driving helpers, #124), the one-session flow
// harness (register → session-create → work-poll → per-session channel → phone view
// + steer) that produces the control-leg fixture the AC-5 assertion consumes, and the
// account-Bearer non-persisting pass-through canary (#60) — the runtime complement to
// core's compile-time credential-omission proof, asserted observationally over that
// same one-session flow.
export * from "./inference-guarantee.js";
export * from "./bridge-wire-conformance.js";
export * from "./traffic-harness.js";
export * from "./one-session-harness.js";
export * from "./bearer-canary.js";
