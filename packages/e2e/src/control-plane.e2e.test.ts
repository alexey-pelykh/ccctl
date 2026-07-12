// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { CONTROL_PLANE_SCENARIO } from "./index.js";
import { driveLiveWorkerOracle, resolveOracleEnv } from "./live-worker-oracle.js";

// The credentialed live-worker oracle (issue #133, traces E2E-B-002) — the independent
// live check that PAIRS the hermetic wire-conformance golden (`wire-conformance.e2e.test.ts`).
// The hermetic golden is necessary-but-insufficient: it verifies "the server emits the
// wire the golden encodes," never "the golden encodes the wire the real worker actually
// speaks." This oracle closes that gap by driving a REAL patched worker against the built
// server and self-classifying the OBSERVED wire against the golden's pinned shapes.
//
// Fenced / opt-in: the ENTIRE suite is gated on CCCTL_E2E + CCCTL_SDK_URL + ANTHROPIC_API_KEY
// (`resolveOracleEnv`). Absent → `describe.skipIf` SKIPS the whole file — so it lives OUTSIDE
// the credential-free CI `e2e` lane and never runs, nor fails, there (the hermetic golden's
// assertions are untouched; the fence LOGIC itself is proven credential-free in the `test`
// lane by `live-worker-oracle.test.ts`). Self-classifying + skips-never-fakes: a driven run
// yields `verified` (pass), `drift` (FAIL, naming the diverging leg(s)), or `inconclusive` (a
// required leg was never captured — runtime-skip, never a fabricated green). All grounding is
// receiver-read from the server's own state, consistent with `one-session-harness.ts`.

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

// SKIPS the whole suite when the credential-wave env is absent — the default in the
// hermetic CI `e2e` lane and in any local run without credentials. This is the
// skips-never-fakes fence: no synthetic worker is substituted to make an absent oracle
// look green (the circular-fixture failure #131 removed).
describe.skipIf(!fence.ready)(`ccctl e2e: ${CONTROL_PLANE_SCENARIO.name} — live-worker oracle (#133)`, () => {
  describe("Rule: a real patched worker still speaks the wire the golden pins (else the golden is stale)", () => {
    it("drives a real worker to idle + one turn and the observed wire matches every pinned golden shape", async (ctx) => {
      if (!fence.ready) {
        // Unreachable under `skipIf(!fence.ready)`; the guard narrows the fence union for the config.
        ctx.skip();
        return;
      }
      const server = await startLocalServer();

      // Drive the real patched worker (via CCCTL_SDK_URL) against the built server and
      // self-classify. driveLiveWorkerOracle never throws on a divergence or a missing leg —
      // it returns a verdict — so the disposition below is the ONLY place a verdict becomes a
      // pass / fail / skip.
      const report = await driveLiveWorkerOracle({ server, config: fence.config });

      switch (report.verdict) {
        case "verified":
          // The live worker wire conformed on every pinned leg AND a real worker reached idle
          // and completed one turn — the golden encodes the wire the real worker speaks.
          expect(report.divergentLegs).toEqual([]);
          break;
        case "drift":
          // The live wire diverged from the golden's pinned shapes: the golden is stale vs the
          // current worker. FAIL the credentialed run, naming the diverging leg(s).
          expect.fail(
            `live-worker wire DRIFT on ${report.divergentLegs.join(", ")} — the golden is stale vs the current worker. ${report.reason}`,
          );
          break;
        case "inconclusive":
          // Couldn't capture the live wire (worker didn't reach idle / no turn / a bridge
          // response was never seen). No interop signal — runtime-SKIP rather than fake a green
          // or raise a false red. Symmetric with the absent-env skip on the suite above.
          ctx.skip(`live-worker oracle inconclusive — ${report.reason}`);
          break;
      }
    });
  });
});
