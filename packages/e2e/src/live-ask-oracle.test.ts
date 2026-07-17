// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import {
  ASK_ORACLE_LEG,
  classifyAskSurfacing,
  driveLiveAskOracle,
  enrichmentFromHookCapture,
  type LiveAskCapture,
  type PatchedWorkerLauncher,
} from "./live-ask-oracle.js";

// Unit proof of the AskUserQuestion phone-surfacing oracle's PURE core (issue #266): the tri-state
// classifier and its hook-capture shape check. These run credential-free in the normal `test` lane (no
// real worker, no `CCCTL_SDK_URL`, no `ANTHROPIC_API_KEY`) and are what make the fenced credentialed gate
// trustworthy — they prove `verified | drift | inconclusive` is decided correctly, that the two drift
// cases (a falsified requires_action surfacing, a malformed captured payload) are NAMED, and that a
// never-asked run degrades to `inconclusive` rather than a fabricated green. The live drive itself is
// exercised, fenced, in `ask-user-question-gate.e2e.test.ts`; its receiver-grounded observations feed
// this same classifier. (The fence — `resolveOracleEnv` — is proven credential-free in
// `live-worker-oracle.test.ts`, which this oracle REUSES rather than re-testing.)

// --- fixtures ---

/** A single well-formed question off ADR-005's observed `AskUserQuestion` shape — two tappable options. */
const WELL_FORMED_QUESTION = {
  question: "Proceed with the deploy?",
  header: "Deploy",
  options: [
    { label: "Proceed", description: "Ship it" },
    { label: "Cancel", description: "Hold off" },
  ],
};

/** A hook handoff body whose `{ questions }` ARE well-formed structured options (the `verified` baseline). */
function wellFormedHookCapture(): string {
  return JSON.stringify({ questions: [WELL_FORMED_QUESTION] });
}

/** A fully-live, fully-conforming capture — the `verified` baseline the negative cases perturb. */
function verifiedAskCapture(): LiveAskCapture {
  return { reachedIdle: true, reachedRequiresAction: true, hookCaptureBody: wellFormedHookCapture() };
}

describe("enrichmentFromHookCapture — the #78 hook capture is well-formed structured options (#266)", () => {
  describe("Rule: a well-formed `{ questions }` capture yields an enrichment via core's own guard", () => {
    it("parses a two-option question into an enrichment carrying that question", () => {
      const enrichment = enrichmentFromHookCapture(wellFormedHookCapture());
      expect(enrichment).not.toBeNull();
      expect(enrichment?.questions).toHaveLength(1);
      expect(enrichment?.questions[0]?.options.map((o) => o.label)).toEqual(["Proceed", "Cancel"]);
    });
  });

  describe("Rule: a malformed capture fails closed to `null` (the same core guard the server buffers through)", () => {
    it("is `null` when the body is not JSON", () => {
      expect(enrichmentFromHookCapture("not json {")).toBeNull();
    });

    it("is `null` when the body is a JSON array, not an object", () => {
      expect(enrichmentFromHookCapture(JSON.stringify([WELL_FORMED_QUESTION]))).toBeNull();
    });

    it("is `null` when there is no `questions` field", () => {
      expect(enrichmentFromHookCapture(JSON.stringify({ answers: {} }))).toBeNull();
    });

    it("is `null` when `questions` is empty (an empty set decorates nothing)", () => {
      expect(enrichmentFromHookCapture(JSON.stringify({ questions: [] }))).toBeNull();
    });

    it("is `null` when a question offers no options (untappable)", () => {
      expect(enrichmentFromHookCapture(JSON.stringify({ questions: [{ question: "P?", options: [] }] }))).toBeNull();
    });

    it("is `null` when two options share a normalized label (an ambiguous, unanswerable choice)", () => {
      const colliding = { question: "P?", options: [{ label: "Yes" }, { label: "Yes" }] };
      expect(enrichmentFromHookCapture(JSON.stringify({ questions: [colliding] }))).toBeNull();
    });
  });
});

