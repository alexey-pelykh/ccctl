// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import { assertInferenceUntouched, InferenceGuaranteeViolation } from "./inference-guarantee.js";
import {
  observeControlLeg,
  observeInferenceLeg,
  probeStandInLiveness,
  StandInLivenessError,
  startInferenceStandIn,
  type InferenceStandIn,
} from "./traffic-harness.js";

// Skeleton E2E for the load-bearing guarantee: redirecting the session control
// channel to the local server moves ONLY the worker/session traffic — inference
// and billing still reach api.anthropic.com (issue #18, traces E2E-B-002).
//
// Real vs skeleton: the local server is the REAL @ccctl/server and the control
// leg drives the REAL current environments-bridge control POSTs (environment
// register §1 + session create §2, #124); api.anthropic.com is a loopback stand-in
// and the inference leg is a REAL outbound connection carrying `Host:
// api.anthropic.com` directed at it (hermetic — no patched worker, no credentials,
// no egress). Every
// "reached X" below is grounded in a receiver's OWN record (the server's session
// map; the stand-in's request log), never a client's self-report. The later
// credentialed suite swaps the stand-in + synthetic leg for a real worker and the
// real host; assertInferenceUntouched, exercised here, does not change.

const ACCOUNT_BEARER = "oauth-account-secret-e2e";
const EXPECTATION = { inferenceHost: ANTHROPIC_INFERENCE_HOST } as const;

const ccctlServers: CcctlServer[] = [];
const standIns: InferenceStandIn[] = [];

async function startLocalServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  ccctlServers.push(server);
  return server;
}

async function startAnthropicStandIn(): Promise<InferenceStandIn> {
  const standIn = await startInferenceStandIn();
  standIns.push(standIn);
  return standIn;
}

// Every started endpoint binds an ephemeral loopback port and is closed here so
// no listener leaks across the serial e2e run.
afterEach(async () => {
  while (ccctlServers.length > 0) {
    const server = ccctlServers.pop();
    if (server) {
      await server.close();
    }
  }
  while (standIns.length > 0) {
    const standIn = standIns.pop();
    if (standIn) {
      await standIn.close();
    }
  }
});

describe("ccctl e2e: inference is untouched by control-channel redirection (skeleton)", () => {
  describe("Rule: session-control traffic goes to the local server", () => {
    it("environment-register and session-create traffic reach the local server (AC-1)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      const control = await observeControlLeg({ server, bearer: ACCOUNT_BEARER, standIn });

      expect(control.receivedBy).toBe("local-server");
      // ...and it is NOT observed reaching api.anthropic.com.
      expect(standIn.received).toHaveLength(0);
      // Liveness canary (#134): the SAME stand-in instance DOES receive when a request
      // is actually fired at it — so the length-0 above is "control did not arrive",
      // not "this stand-in was never wired". Receiver-grounded in its own log.
      const canary = await probeStandInLiveness(standIn);
      expect(standIn.received).toEqual([canary]);
      expect(server.environments.size).toBe(1);
      expect(server.sessions.size).toBe(1);
    });
  });

  describe("Rule: inference and general-API traffic still reach api.anthropic.com", () => {
    it("an inference request during the flow reaches api.anthropic.com (AC-2)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();
      // Background: a single session is registered and being steered.
      await observeControlLeg({ server, bearer: ACCOUNT_BEARER, standIn });

      const inference = await observeInferenceLeg({
        target: standIn.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });

      expect(inference.receivedBy).toBe("anthropic");
      expect(inference.intendedHost).toBe(ANTHROPIC_INFERENCE_HOST);
      // Grounded in the stand-in's own log: a real request, addressed to
      // api.anthropic.com, arrived at the inference host — not the local server.
      expect(standIn.received).toHaveLength(1);
      expect(standIn.received[0]?.host).toBe(ANTHROPIC_INFERENCE_HOST);
      expect(standIn.received[0]?.path).toBe("/v1/messages");
    });

    it("holds the inference-untouched guarantee across the one-session flow (AC-1 + AC-2)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      const control = await observeControlLeg({ server, bearer: ACCOUNT_BEARER, standIn });
      const inference = await observeInferenceLeg({
        target: standIn.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });

      expect(() => assertInferenceUntouched([control, inference], EXPECTATION)).not.toThrow();
    });
  });

  describe("Rule: a regression that redirects inference fails the assertion", () => {
    it("catches inference traffic pointed at the local server (AC-3, AC-4)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();
      const control = await observeControlLeg({ server, bearer: ACCOUNT_BEARER, standIn });

      // The regression: the inference leg is directed at the LOCAL control-plane
      // server instead of api.anthropic.com.
      const misrouted = await observeInferenceLeg({
        target: server.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });

      // Receiver-grounded (AC-4): the api.anthropic.com stand-in never saw it;
      // the local server answered it. The verdict comes from the receivers, not
      // from the sender claiming where it went.
      expect(misrouted.receivedBy).toBe("local-server");
      expect(standIn.received).toHaveLength(0);
      // Liveness canary (#134): the length-0 is "the misrouted inference did not reach
      // the stand-in", not "the stand-in was dead" — the SAME instance receives a probe
      // fired straight at it. Guards this negative-space assertion the same way.
      const canary = await probeStandInLiveness(standIn);
      expect(standIn.received).toEqual([canary]);

      // ...and the guarantee catches the regression (AC-3).
      expect(() => assertInferenceUntouched([control, misrouted], EXPECTATION)).toThrow(InferenceGuaranteeViolation);
    });
  });

  describe("Rule: the liveness canary is armed — a dead stand-in fails it", () => {
    it("a deliberately-closed (unwired) stand-in FAILS the canary, so no length-0 passes vacuously", async () => {
      // Build a real stand-in, then deliberately un-wire it by closing it: a closed
      // stand-in can no longer receive — exactly the "dead stand-in" that makes a bare
      // `received.length === 0` a vacuous pass. Managed locally (already closed), so the
      // afterEach cleanup has nothing to double-close.
      const deadStandIn = await startInferenceStandIn();
      await deadStandIn.close();

      // The canary catches it: the probe cannot land, so it throws rather than passing.
      await expect(probeStandInLiveness(deadStandIn)).rejects.toThrow(StandInLivenessError);
      // ...and the log stayed empty — a length-0 that now provably means "dead", which
      // is precisely why the positive canaries above are load-bearing.
      expect(deadStandIn.received).toHaveLength(0);
    });
  });
});
