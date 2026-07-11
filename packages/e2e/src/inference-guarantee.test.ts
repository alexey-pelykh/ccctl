// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import {
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