describe("classifyAskSurfacing — the self-classifying tri-state verdict (#266)", () => {
  describe("Rule: verified — a real worker asked, the hook captured well-formed options, and the block surfaced", () => {
    it("classifies a fully-live, well-formed capture as `verified` with no diverging legs", () => {
      const report = classifyAskSurfacing(verifiedAskCapture());
      expect(report.verdict).toBe("verified");
      expect(report.divergentLegs).toEqual([]);
      expect(report.reason).toContain("confirmed");
    });
  });

  describe("Rule: drift — the worker asked but the block never surfaced as requires_action (#266 inference falsified)", () => {
    it("flags a requires_action surfacing that never happened, naming the surfacing leg and FAILING", () => {
      const report = classifyAskSurfacing({ ...verifiedAskCapture(), reachedRequiresAction: false });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ASK_ORACLE_LEG.requiresActionSurfacing]);
      expect(report.reason).toContain("falsified");
      // The reason carries the captured question COUNT — the hook fired, so we know it was a real ask.
      expect(report.reason).toContain("1 well-formed");
    });
  });

  describe("Rule: drift — the hook fired but its captured payload is not well-formed structured options", () => {
    it("flags a malformed captured payload, naming the options leg (not the surfacing leg)", () => {
      const report = classifyAskSurfacing({
        ...verifiedAskCapture(),
        hookCaptureBody: JSON.stringify({ questions: [{ question: "P?", options: [] }] }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ASK_ORACLE_LEG.hookOptions]);
    });

    it("the malformed-options drift OUTRANKS a missing surfacing — it is named FIRST", () => {
      // Both wrong: the captured payload is malformed AND requires_action never surfaced. The malformed
      // options are the definitive divergence (the hook fired against an unrenderable payload), so it is
      // reported over the surfacing leg — a present-but-broken capture is never masked.
      const report = classifyAskSurfacing({
        reachedIdle: true,
        reachedRequiresAction: false,
        hookCaptureBody: JSON.stringify({ questions: "not-an-array" }),
      });
      expect(report.verdict).toBe("drift");
      expect(report.divergentLegs).toEqual([ASK_ORACLE_LEG.hookOptions]);
    });
  });

  describe("Rule: inconclusive — a required observation is missing; SKIPS-never-fakes rather than reporting green", () => {
    it("is `inconclusive` when the worker never invoked AskUserQuestion (no hook capture)", () => {
      const report = classifyAskSurfacing({
        reachedIdle: true,
        reachedRequiresAction: false,
        hookCaptureBody: undefined,
      });
      expect(report.verdict).toBe("inconclusive");
      expect(report.divergentLegs).toEqual([]);
      expect(report.reason).toContain("never invoked AskUserQuestion");
    });

    it("is `inconclusive` (never `drift`) when the worker never reached idle", () => {
      const report = classifyAskSurfacing({
        reachedIdle: false,
        reachedRequiresAction: false,
        hookCaptureBody: undefined,
      });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("never reached idle");
    });

    it("does NOT read a missing requires_action as drift when the worker never asked (no hook capture)", () => {
      // The crux of skips-never-fakes for #266: requires_action absent is only a FALSIFIED inference when
      // the worker actually asked (hook fired). With no ask, absent surfacing is a no-signal run.
      const report = classifyAskSurfacing({ reachedIdle: true, reachedRequiresAction: false });
      expect(report.verdict).toBe("inconclusive");
    });
  });
});

// Integration regression for the "no real worker" case (hermetic: real @ccctl/server on loopback, a stub
// launcher that connects NO worker, a temp hook-state dir, no credentials). Guards that the drive brings
// up a `bypassPermissions` session over the bridge, never throws when the worker never appears, and
// self-classifies `inconclusive` — the AskUserQuestion sibling of `driveLiveWorkerOracle`'s degrade guard.
const ccctlServers: CcctlServer[] = [];
const hookDirs: string[] = [];

afterEach(async () => {
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
  while (hookDirs.length > 0) {
    rmSync(hookDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("driveLiveAskOracle — degrades to `inconclusive`, never throws, when no real worker connects (#266)", () => {
  describe("Rule: a bridge `bypassPermissions` session with no worker is `inconclusive`, not a throw or a fake green", () => {
    it("self-classifies `inconclusive` when the launched worker never opens a channel or asks", async () => {
      const server = await startServer({ port: 0, host: DEFAULT_HOST });
      ccctlServers.push(server);
      const hookStateDir = mkdtempSync(join(tmpdir(), "ccctl-ask-oracle-"));
      hookDirs.push(hookStateDir);

      // A launcher that brings up NO worker — the real-worker infra is absent. The drive runs the §1/§2/§3
      // bridge legs against the REAL server (creating a `bypassPermissions` session), then waits for a live
      // worker that never appears: `hasLiveWorker` stays false, no turn is injected, no hook fires.
      const noWorkerLauncher: PatchedWorkerLauncher = () => Promise.resolve({ close: () => Promise.resolve() });

      const report = await driveLiveAskOracle({
        server,
        config: { sdkUrl: "no-op", apiKey: "test-key" },
        launcher: noWorkerLauncher,
        liveTimeoutMs: 150, // a short budget so the absent worker is concluded quickly.
        hookStateDir,
      });

      // Not a throw (we got here), not `verified` (no real ask), not `drift` (the worker never asked, so a
      // missing surfacing is a no-signal gap, not a falsified inference) — a precise inconclusive.
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("never reached idle");
    });
  });
});
