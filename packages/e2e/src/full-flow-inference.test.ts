// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { startServer, type CcctlServer } from "@ccctl/server";
import { createSession, pollWork, registerEnvironment } from "./bridge-wire-conformance.js";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import {
  assertEverySessionInferenceUntouched,
  InferenceGuaranteeViolation,
  type ObservedConnection,
} from "./inference-guarantee.js";
import { connectFakeWorker } from "./one-session-harness.js";
import {
  observeInferenceLeg,
  probeStandInLiveness,
  startInferenceStandIn,
  type InferenceStandIn,
} from "./traffic-harness.js";

// The MULTI-SESSION inference-untouched composition over LOOPBACK (#67) — the hermetic skeleton
// the fenced full-flow release gate (`full-flow-gate.e2e.test.ts`) graduates to a real tailnet,
// in the posture every other oracle in this package holds: `multi-session-harness` (#20) is the
// skeleton #65's tunnel oracle graduates; `launch-lifecycle.test.ts` is #66's.
//
// It exists because the fenced gate's whole judgment rests on ONE composition that, before this
// file, was proven NOWHERE: that several concurrent sessions each performing a model turn yield
// PER-SESSION, RECEIVER-GROUNDED attribution — the marker riding out on the request and coming
// back off the stand-in's own log — and that a redirect of ONE session among several is caught.
// `inference-guarantee.test.ts` pins the assertion as a PURE function over constructed
// observations; `inference-untouched.e2e.test.ts` (#18) drives real traffic but for exactly ONE
// session and with no attribution at all. Neither shows that attribution survives a real HTTP
// round-trip through a real stand-in when several sessions are in flight — which is precisely
// what the gate's per-session clause depends on.
//
// That gap is what makes this a SELF-GUARD rather than a duplicate — the `probeStandInLiveness`
// (#134) posture: prove the composition works when nothing is in the way, so a fenced `drift`
// reads as "the tunnel leg broke it" rather than "the harness was never right". Without it, a
// harness bug (a marker header that never reaches the receiver; attribution silently read from
// the sender) would surface as a FALSE verdict only on an operator's tailnet, where no CI is
// watching — and a marker read from the sender would make the gate pass by construction.
//
// Hermetic and credential-free: loopback only, stand-in workers, a loopback stand-in for
// api.anthropic.com, NO tunnel and no claim about one — so it gates on EVERY `test` run. The real
// tailnet is the one thing it deliberately says nothing about; that is the fenced gate's job, and
// faking a tunnel here to claim it would be the circular fixture #131 removed.

const ACCOUNT_BEARER = "oauth-account-secret-full-flow-inference";
const EXPECTATION = { inferenceHost: ANTHROPIC_INFERENCE_HOST };

const started: CcctlServer[] = [];
const standIns: InferenceStandIn[] = [];

async function serve(): Promise<CcctlServer> {
  const server = await startServer({ port: 0 });
  started.push(server);
  return server;
}

async function anthropicStandIn(): Promise<InferenceStandIn> {
  const standIn = await startInferenceStandIn();
  standIns.push(standIn);
  return standIn;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
  while (standIns.length > 0) {
    await standIns.pop()?.close();
  }
});

/**
 * Carry `count` concurrent sessions on-box over the REAL bridge legs (§1 register → §2 create →
 * §3 poll → §4 worker channel), and return their ids plus the control observation grounded in the
 * server's OWN records. Mirrors what the fenced gate does, minus the tunnel.
 */
