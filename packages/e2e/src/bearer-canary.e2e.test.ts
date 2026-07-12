// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { assertBearerNeverObserved } from "./bearer-canary.js";
import { driveOneSessionFlow, type OneSessionFlow } from "./one-session-harness.js";
import { startInferenceStandIn, type InferenceStandIn } from "./traffic-harness.js";

// Runtime canary for the account-Bearer non-persisting pass-through (issue #60). The
// account OAuth Bearer rides §1/§2 ONLY and must be validated for receipt then
// dropped — NEVER logged, persisted, or replayed. `@ccctl/core` proves that at the
// type level (a leak into a JSON shape is a compile error); this proves it
// OBSERVATIONALLY: drive the REAL @ccctl/server through a full one-session lifecycle
// presenting a DISTINCTIVE Bearer, collect every log line the run produced AND the
// server's OWN persisted-state snapshot, and assert the literal Bearer appears in
// NEITHER. Receiver-grounded per docs/security-posture.md — the snapshot is read from
// the server's own state maps and the logs are the output actually produced, never a
// sender's self-report (a posture that must not be weakened in a refactor).
//
// The server produces no logs today, so the log half is a FORWARD regression
// tripwire: it goes red the day an edit logs the Bearer (e.g. a debug console.log of
// request headers). The assertion's armed / non-vacuous property — that it DOES throw
// when the Bearer is present — is proven (with message pinning) in the unit suite
// `bearer-canary.test.ts`. A real Bearer leak cannot be driven here (the type system
// forbids it — that IS the guarantee), so this e2e's job is only the positive
// observational proof; its pass is grounded non-vacuous by asserting the log capture
// is live and the snapshot is populated real state.

const CANARY_BEARER = "ccctl-account-bearer-CANARY-never-log-8f3a1c2e";

// The console methods a Node process logs through — the surface any future
// server-side leak would use. Spied (pass-through), so produced output is both
// collected and still emitted.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Serialize one console argument to the text a grep would see, JSON-expanding objects (so a nested Bearer is caught, not flattened to "[object Object]"). */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Run `body` while capturing everything logged through the console, returning the joined log text plus `body`'s result. */
async function collectProducedLogs<T>(body: () => Promise<T>): Promise<{ logs: string; result: T }> {
  const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
  const result = await body();
  const logs = spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map(stringifyArg).join(" "))
    .join("\n");
  spies.forEach((spy) => {
    spy.mockRestore();
  });
  return { logs, result };
}

/** The server's persisted-state snapshot: its OWN session + environment state, serialized. */
function persistedSnapshot(server: CcctlServer): string {
  return JSON.stringify({
    sessions: [...server.sessions.values()],
    environments: [...server.environments.values()],
  });
}

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

// Close each flow's stand-in phone + worker FIRST, then the servers and stand-ins, so
// no client write races a closing server and no listener leaks across the serial e2e
// run. `restoreAllMocks` is a safety net in case a spied lifecycle threw before its
// own restore.
afterEach(async () => {
  vi.restoreAllMocks();
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

describe("ccctl e2e: account Bearer is a non-persisting pass-through — runtime canary (#60)", () => {
  describe("Rule: a runtime canary proves the boundary observationally", () => {
    it("finds the Bearer in neither produced logs nor the persisted snapshot across a full session lifecycle", async () => {
      const server = await startLocalServer();
      const standIn = await startAnthropicStandIn();

      // A distinctive marker so a hit is unambiguously the presented Bearer, not
      // incidental test/harness noise.
      const PROBE = "canary-capture-liveness-probe";
      const { logs, result: flow } = await collectProducedLogs(async () => {
        // Prove the capture channel is live — guards against a silently-broken spy
        // turning the log grep into a vacuous pass.
        console.log(PROBE);
        return driveOneSessionFlow({ server, bearer: CANARY_BEARER, standIn });
      });
      flows.push(flow);

      const snapshot = persistedSnapshot(server);

      // Ground the observation is NON-degenerate: the Bearer really rode a full,
      // completed lifecycle (§1/§2 accepted it → the environment + session exist), the
      // snapshot is populated real state (not an empty subject that passes vacuously),
      // and the log capture is live.
      expect(server.environments.size).toBe(1);
      expect(server.sessions.size).toBe(1);
      expect(snapshot).toContain(flow.sessionId);
      expect(logs).toContain(PROBE);
      // ...and nothing crossed to the api.anthropic.com stand-in during the flow.
      expect(standIn.received).toHaveLength(0);

      // The canary: feed the real collected logs + persisted snapshot to the shared
      // verdict — the literal account Bearer is in NEITHER.
      expect(() => assertBearerNeverObserved({ bearer: CANARY_BEARER, logs, snapshot })).not.toThrow();
    });
  });
});
