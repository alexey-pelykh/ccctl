// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { driveLiveAskOracle } from "./live-ask-oracle.js";
import { resolveOracleEnv } from "./live-worker-oracle.js";

// The credentialed AskUserQuestion phone-surfacing gate (issue #266, #78 Option A, traces #78 AC4) — the
// last hop ADR-005's #263 spike could not reach. `@ccctl/core` records the exact epistemic status this
// gate closes: `AskUserQuestion` blocking natively under `bypassPermissions` is OBSERVED, but that the
// worker SURFACES the block as `worker_status: requires_action` over §4/§5 "is a strong INFERENCE, not
// yet observed ... which the #266 live-worker gate owns". This gate drives a REAL `bypassPermissions`
// worker with the #78 hook installed to invoke `AskUserQuestion`, and reads — from the server's OWN
// derived activity + the hook's OWN capture — whether the decision surfaces as a needs-you with
// structured options.
//
// Fenced / opt-in: the ENTIRE suite is gated on CCCTL_E2E + CCCTL_SDK_URL + ANTHROPIC_API_KEY
// (`resolveOracleEnv`, REUSED from the #133 oracle). Absent → `describe.skipIf` SKIPS the whole file, so
// it lives OUTSIDE the credential-free CI `e2e` lane and never runs, nor fails, there (the classification
// LOGIC is proven credential-free in the `test` lane by `live-ask-oracle.test.ts`). Self-classifying +
// skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL, naming the diverging leg — a
// falsified requires_action surfacing, or a malformed captured payload), or `inconclusive` (the worker
// never reached idle / never invoked AskUserQuestion — runtime-skip, never a fabricated green). #78 AC4
// stays PENDING until this goes `verified`.

const fence = resolveOracleEnv();

const ccctlServers: CcctlServer[] = [];

async function startLocalServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  ccctlServers.push(server);
  return server;
}

afterEach(async () => {
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
});

// SKIPS the whole suite when the credential-wave env is absent — the default in the hermetic CI `e2e`
// lane and in any local run without credentials. No synthetic worker is substituted to make an absent
// gate look green.
describe.skipIf(!fence.ready)("ccctl e2e: AskUserQuestion → phone surfacing — live-worker gate (#266, #78 AC4)", () => {
  describe("Rule: a real bypassPermissions worker surfaces its AskUserQuestion block as requires_action (else the #78 inference is stale)", () => {
    it("drives a real worker to invoke AskUserQuestion and the block surfaces as a needs-you with structured options", async (ctx) => {
      if (!fence.ready) {
        // Unreachable under `skipIf(!fence.ready)`; the guard narrows the fence union for the config.
        ctx.skip();
        return;
      }
      const server = await startLocalServer();

      // Drive the real patched worker (via CCCTL_SDK_URL) against the built server and self-classify.
      // driveLiveAskOracle never throws on a divergence or a missing leg — it returns a verdict — so the
      // disposition below is the ONLY place a verdict becomes a pass / fail / skip.
      const report = await driveLiveAskOracle({ server, config: fence.config });

      switch (report.verdict) {
        case "verified":
          // A real worker invoked AskUserQuestion, the #78 hook captured well-formed structured options,
          // AND the server surfaced the native block as requires_action — the #266 inference is confirmed.
          expect(report.divergentLegs).toEqual([]);
          break;
        case "drift":
          // The worker asked but the block never surfaced as requires_action (the #78 inference is
          // falsified), OR the hook captured a payload that is not well-formed structured options. FAIL the
          // credentialed run, naming the diverging leg(s).
          expect.fail(
            `AskUserQuestion surfacing DRIFT on ${report.divergentLegs.join(", ")} — the #78 phone-surfacing story does not hold against the current worker. ${report.reason}`,
          );
          break;
        case "inconclusive":
          // Couldn't observe the live surfacing (worker didn't reach idle, or the model never invoked
          // AskUserQuestion). No signal — runtime-SKIP rather than fake a green or raise a false red.
          // Symmetric with the absent-env skip on the suite above.
          ctx.skip(`AskUserQuestion gate inconclusive — ${report.reason}`);
          break;
      }
    });
  });
});
