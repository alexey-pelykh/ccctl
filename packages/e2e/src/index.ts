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
 * The scenario constants below name the intended shape. The AC-5 skeleton of the
 * last leg is now wired: {@link assertInferenceUntouched} (the pure guarantee)
 * plus the `traffic-harness` that grounds it in real, receiver-observed
 * connections — see `inference-untouched.e2e.test.ts`. The full happy path
 * (patched worker → SSE) and a real egress to api.anthropic.com land in a later,
 * credentialed wave.
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

// The inference-untouched guarantee (the load-bearing correctness claim) and the
// skeleton harness that grounds it in real, receiver-observed connections.
export * from "./inference-guarantee.js";
export * from "./traffic-harness.js";