async function carrySessions(
  server: CcctlServer,
  count: number,
): Promise<{ sessionIds: string[]; control: ObservedConnection; close: () => Promise<void> }> {
  const { environmentId } = await registerEnvironment(server, ACCOUNT_BEARER);
  const sessionIds: string[] = [];
  const workers: Array<{ close: () => Promise<void> }> = [];
  for (let index = 0; index < count; index += 1) {
    const { sessionId } = await createSession(server, ACCOUNT_BEARER);
    const delivered = await pollWork(server, environmentId);
    expect(delivered.item.data.type).toBe("session");
    expect(delivered.item.data.id).toBe(sessionId);
    const worker = await connectFakeWorker({ server, sessionId });
    await worker.putStatus("idle");
    workers.push(worker);
    sessionIds.push(sessionId);
  }
  // Receiver-grounded: the server's own environment + session records prove it took the control
  // traffic — the same grounding the fenced gate builds its control observation from.
  expect(server.environments.has(environmentId)).toBe(true);
  for (const sessionId of sessionIds) {
    expect(server.sessions.has(sessionId)).toBe(true);
  }
  return {
    sessionIds,
    control: {
      leg: "control",
      receivedBy: "local-server",
      intendedHost: `${server.address.host}:${server.address.port}`,
    },
    close: async () => {
      for (const worker of workers) {
        await worker.close();
      }
    },
  };
}

