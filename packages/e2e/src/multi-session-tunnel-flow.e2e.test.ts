// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { TailscaleTunnel } from "@ccctl/tunnel-adapters";
import { describeTunnelFence, driveMultiSessionTunnelFlow, resolveTunnelE2EEnv } from "./multi-session-tunnel.js";

// The fenced, self-classifying MULTI-SESSION-OVER-A-REAL-TAILSCALE-TUNNEL oracle (issue
// #65, traces E2E-B-001 / UC1). The hermetic multi-session flow (`multi-session-flow.e2e.test.ts`,
// #20) proves the daemon multiplexes ≥2 concurrent sessions — list + view + steer each,
// never cross-wired — but only over LOOPBACK. This graduates that skeleton to run over a
// REAL Tailscale tunnel: the phone is a remote tailnet device reaching the loopback-bound
// server THROUGH the tunnel (no public IP, no open ports).
//
// Fenced / opt-in: the ENTIRE suite is gated on CCCTL_E2E + CCCTL_E2E_TAILSCALE
// (`resolveTunnelE2EEnv`). Absent → `describe.skipIf` SKIPS the whole file — so it lives
// OUTSIDE the credential-free CI `e2e` lane and never runs, nor fails, there (the fence +
// classifier LOGIC is proven credential-free in the `test` lane by `multi-session-tunnel.test.ts`).
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift`
// (FAIL, naming the violated checks) or `inconclusive` (a leg was never captured — e.g. no
// real tailnet — runtime-skip, never a fabricated green). All grounding is receiver-read
// from the server's own state, each worker's own inbound frames, and each phone's own
// over-tunnel SSE log, consistent with the hermetic harnesses.

const ACCOUNT_BEARER = "oauth-account-secret-tunnel-e2e";

const fence = resolveTunnelE2EEnv();

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

// SKIPS the whole suite when the real-tunnel env is absent — the default in the hermetic
// CI `e2e` lane and in any local run without a tailnet. This is the skips-never-fakes
// fence: no synthetic tunnel or loopback stand-in is substituted to make an absent tailnet
// look green.
describe.skipIf(!fence.ready)(
  `ccctl e2e: multi-session over a REAL Tailscale tunnel (#65) — ${describeTunnelFence(fence)}`,
  () => {
    describe("Rule: UC1 carries ≥2 sessions and the phone lists / views / steers each OVER the tunnel", () => {
      it("verifies list + view + steer of ≥2 sessions over a real tailnet, no cross-wiring, no public surface (AC1+2+3)", async (ctx) => {
        const server = await startLocalServer();

        // Drive the real tunnel flow with a real TailscaleTunnel (default CommandRunner → real
        // `tailscale` binary). driveMultiSessionTunnelFlow NEVER throws on a divergence or a
        // missing leg — it returns a verdict — so the disposition below is the ONLY place a
        // verdict becomes a pass / fail / skip.
        const report = await driveMultiSessionTunnelFlow({
          server,
          tunnel: new TailscaleTunnel(),
          bearer: ACCOUNT_BEARER,
          sessionCount: 2,
        });

        switch (report.verdict) {
          case "verified":
            // ≥2 sessions carried; the phone listed all with per-session status and viewed +
            // steered each OVER the tunnel, no cross-wiring, over a tailnet-scoped base.
            expect(report.violations).toEqual([]);
            break;
          case "drift":
            // The flow ran but violated a contract over the tunnel (cross-wiring, a public
            // base, or a wrong list). FAIL the fenced run, naming the violated check(s).
            expect.fail(`multi-session tunnel flow DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
            break;
          case "inconclusive":
            // Couldn't capture the full flow over a real tunnel (no tailnet / an unreachable
            // base / a leg never observed). No signal — runtime-SKIP rather than fake a green
            // or raise a false red. Symmetric with the absent-env skip on the suite above.
            ctx.skip(`multi-session tunnel flow inconclusive — ${report.reason}`);
            break;
        }
      });
    });
  },
);
