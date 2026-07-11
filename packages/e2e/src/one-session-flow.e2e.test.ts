// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { formatAuthority } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import { assertInferenceUntouched, InferenceGuaranteeViolation } from "./inference-guarantee.js";
import { driveOneSessionFlow, waitFor, type OneSessionFlow } from "./one-session-harness.js";
import { observeInferenceLeg, startInferenceStandIn, type InferenceStandIn } from "./traffic-harness.js";
// The REAL phone client logic — the EventSource transcript view (#15) and the
// fetch-POST steer builder (#16). Imported and exercised so the flow runs the
// actual UI decode/build code, never a re-implemented stand-in of it.
import { processEventData } from "@ccctl/web-ui/src/transcript.js";
import { describeCommand, inputCommand } from "@ccctl/web-ui/src/command.js";

// Skeleton E2E for the one-session control-plane flow (issue #19, traces E2E-B-002):
// register → server → phone view + steer, driven end-to-end against the REAL
// @ccctl/server on loopback with a stand-in worker + phone (hermetic — no patched
// worker, no credentials, no egress). Every "reached X" is grounded in the
// receiver's OWN record (the server's session map; the phone's SSE log; the
// worker's inbound frames), never a sender's self-report — the same posture the
// inference-untouched legs hold. The flow this harness drives PRODUCES the
// control-leg fixture that the AC-5 assertion (#18, assertInferenceUntouched) runs
// against; the later credentialed suite swaps the stand-ins for a real worker +
// browser and a real api.anthropic.com, and the assertion does not change.

const ACCOUNT_BEARER = "oauth-account-secret-e2e-flow";
const EXPECTATION = { inferenceHost: ANTHROPIC_INFERENCE_HOST } as const;

const ccctlServers: CcctlServer[] = [];
const standIns: InferenceStandIn[] = [];
const flows: OneSessionFlow[] = [];

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

// Close each flow's stand-in phone + worker sockets FIRST, then the servers and
// stand-ins, so no client write races a closing server and no listener leaks
// across the serial e2e run.
afterEach(async () => {
  while (flows.length > 0) {
    await flows.pop()?.close();
  }
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
  while (standIns.length > 0) {
    await standIns.pop()?.close();
  }
});

describe("ccctl e2e: one-session flow — register → server → phone view + steer (skeleton)", () => {
  describe("Rule: the harness drives the one-session flow end-to-end", () => {
    it("registers, views a transcript event over SSE, and steers over the worker channel (AC-1)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      // The steer is built by the REAL phone command builder (#16), so the flow sends
      // exactly the verb+payload the UI would.
      const steer = inputCommand("continue please");
      expect(steer).not.toBeNull();
      const flow = await driveOneSessionFlow({ server, bearer: ACCOUNT_BEARER, standIn, steer: steer ?? undefined });
      flows.push(flow);

      // register — the local server recorded exactly the one session, keyed by the wire
      // session_id, and the minted ws_url points back at THIS server for THAT session.
      expect(server.sessions.size).toBe(1);
      expect(server.sessions.has(flow.sessionId)).toBe(true);
      expect(server.sessions.get(flow.sessionId)?.status).toBe("ready");
      expect(flow.wsUrl).toContain(flow.sessionId);

      // phone VIEW (#15) — the phone saw the worker's transcript event over SSE with the
      // monotonic Last-Event-ID, and the REAL UI decode classifies it as a transcript line.
      expect(flow.viewed.id).toBe("1");
      expect(JSON.parse(flow.viewed.data)).toEqual(flow.transcriptEvent);
      expect(processEventData(flow.viewed.data)).toEqual({
        kind: "transcript",
        subtype: "message",
        summary: "hi from the worker",
      });

      // phone STEER (#16) — the worker received the phone's verb re-framed as a
      // control_request carrying the SERVER-minted id and the REAL builder's payload.
      expect(flow.relayedSteer).toEqual({
        type: "control_request",
        id: flow.steerId,
        subtype: "prompt",
        payload: { text: "continue please" },
      });
      expect(describeCommand(flow.steer)).toBe("continue please");

      // ...and nothing crossed to the api.anthropic.com stand-in in the whole flow.
      expect(standIn.received).toHaveLength(0);
    });

    it("derives session activity from a worker_status frame and the phone views it as the current turn (#11 + #15)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      const flow = await driveOneSessionFlow({ server, bearer: ACCOUNT_BEARER, standIn });
      flows.push(flow);

      // The worker reports it is running: the server derives the tri-state activity off the
      // worker channel (#11 read path)...
      flow.worker.emitEvent({ type: "control_event", subtype: "worker_status", payload: { status: "running" } });
      await waitFor(() => server.sessions.get(flow.sessionId)?.activity.kind === "running");

      // ...and the phone views that same frame over SSE, which the REAL UI decode renders as the
      // current turn rather than a transcript line (#15).
      await waitFor(() => flow.ui.viewed().length >= 2);
      const activityView = flow.ui.viewed().at(-1);
      expect(activityView).toBeDefined();
      expect(processEventData(activityView?.data ?? "")).toMatchObject({ kind: "activity", status: "running" });

      expect(standIn.received).toHaveLength(0);
    });
  });

  describe("Rule: the flow provides the fixture the inference-untouched assertion runs against (#18)", () => {
    it("the control leg it grounds + a real inference leg satisfy assertInferenceUntouched (AC-2)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      const flow = await driveOneSessionFlow({ server, bearer: ACCOUNT_BEARER, standIn });
      flows.push(flow);

      // The whole flow grounds ONE control-leg observation: control reached the local server.
      expect(flow.control).toEqual({
        leg: "control",
        receivedBy: "local-server",
        intendedHost: formatAuthority(server.address.host, server.address.port),
      });

      // A real inference leg (Host: api.anthropic.com, observed by the stand-in) completes
      // the fixture; the #18 assertion holds over the pair.
      const inference = await observeInferenceLeg({
        target: standIn.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });
      expect(inference.receivedBy).toBe("anthropic");
      expect(() => assertInferenceUntouched([flow.control, inference], EXPECTATION)).not.toThrow();
    });

    it("catches the regression: inference redirected at the local server fails the guarantee (AC-3)", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      const flow = await driveOneSessionFlow({ server, bearer: ACCOUNT_BEARER, standIn });
      flows.push(flow);

      // The regression: the inference leg is pointed at the LOCAL control-plane server. The
      // stand-in never saw it; the guarantee, fed the SAME control fixture, catches it.
      const misrouted = await observeInferenceLeg({
        target: server.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });
      expect(misrouted.receivedBy).toBe("local-server");
      expect(standIn.received).toHaveLength(0);
      expect(() => assertInferenceUntouched([flow.control, misrouted], EXPECTATION)).toThrow(
        InferenceGuaranteeViolation,
      );
    });
  });
});
