// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import {
  classifyObservedWire,
  describeFence,
  driveLiveWorkerOracle,
  ORACLE_ENV_VARS,
  ORACLE_LEG,
  resolveOracleEnv,
  type LiveCapture,
  type PatchedWorkerLauncher,
} from "./live-worker-oracle.js";

// Unit proof of the live-worker oracle's PURE core (issue #133): the env fence and the
// tri-state wire classifier. These run credential-free in the normal `test` lane (no
// server, no worker) and are what makes the fenced credentialed e2e suite trustworthy —
// they prove the fence gates on all three vars and that classification yields exactly
// `verified | drift | inconclusive`, naming the diverging leg(s) on drift and never
// faking green on a missing leg. The live drive itself is exercised, fenced, in
// `control-plane.e2e.test.ts`; its receiver-grounded observations feed this same classifier.

// --- fixtures: bodies that DO conform to the pinned golden shapes ---

/** A conforming §3 work-poll body — a single `{ id, secret, data }` whose secret decodes with both inner fields. */
function conformingWorkPollBody(sessionId = "sess-1"): string {
  const secret = Buffer.from(
    JSON.stringify({ version: 1, session_ingress_token: "ingress-tok", api_base_url: "http://127.0.0.1:1" }),
  ).toString("base64url");
  return JSON.stringify({ id: "work-1", secret, data: { type: "session", id: sessionId } });
}

/** A fully-conforming, fully-live capture — the `verified` baseline the negative cases perturb. */
function verifiedCapture(): LiveCapture {
  return {
    registerBody: JSON.stringify({ environment_id: "env-1" }),
    registerStatus: 200,
    sessionCreateBody: JSON.stringify({ session_id: "sess-1" }),
    workPollBody: conformingWorkPollBody(),
    workerRegistered: true,
    reachedIdle: true,
    turnObserved: true,
  };
}

describe("resolveOracleEnv — the credentialed oracle fence (#133)", () => {
  describe("Rule: READY only when all three credential-wave env vars are present", () => {
    it("resolves READY with the config when CCCTL_E2E + CCCTL_SDK_URL + ANTHROPIC_API_KEY are all set", () => {
      const fence = resolveOracleEnv({
        CCCTL_E2E: "1",
        CCCTL_SDK_URL: "claude-code-patched",
        ANTHROPIC_API_KEY: "sk-ant-xxx",
      });

      expect(fence.ready).toBe(true);
      // The config carries the two live handles; the fence gate itself does not interpret them.
      expect(fence).toMatchObject({ ready: true, config: { sdkUrl: "claude-code-patched", apiKey: "sk-ant-xxx" } });
    });

    it("exposes exactly the three fence vars via ORACLE_ENV_VARS", () => {
      expect([...ORACLE_ENV_VARS]).toEqual(["CCCTL_E2E", "CCCTL_SDK_URL", "ANTHROPIC_API_KEY"]);
    });
  });

  describe("Rule: an absent or empty var fences the oracle off, naming every missing var", () => {
    it("is NOT ready and names CCCTL_E2E when it is unset", () => {
      const fence = resolveOracleEnv({ CCCTL_SDK_URL: "x", ANTHROPIC_API_KEY: "y" });
      expect(fence).toEqual({ ready: false, missing: ["CCCTL_E2E"] });
    });

    it("treats CCCTL_E2E=0 / false / '' as OFF (not merely presence)", () => {
      for (const off of ["0", "false", "", "  ", "no"]) {
        const fence = resolveOracleEnv({ CCCTL_E2E: off, CCCTL_SDK_URL: "x", ANTHROPIC_API_KEY: "y" });
        expect(fence.ready).toBe(false);
      }
    });

    it("names an empty CCCTL_SDK_URL as missing", () => {
      const fence = resolveOracleEnv({ CCCTL_E2E: "1", CCCTL_SDK_URL: "", ANTHROPIC_API_KEY: "y" });
      expect(fence).toEqual({ ready: false, missing: ["CCCTL_SDK_URL"] });
    });

    it("names an absent ANTHROPIC_API_KEY as missing", () => {
      const fence = resolveOracleEnv({ CCCTL_E2E: "1", CCCTL_SDK_URL: "x" });
      expect(fence).toEqual({ ready: false, missing: ["ANTHROPIC_API_KEY"] });
    });

    it("names ALL missing vars when several are absent (the credential-free CI lane)", () => {
      const fence = resolveOracleEnv({});
      expect(fence).toEqual({ ready: false, missing: ["CCCTL_E2E", "CCCTL_SDK_URL", "ANTHROPIC_API_KEY"] });
      expect(describeFence(fence)).toContain("fenced off");
      expect(describeFence(fence)).toContain("ANTHROPIC_API_KEY");
    });
  });
});

