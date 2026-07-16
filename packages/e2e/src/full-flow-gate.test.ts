// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { classifyFullFlowGate, FULL_FLOW_CHECK, type FullFlowCapture } from "./full-flow-gate.js";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import type { ObservedConnection } from "./inference-guarantee.js";

// The Tier-A encoding of #67's three ACs, and the fence-free half of the full-flow release gate:
// the JUDGMENT is proven here, credential-free, on every `test` run; only the TRANSPORT is fenced
// to an operator's tailnet (`full-flow-gate.e2e.test.ts`). Without this file the gate's verdict
// logic would be exercised only where no CI can see it.

const CONTROL: ObservedConnection = {
  leg: "control",
  receivedBy: "local-server",
  intendedHost: "127.0.0.1:8787",
};

function inferenceFor(sessionId: string): ObservedConnection {
  return { leg: "inference", receivedBy: "anthropic", intendedHost: ANTHROPIC_INFERENCE_HOST, sessionId };
}

const RUNNING = ["run-1", "run-2"];
const LAUNCHED = "launched-1";

/** A capture of a clean, complete run: ≥2 concurrent + 1 launched, all reaching Anthropic. */
function verifiedCapture(): FullFlowCapture {
  return {
    tunnelUp: true,
    publicHost: "box.tail1234.ts.net",
    publicSurface: false,
    runningSessionIds: RUNNING,
    launchedSessionId: LAUNCHED,
    drivenOverTunnel: true,
    standInLive: true,
    observed: [CONTROL, inferenceFor("run-1"), inferenceFor("run-2"), inferenceFor(LAUNCHED)],
    inferenceHost: ANTHROPIC_INFERENCE_HOST,
  };
}

