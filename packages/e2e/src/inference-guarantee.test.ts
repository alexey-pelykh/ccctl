// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import {
  assertEverySessionInferenceUntouched,
  assertInferenceUntouched,
  InferenceGuaranteeViolation,
  type ObservedConnection,
} from "./inference-guarantee.js";

const EXPECTATION = { inferenceHost: ANTHROPIC_INFERENCE_HOST };

const controlToLocal: ObservedConnection = {
  leg: "control",
  receivedBy: "local-server",
  intendedHost: "127.0.0.1:8787",
};

const inferenceToAnthropic: ObservedConnection = {
  leg: "inference",
  receivedBy: "anthropic",
  intendedHost: ANTHROPIC_INFERENCE_HOST,
};

// Unit coverage of the pure guarantee. The E2E suite feeds this same assertion
// observations grounded in real connections; here we drive its clauses directly
// so the load-bearing regression check (inference redirected at the local
// server) is verified on every `test` run, no live worker required.
describe("assertInferenceUntouched", () => {
  it("passes when control reaches the local server and inference reaches api.anthropic.com", () => {
    expect(() => assertInferenceUntouched([controlToLocal, inferenceToAnthropic], EXPECTATION)).not.toThrow();
  });

  it("fails the regression: inference pointed at the local server (AC-3)", () => {
    const reroutedInference: ObservedConnection = {
      leg: "inference",
      receivedBy: "local-server",
      intendedHost: ANTHROPIC_INFERENCE_HOST,
    };
    expect(() => assertInferenceUntouched([controlToLocal, reroutedInference], EXPECTATION)).toThrow(
      InferenceGuaranteeViolation,
    );
    expect(() => assertInferenceUntouched([controlToLocal, reroutedInference], EXPECTATION)).toThrow(
      /must never proxy or reroute model traffic/,
    );
  });

  it("fails when control traffic escapes to api.anthropic.com", () => {
    const escapedControl: ObservedConnection = {
      leg: "control",
      receivedBy: "anthropic",
      intendedHost: ANTHROPIC_INFERENCE_HOST,
    };
    expect(() => assertInferenceUntouched([escapedControl, inferenceToAnthropic], EXPECTATION)).toThrow(
      InferenceGuaranteeViolation,
    );
  });

  it("fails closed when no control traffic was observed", () => {
    expect(() => assertInferenceUntouched([inferenceToAnthropic], EXPECTATION)).toThrow(/no session-control traffic/);
  });

  it("fails closed when no inference traffic was observed", () => {
    expect(() => assertInferenceUntouched([controlToLocal], EXPECTATION)).toThrow(
      new RegExp(`no inference traffic was observed reaching ${ANTHROPIC_INFERENCE_HOST}`),
    );
  });

  it("fails closed on an empty observation set (degenerate input is not a pass)", () => {
    expect(() => assertInferenceUntouched([], EXPECTATION)).toThrow(InferenceGuaranteeViolation);
  });

  it("fails when inference reaches Anthropic but under the wrong host", () => {
    const wrongHost: ObservedConnection = {
      leg: "inference",
      receivedBy: "anthropic",
      intendedHost: "api.evil.example",
    };
    expect(() => assertInferenceUntouched([controlToLocal, wrongHost], EXPECTATION)).toThrow(
      /expected api\.anthropic\.com/,
    );
  });

  it("tags its violation so callers can distinguish a guarantee breach", () => {
    try {
      assertInferenceUntouched([], EXPECTATION);
      expect.unreachable("expected a violation");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceGuaranteeViolation);
      expect((error as InferenceGuaranteeViolation).name).toBe("InferenceGuaranteeViolation");
    }
  });
});

/** One session's honest model turn: observed reaching Anthropic, attributed to `sessionId`. */
function inferenceFor(sessionId: string): ObservedConnection {
  return { leg: "inference", receivedBy: "anthropic", intendedHost: ANTHROPIC_INFERENCE_HOST, sessionId };
}