describe("classifyObservedWire — the self-classifying tri-state verdict (#133)", () => {
  describe("Rule: verified — every captured body matches the pinned golden shape and the real worker completed the flow", () => {
    it("classifies a fully-conforming, fully-live capture as `verified` with no diverging legs", () => {
      const report = classifyObservedWire(verifiedCapture());
      expect(report.verdict).toBe("verified");
      expect(report.divergentLegs).toEqual([]);
    });
  });

  describe("Rule: drift — a captured body diverges from the pinned golden shape; the leg is named and the run fails", () => {
    it("flags a §1 register camelCase leak (the pinned shape is snake_case environment_id)", () => {
      const report = classifyObservedWire({
        ...verifiedCapture(),
        registerBody: JSON.stringify({ environmentId: "e" }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.register]);
    });

    it("flags a §1 register STATUS drift — a 201 (the pre-#154 status the worker rejects) with a CONFORMING body (#155)", () => {
      // The exact "assert the 200 status, not just the body" gap: a server that emits the
      // pinned { environment_id } body but under the pre-#154 201 must still drift.
      const report = classifyObservedWire({
        ...verifiedCapture(),
        registerStatus: 201,
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.register]);
      expect(report.reason).toContain("expected status 200, got 201");
    });

    it("flags a §2 resurrected ws_url (the SSE control path never reads one, #130)", () => {
      const report = classifyObservedWire({
        ...verifiedCapture(),
        sessionCreateBody: JSON.stringify({ session_id: "s", ws_url: "ws://x" }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.sessionCreate]);
    });

    it("flags a §3 `{ work: [...] }` envelope (the observed poll returns a single item, #130)", () => {
      const report = classifyObservedWire({
        ...verifiedCapture(),
        workPollBody: JSON.stringify({ work: [{ id: "w", secret: "s", data: { type: "session", id: "s" } }] }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.workPoll]);
    });

    it("flags a §3 work-secret missing an inner field (both are load-bearing, #130)", () => {
      const brokenSecret = Buffer.from(JSON.stringify({ version: 1, api_base_url: "http://x" })).toString("base64url");
      const report = classifyObservedWire({
        ...verifiedCapture(),
        workPollBody: JSON.stringify({ id: "w", secret: brokenSecret, data: { type: "session", id: "s" } }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.workPoll]);
    });

    it("names EVERY diverging leg when more than one drifted, with the shape error in the reason", () => {
      const report = classifyObservedWire({
        ...verifiedCapture(),
        registerBody: JSON.stringify({ environmentId: "e" }),
        sessionCreateBody: JSON.stringify({ session_id: "s", ws_url: "ws://x" }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.register, ORACLE_LEG.sessionCreate]);
      expect(report.reason).toContain("ccctl e2e"); // the golden's own leg-tagged shape error rides along
    });
  });

  describe("Rule: inconclusive — a required leg was never observed; the oracle SKIPS-never-fakes rather than reporting green", () => {
    it("is `inconclusive` (never `verified`) when a bridge response was never captured", () => {
      const report = classifyObservedWire({ ...verifiedCapture(), workPollBody: undefined });
      expect(report.verdict).toBe("inconclusive");
      expect(report.divergentLegs).toEqual([]);
      expect(report.reason).toContain(ORACLE_LEG.workPoll);
    });

    it("is `inconclusive` when the real worker never reached idle", () => {
      const report = classifyObservedWire({ ...verifiedCapture(), reachedIdle: false });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("never reached idle");
    });

    it("is `inconclusive` when no turn completed", () => {
      const report = classifyObservedWire({ ...verifiedCapture(), turnObserved: false });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("no turn completed");
    });

    it("is `inconclusive` when the worker never opened the channel", () => {
      const report = classifyObservedWire({ ...verifiedCapture(), workerRegistered: false });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(ORACLE_LEG.workerChannel);
    });
  });

  describe("Rule: drift OUTRANKS inconclusive — a present-but-divergent leg is definitive, never masked by a missing one", () => {
    it("reports `drift` when a body diverged AND the worker never reached idle", () => {
      const report = classifyObservedWire({
        ...verifiedCapture(),
        registerBody: JSON.stringify({ environmentId: "e" }),
        reachedIdle: false,
        turnObserved: false,
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ORACLE_LEG.register]);
    });
  });
});

// Integration regression for the "no real worker" case (hermetic: real @ccctl/server on
// loopback, a stub launcher that connects NO worker, no credentials). This is the direct
// guard for the bug where the drive injected a turn off the session's creation-default
// `idle` and THREW `no live worker channel` instead of self-classifying `inconclusive`.
const ccctlServers: CcctlServer[] = [];

afterEach(async () => {
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
});

describe("driveLiveWorkerOracle — degrades to `inconclusive`, never throws, when no real worker connects (#133)", () => {
  describe("Rule: a session's creation-default `idle` must NOT read as a live worker (skips-never-fakes)", () => {
    it("self-classifies `inconclusive` (not a throw, not `verified`) when the launched worker never opens a channel", async () => {
      const server = await startServer({ port: 0, host: DEFAULT_HOST });
      ccctlServers.push(server);

      // A launcher that brings up NO worker — the real-worker infra is absent. The drive
      // runs the §1/§2/§3 bridge legs against the REAL server (they conform), then waits for
      // a live worker that never appears: `hasLiveWorker` stays false, so the drive must NOT
      // inject a turn off the session's default `idle`, and must return `inconclusive`.
      const noWorkerLauncher: PatchedWorkerLauncher = () => Promise.resolve({ close: () => Promise.resolve() });

      const report = await driveLiveWorkerOracle({
        server,
        config: { sdkUrl: "no-op", apiKey: "test-key" },
        launcher: noWorkerLauncher,
        liveTimeoutMs: 150, // a short budget so the absent worker is concluded quickly.
      });

      // Not a throw (we got here), not `verified` (no real turn), not `drift` (the real
      // server's bridge wire conforms) — a precise inconclusive naming the missing worker.
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("never opened the");
      // The real worker channel was never live (the fix's load-bearing distinction).
      expect(server.hasLiveWorker([...server.sessions.keys()][0] ?? "none")).toBe(false);
    });
  });
});