describe("classifyFullFlowGate", () => {
  describe("Rule: the inference-untouched assertion runs as part of the gate (AC-1)", () => {
    it("verifies a clean full flow, and reports the sessions it asserted across", () => {
      const report = classifyFullFlowGate(verifiedCapture());
      expect(report.verdict).toBe("verified");
      expect(report.violations).toEqual([]);
      // The AC-1 receipt: the assertion demonstrably ran over the flow's OWN carried sessions.
      expect([...report.assertedSessionIds].sort()).toEqual(["launched-1", "run-1", "run-2"]);
    });

    it("cannot verify when no traffic was observed — an unrun assertion is never a pass", () => {
      const report = classifyFullFlowGate({ ...verifiedCapture(), observed: undefined });
      expect(report.verdict).toBe("inconclusive");
      expect(report.assertedSessionIds).toEqual([]);
      expect(report.reason).toContain(FULL_FLOW_CHECK.inference);
    });

    it("asserts across the launched session too, not only the concurrent ones", () => {
      // The launched session performed no observed turn. An implementation that asserted only
      // over `runningSessionIds` would call this verified — the exact hole AC-2 names.
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        observed: [CONTROL, inferenceFor("run-1"), inferenceFor("run-2")],
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(LAUNCHED);
    });
  });

  describe("Rule: every session's inference still reaches api.anthropic.com (AC-2)", () => {
    it("drifts when a carried session's inference was never observed reaching Anthropic", () => {
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        observed: [CONTROL, inferenceFor("run-1"), inferenceFor(LAUNCHED)],
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain("run-2");
      expect(report.violations.join(" ")).toContain(FULL_FLOW_CHECK.inference);
    });
  });

  describe("Rule: the gate fails if any session's inference is redirected (AC-3)", () => {
    it("drifts when one session's inference reached the local server", () => {
      const redirected: ObservedConnection = {
        leg: "inference",
        receivedBy: "local-server",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
      };
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        observed: [CONTROL, inferenceFor("run-1"), inferenceFor(LAUNCHED), redirected],
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain("must never proxy or reroute model traffic");
    });

    it("reports drift, NOT inconclusive, when a leak coincides with an incomplete flow", () => {
      // Drift outranks a gap: a partial flow that leaked inference is still a leak, and a gate
      // that downgraded it to "couldn't tell" would let the release through on a runtime-skip.
      const redirected: ObservedConnection = {
        leg: "inference",
        receivedBy: "local-server",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
      };
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        tunnelUp: false,
        publicSurface: undefined,
        drivenOverTunnel: undefined,
        launchedSessionId: undefined,
        observed: [CONTROL, inferenceFor("run-1"), redirected],
      });
      expect(report.verdict).toBe("drift");
    });
  });

  describe("Rule: a public reachable base is a violation, not a gap", () => {
    it("drifts on a PUBLIC base", () => {
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        publicHost: "gate.example.com",
        publicSurface: true,
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(FULL_FLOW_CHECK.publicSurface);
    });
  });

  describe("Rule: a missing leg is inconclusive — a runtime-skip, never a fabricated green", () => {
    // EXHAUSTIVE sweep over every gating leg. A per-field enumeration can only test the fields
    // someone thought to name; this asserts that degrading ANY single gating leg of an otherwise
    // clean capture makes `verified` unreachable. It is the property the gate actually claims.
    //
    // Each row also pins the CHECK its gap must be reported under. That is not decoration: the
    // labels are what an operator reads off a fenced `inconclusive` to know which leg to go fix,
    // and a verdict-only sweep passes green while a gap names the wrong one entirely.
    const legs: ReadonlyArray<readonly [string, Partial<FullFlowCapture>, string]> = [
      ["tunnel never came up", { tunnelUp: false, publicSurface: undefined }, FULL_FLOW_CHECK.tunnel],
      ["the base was never judged", { publicSurface: undefined }, FULL_FLOW_CHECK.publicSurface],
      ["only one concurrent session", { runningSessionIds: ["run-1"] }, FULL_FLOW_CHECK.concurrent],
      ["no concurrent sessions", { runningSessionIds: [] }, FULL_FLOW_CHECK.concurrent],
      ["no launched session", { launchedSessionId: undefined }, FULL_FLOW_CHECK.launched],
      ["the phone never drove the flow", { drivenOverTunnel: undefined }, FULL_FLOW_CHECK.driven],
      ["the phone's drive was not confirmed", { drivenOverTunnel: false }, FULL_FLOW_CHECK.driven],
      ["the stand-in was never probed", { standInLive: undefined }, FULL_FLOW_CHECK.standIn],
      ["the stand-in failed its canary", { standInLive: false }, FULL_FLOW_CHECK.standIn],
      ["nothing was observed", { observed: undefined }, FULL_FLOW_CHECK.inference],
    ];

    // `inconclusive` is asserted rather than merely `not "verified"`: it is the stronger claim
    // (it subsumes the weaker one) AND it is the one the gate's precedence actually promises —
    // a degraded-but-honest flow must read as a runtime-skip, never as a drift that fails a
    // release on a leg nobody could capture.
    it.each(legs)("is inconclusive — never verified — when %s, naming the leg", (_leg, degradation, check) => {
      const report = classifyFullFlowGate({ ...verifiedCapture(), ...degradation });
      expect(report.verdict).toBe("inconclusive");
      expect(report.violations).toEqual([]);
      expect(report.reason).toContain(check);
    });

    it("names every gap it found, not just the first", () => {
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        tunnelUp: false,
        publicSurface: undefined,
        launchedSessionId: undefined,
        standInLive: undefined,
      });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(FULL_FLOW_CHECK.tunnel);
      expect(report.reason).toContain(FULL_FLOW_CHECK.launched);
      expect(report.reason).toContain(FULL_FLOW_CHECK.standIn);
    });

    it("is inconclusive — never verified — on a wholly empty capture", () => {
      const report = classifyFullFlowGate({
        tunnelUp: false,
        runningSessionIds: [],
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
      });
      expect(report.verdict).toBe("inconclusive");
      expect(report.assertedSessionIds).toEqual([]);
    });
  });

  describe("Rule: the gate never passes on an assertion it did not run", () => {
    it("stays inconclusive when a flow carried sessions but observed nothing", () => {
      const report = classifyFullFlowGate({ ...verifiedCapture(), observed: undefined });
      expect(report.verdict).toBe("inconclusive");
      expect(report.assertedSessionIds).toEqual([]);
    });

    it("holds the guarantee to the flow's own carried set, not to whatever happened to be observed", () => {
      // Extra attributed traffic for a session the flow never carried must not stand in for a
      // session it did — coverage is checked against the flow's own record of what it carried.
      const report = classifyFullFlowGate({
        ...verifiedCapture(),
        observed: [CONTROL, inferenceFor("run-1"), inferenceFor(LAUNCHED), inferenceFor("a-stranger")],
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain("run-2");
    });
  });
});