// The full-flow-gate form of the guarantee (#67, traces E2E-B-002). The aggregate claim above
// answers "did inference reach Anthropic?"; a gate carrying several concurrent sessions plus a
// launched one must answer "did EVERY session's inference reach Anthropic?" — the strictly
// stronger claim an aggregate hides, because one leaked session's siblings answer for it.
// Driven directly here so the Tier-A encoding of #67's three ACs gates every `test` run, no
// tailnet required.
describe("assertEverySessionInferenceUntouched", () => {
  describe("Rule: every session's inference still reaches api.anthropic.com (AC-2)", () => {
    it("passes when all three carried sessions each reached api.anthropic.com", () => {
      const observed = [controlToLocal, inferenceFor("s1"), inferenceFor("s2"), inferenceFor("launched")];
      expect(() =>
        assertEverySessionInferenceUntouched(observed, {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1", "s2", "launched"],
        }),
      ).not.toThrow();
    });

    it("fails closed on a session with NO inference observation, naming it (a sibling's traffic is not its proof)", () => {
      // s2 is carried but never performed an observed turn. The AGGREGATE claim passes here —
      // s1 and the launched session reached Anthropic — which is exactly the hole this closes.
      const observed = [controlToLocal, inferenceFor("s1"), inferenceFor("launched")];
      expect(() => assertInferenceUntouched(observed, { inferenceHost: ANTHROPIC_INFERENCE_HOST })).not.toThrow();
      expect(() =>
        assertEverySessionInferenceUntouched(observed, {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1", "s2", "launched"],
        }),
      ).toThrow(/no inference reaching api\.anthropic\.com was observed for session\(s\) s2/);
    });

    it("names every uncovered session, not just the first", () => {
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, inferenceFor("s1")], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1", "s2", "s3"],
        }),
      ).toThrow(/session\(s\) s2, s3/);
    });

    it("does not let an UNATTRIBUTED inference observation cover a carried session", () => {
      // An aggregate-only observation (no receiver attribution) is real traffic, but it is not
      // evidence for any particular session — otherwise one unattributed leg would vouch for all.
      const unattributed: ObservedConnection = {
        leg: "inference",
        receivedBy: "anthropic",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
      };
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, unattributed], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1"],
        }),
      ).toThrow(/no inference reaching api\.anthropic\.com was observed for session\(s\) s1/);
    });

    it("rejects a WRONG-HOST inference observation — via the delegated host clause", () => {
      // Asserting the delegate's OWN message, because that is what actually fires: the coverage
      // filter's host check is redundant behind it (see `assertEverySessionInferenceUntouched`
      // § deliberate redundancy). Pinning the real message keeps the test honest about which
      // clause is load-bearing, rather than implying coverage caught it.
      const wrongHost: ObservedConnection = {
        leg: "inference",
        receivedBy: "anthropic",
        intendedHost: "api.evil.example",
        sessionId: "s1",
      };
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, wrongHost], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1"],
        }),
      ).toThrow(/carried host api\.evil\.example, expected api\.anthropic\.com/);
    });
  });

  describe("Rule: the gate fails if any session's inference is redirected (AC-3)", () => {
    it("fails when one carried session's inference reached the local server", () => {
      // The redirected leg carries no attribution — the Anthropic stand-in never took it, so it
      // has no record to attribute it from (`traffic-harness.ts` § observeInferenceLeg). The
      // delegated bidirectional clause is what catches it, which is why it is not optional here.
      const redirected: ObservedConnection = {
        leg: "inference",
        receivedBy: "local-server",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
      };
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, inferenceFor("s1"), redirected], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1", "s2"],
        }),
      ).toThrow(/must never proxy or reroute model traffic/);
    });

    it("fails when a session's inference is redirected even though it IS attributed", () => {
      const attributedRedirect: ObservedConnection = {
        leg: "inference",
        receivedBy: "local-server",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
        sessionId: "s2",
      };
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, inferenceFor("s1"), attributedRedirect], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1", "s2"],
        }),
      ).toThrow(InferenceGuaranteeViolation);
    });
  });

  describe("Rule: the shared bidirectional claim is delegated, not re-defined", () => {
    it("still fails when control traffic escapes to api.anthropic.com", () => {
      const escapedControl: ObservedConnection = {
        leg: "control",
        receivedBy: "anthropic",
        intendedHost: ANTHROPIC_INFERENCE_HOST,
      };
      expect(() =>
        assertEverySessionInferenceUntouched([escapedControl, inferenceFor("s1")], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1"],
        }),
      ).toThrow(/session-control traffic reached anthropic/);
    });

    it("still fails closed when no control traffic was observed", () => {
      expect(() =>
        assertEverySessionInferenceUntouched([inferenceFor("s1")], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1"],
        }),
      ).toThrow(/no session-control traffic/);
    });
  });

  describe("Rule: a degenerate flow is never a pass", () => {
    it("fails closed when the flow carried no sessions at all", () => {
      expect(() =>
        assertEverySessionInferenceUntouched([controlToLocal, inferenceToAnthropic], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: [],
        }),
      ).toThrow(/no sessions were carried/);
    });

    it("fails closed on an empty observation set", () => {
      expect(() =>
        assertEverySessionInferenceUntouched([], {
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          expectedSessionIds: ["s1"],
        }),
      ).toThrow(InferenceGuaranteeViolation);
    });
  });
});
