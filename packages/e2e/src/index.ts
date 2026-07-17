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
 *     one-session flow (see `bearer-canary.e2e.test.ts`); and
 *   - the fenced, self-classifying LIVE-WORKER oracle (#133) —
 *     {@link driveLiveWorkerOracle} + {@link classifyObservedWire}, the credentialed
 *     complement to the hermetic golden: it drives a REAL patched worker against the
 *     built server and self-classifies the observed wire (`verified | drift |
 *     inconclusive`) against the golden's pinned shapes, so a green hermetic run plus a
 *     green live run means the golden encodes the wire a real worker actually speaks.
 *     Fenced on CCCTL_E2E + CCCTL_SDK_URL + ANTHROPIC_API_KEY; skips-never-fakes (see
 *     `control-plane.e2e.test.ts`); and
 *   - the fenced, self-classifying ASKUSERQUESTION PHONE-SURFACING gate (#266, #78 AC4) —
 *     {@link driveLiveAskOracle} + {@link classifyAskSurfacing}, the AskUserQuestion sibling of the
 *     #133 oracle (same fence, same launch seam, EXTENDED with the #78 hook). ADR-005's spike could
 *     not reach the last hop: that a real `bypassPermissions` worker SURFACES its native
 *     `AskUserQuestion` block as `requires_action` over §4/§5 is "a strong INFERENCE, not yet
 *     observed ... which the #266 live-worker gate owns" (`@ccctl/core`). This drives a REAL
 *     `bypassPermissions` worker with the #78 hook installed to invoke `AskUserQuestion`, and reads —
 *     from the server's OWN derived activity (the needs-you) + the hook's OWN capture (the structured
 *     options, classified through core's `requiresActionEnrichmentFromValue`) — whether the decision
 *     surfaces, self-classifying `verified | drift | inconclusive`. Fenced on CCCTL_E2E + CCCTL_SDK_URL
 *     + ANTHROPIC_API_KEY; skips-never-fakes; JUDGMENT proven credential-free in
 *     `live-ask-oracle.test.ts` (see `ask-user-question-gate.e2e.test.ts`). #78 AC4 stays PENDING until
 *     this goes `verified`; and
 *   - the hermetic IDLE-HOLD regression (#167) — {@link assertIdleHeldPastLivenessTimeout}
 *     + {@link classifyIdleHold}, the deterministic proof of the server's #166
 *     downstream-liveness fix. The captured-wire golden pins each leg's SHAPE but is
 *     blind to whether the server HOLDS the worker downstream alive over time; this drives
 *     a worker STAND-IN embodying the reader's ~45s liveness contract against the real
 *     server (booted with a SHORT liveness interval) and asserts the idle downstream stays
 *     open past the timeout, with a `client_event` liveness frame in the window and no drop /
 *     re-register. A starved negative control self-guards the "no drop" verdict (the #134
 *     posture). Hermetic — gates on every run (see `worker-idle-hold.e2e.test.ts`); and
 *   - the fenced, self-classifying FULL-FLOW RELEASE GATE (#67) — {@link driveFullFlowGate} +
 *     {@link classifyFullFlowGate}, the AC-5 guarantee re-verified inside the release-blocking
 *     run rather than only in the one-session slice: two concurrent sessions PLUS one launched
 *     from the phone, carried through one daemon over a real tunnel, with the guarantee asserted
 *     PER SESSION ({@link assertEverySessionInferenceUntouched}). The skeleton's AGGREGATE claim
 *     structurally cannot see a single leaked session — its siblings' honest traffic answers for
 *     it — which is the hole this closes. Fenced on CCCTL_E2E + CCCTL_E2E_TAILSCALE;
 *     skips-never-fakes (see `full-flow-gate.e2e.test.ts`), with its JUDGMENT proven
 *     credential-free in `full-flow-gate.test.ts` and its COMPOSITION hermetically in
 *     `full-flow-inference.test.ts`; and
 *
 *   - the LONG-RUN DAEMON SOAK (#69) — {@link driveDaemonSoak} + {@link classifyDaemonSoak}, the
 *     one question a single pass structurally cannot ask. Every oracle above judges ONE pass, and a
 *     leak of one handle per session lifecycle passes all of them: one pass leaks one handle,
 *     nothing notices, every assertion is green. It is visible only as an ACCUMULATION. So this
 *     keeps ONE daemon UP, runs repeated session lifecycles against it through its own ingress
 *     (launch → §2 claim → worker downstream → stop), and reads #63's OWN FD/handle diagnostics
 *     ({@link captureHandleReport}) between cycles: the count must return to baseline, and must not
 *     climb. Two detectors, both AC2's words — accumulation (per TOTAL and per TYPE, because a
 *     leaked resource while a pooled socket closes nets to zero and reads clean) and no monotonic
 *     growth (the SLOW leak: a series that never comes back down, the only detector with no
 *     tolerance). What it can see is bounded by what that endpoint answers — ref'd libuv resources
 *     (in practice the sockets and pipes), NOT bare file descriptors (#68's `fstat` probe's
 *     question) and NOT the daemon's per-session timers, which are all `.unref()`'d and therefore
 *     invisible to it; `daemon-soak.ts`'s module doc states that boundary and who owns what.
 *     AC1's "multiple days" is the
 *     OPERATOR's lever ({@link SoakPlan}) and the verdict never lies about it
 *     ({@link SoakReport.spannedMultiDay}). Fenced on CCCTL_E2E + CCCTL_E2E_SOAK — but the arm buys
 *     only the SPAN: the compressed soak against a REAL daemon, its negative control, the
 *     classifier AND the drive's own mechanics are all credential-free
 *     (`daemon-soak-lifecycle.test.ts` + `daemon-soak.test.ts`), so they gate every run.
 *
 *   - the TEARDOWN-TIMING RESIDUAL (#70) — {@link driveTeardownTimingResidual} +
 *     {@link classifyTeardownTimingResidual}, the third of W7's residual specs and the one that
 *     closes the gap between the other two. #68 asks the per-fd question ONCE, UNPRESSURED, over the
 *     whole-daemon shutdown path; #69 drives many lifecycles but PACES them and is structurally
 *     fd-BLIND (#63's sampler counts ref'd libuv resources, not bare descriptors — `daemon-soak.ts`'s
 *     own module doc: "A raw fd leak is invisible HERE"). So a handle that lingers only when RACED is
 *     unasked by the first and unseeable by the second. This drives rapid, back-to-back launch/stop
 *     cycles against the REAL node-pty backend — no settling anywhere — and asks the kernel per
 *     cycle. The STOP path (#76) is FORCED by AC1 rather than chosen: shutdown is terminal and the
 *     ghost-reaper is a timer, so it is the only teardown a drive can cycle — and it is the one
 *     where timing is load-bearing by the server's own documentation. TWO self-guards, because it
 *     asserts two absences: the readings must DISAGREE per cycle (#68's), and the PRESSURE is itself
 *     a claim under test — the plan is declared ({@link TeardownTimingPlan}), the launch→stop gap is
 *     MEASURED, and {@link classifyTeardownTimingResidual} refuses to verify a run that fell short
 *     of either axis. Fenced on #68's arm (CCCTL_E2E + CCCTL_E2E_PTY), SHARED deliberately: the
 *     prerequisite is not merely similar but identical — an arm should name a prerequisite, not a
 *     spec. Judgment + drive mechanics are credential-free (`teardown-timing-residual.test.ts`).
 *
 * The live-worker oracle drives the full happy path with a REAL patched worker and a
 * real egress to api.anthropic.com — fenced to the credentialed wave; the hermetic
 * skeletons above stay loopback-only.
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
export * from "./multi-session-harness.js";
export * from "./multi-session-tunnel.js";
export * from "./launch-tunnel.js";
export * from "./full-flow-gate.js";
export * from "./bearer-canary.js";
export * from "./live-worker-oracle.js";
export * from "./live-ask-oracle.js";
export * from "./worker-idle-hold.js";
export * from "./pty-handle-residual.js";
export * from "./daemon-soak.js";
export * from "./teardown-timing-residual.js";
export * from "./arm-pty.js";
export * from "./pty-chain-census.js";