describe("ccctl: the inference-untouched guarantee across a MULTI-SESSION flow (loopback skeleton)", () => {
  describe("Rule: every session's inference reaches api.anthropic.com, attributed per session", () => {
    it("attributes each of three concurrent sessions' turns from the RECEIVER's own log", async () => {
      const server = await serve();
      const standIn = await anthropicStandIn();
      const flow = await carrySessions(server, 3);

      const observed: ObservedConnection[] = [flow.control];
      for (const sessionId of flow.sessionIds) {
        observed.push(
          await observeInferenceLeg({
            target: standIn.address,
            inferenceHost: ANTHROPIC_INFERENCE_HOST,
            standIn,
            sessionId,
          }),
        );
      }

      // The stand-in's OWN log is the record: three real inference requests arrived, each
      // carrying api.anthropic.com and its own session's marker. This is the round-trip the
      // gate's per-session clause rests on, and nothing else in the suite proves it.
      expect(standIn.received).toHaveLength(3);
      expect(standIn.received.map((record) => record.sessionMarker)).toEqual(flow.sessionIds);
      expect(standIn.received.every((record) => record.host === ANTHROPIC_INFERENCE_HOST)).toBe(true);
      // ...and the observations carry the receiver's attribution, not the sender's.
      expect(observed.filter((c) => c.leg === "inference").map((c) => c.sessionId)).toEqual(flow.sessionIds);

      expect(() =>
        assertEverySessionInferenceUntouched(observed, { ...EXPECTATION, expectedSessionIds: flow.sessionIds }),
      ).not.toThrow();

      await flow.close();
    });

    it("holds with the concurrent sessions and a later-carried one together (the gate's shape)", async () => {
      const server = await serve();
      const standIn = await anthropicStandIn();
      // Two concurrent sessions, then one more carried after them — the gate's "≥2 running plus a
      // launched one" shape, minus the launch ingress (that leg is #66's, exercised by the gate).
      const running = await carrySessions(server, 2);
      const later = await carrySessions(server, 1);
      const carried = [...running.sessionIds, ...later.sessionIds];

      const observed: ObservedConnection[] = [running.control];
      for (const sessionId of carried) {
        observed.push(
          await observeInferenceLeg({
            target: standIn.address,
            inferenceHost: ANTHROPIC_INFERENCE_HOST,
            standIn,
            sessionId,
          }),
        );
      }

      expect(() =>
        assertEverySessionInferenceUntouched(observed, { ...EXPECTATION, expectedSessionIds: carried }),
      ).not.toThrow();

      await running.close();
      await later.close();
    });
  });

  describe("Rule: a redirected session fails the guarantee, even among honest siblings", () => {
    it("catches ONE session's inference pointed at the local server while the others are honest", async () => {
      const server = await serve();
      const standIn = await anthropicStandIn();
      const flow = await carrySessions(server, 3);
      const [first, leaked, third] = flow.sessionIds as [string, string, string];

      const observed: ObservedConnection[] = [
        flow.control,
        await observeInferenceLeg({
          target: standIn.address,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          standIn,
          sessionId: first,
        }),
        // The regression, driven for real: this session's model turn is physically directed at the
        // LOCAL control-plane server instead of api.anthropic.com.
        await observeInferenceLeg({
          target: server.address,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          standIn,
          sessionId: leaked,
        }),
        await observeInferenceLeg({
          target: standIn.address,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          standIn,
          sessionId: third,
        }),
      ];

      // Receiver-grounded: the stand-in saw only the two honest turns, and the leaked session's
      // marker is absent from its log — so the leak leaves no attribution to launder itself with.
      expect(standIn.received).toHaveLength(2);
      expect(standIn.received.map((record) => record.sessionMarker)).toEqual([first, third]);
      // Liveness canary (#134): the absence above is "the leaked turn did not arrive", not "the
      // stand-in was dead" — the SAME instance receives a probe fired straight at it. The throw
      // inside `probeStandInLiveness` IS the check; what is worth asserting here is that the log
      // grew by exactly the canary — i.e. the leaked turn did not belatedly land alongside it.
      // (Comparing the returned canary to `received.at(-1)` would be reference-identical and prove
      // nothing.)
      await probeStandInLiveness(standIn);
      expect(standIn.received).toHaveLength(3);
      expect(standIn.received.map((record) => record.sessionMarker)).toEqual([first, third, undefined]);

      expect(() =>
        assertEverySessionInferenceUntouched(observed, { ...EXPECTATION, expectedSessionIds: flow.sessionIds }),
      ).toThrow(InferenceGuaranteeViolation);

      await flow.close();
    });

    it("fails a session that performed no turn at all, though its siblings all did", async () => {
      const server = await serve();
      const standIn = await anthropicStandIn();
      const flow = await carrySessions(server, 3);
      const [first, silent, third] = flow.sessionIds as [string, string, string];

      const observed: ObservedConnection[] = [
        flow.control,
        await observeInferenceLeg({
          target: standIn.address,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          standIn,
          sessionId: first,
        }),
        await observeInferenceLeg({
          target: standIn.address,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          standIn,
          sessionId: third,
        }),
      ];

      expect(() =>
        assertEverySessionInferenceUntouched(observed, { ...EXPECTATION, expectedSessionIds: flow.sessionIds }),
      ).toThrow(new RegExp(`session\\(s\\) ${silent}`));

      await flow.close();
    });
  });

  describe("Rule: attribution comes from the receiver, never the sender", () => {
    it("yields NO attribution for a turn the stand-in never took, so a leak cannot vouch for itself", async () => {
      const server = await serve();
      const standIn = await anthropicStandIn();

      // Directed at the local server; the stand-in never sees it. Were attribution echoed from
      // the caller's argument, this would come back tagged `s-leaked` and could then satisfy the
      // per-session coverage clause — the gate would pass BY CONSTRUCTION on a real leak.
      const leaked = await observeInferenceLeg({
        target: server.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
        sessionId: "s-leaked",
      });

      expect(leaked.receivedBy).toBe("local-server");
      expect(leaked.sessionId).toBeUndefined();
      expect(standIn.received).toHaveLength(0);
      const canary = await probeStandInLiveness(standIn);
      expect(standIn.received).toEqual([canary]);
    });

    it("carries no session marker when the leg is unattributed (the one-session skeleton's shape)", async () => {
      const standIn = await anthropicStandIn();
      const observation = await observeInferenceLeg({
        target: standIn.address,
        inferenceHost: ANTHROPIC_INFERENCE_HOST,
        standIn,
      });

      expect(observation.receivedBy).toBe("anthropic");
      expect(observation.sessionId).toBeUndefined();
      expect(standIn.received.at(-1)?.sessionMarker).toBeUndefined();
    });
  });
});
