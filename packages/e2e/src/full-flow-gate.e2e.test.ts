// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { TailscaleTunnel } from "@ccctl/tunnel-adapters";
// The REAL browser module the phone's "New session" control uses (#37) — the launch leg must be
// the phone's OWN code, never a re-transcription of its body. It lives HERE, in the test file,
// because `@ccctl/web-ui` is dependency-free plain JS with no type declarations and
// `tsconfig.json` excludes test files from `typecheck` — the same placement every other web-ui
// call site in this package uses.
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import { driveFullFlowGate } from "./full-flow-gate.js";
import { ANTHROPIC_INFERENCE_HOST } from "./index.js";
import {
  createRecordingLauncher,
  LAUNCH_INITIAL_PROMPT,
  LAUNCH_PROJECT,
  LAUNCH_REGISTRATION_TIMEOUT_MS,
  type RecordingLauncher,
} from "./launch-tunnel.js";
import { describeTunnelFence, resolveTunnelE2EEnv } from "./multi-session-tunnel.js";

// The fenced, self-classifying FULL-FLOW RELEASE GATE (issue #67, traces E2E-B-002) — the hard
// gate `docs/security-posture.md` names before any real-worker rollout.
//
// The hermetic skeleton (#18) proves the AC-5 split for ONE session over loopback. This runs the
// same guarantee inside the flow a release actually ships: two concurrent sessions PLUS one
// launched from the phone, multiplexed through one daemon, over a REAL tunnel — and asserts it
// PER SESSION. That is the claim the skeleton cannot make: an aggregate "inference reached
// Anthropic" stays green while one session is quietly proxied through the local control plane,
// because its siblings' honest traffic answers for it.
//
// Fenced / opt-in: the ENTIRE suite is gated on CCCTL_E2E + CCCTL_E2E_TAILSCALE
// (`resolveTunnelE2EEnv`, REUSED from #65 — the infra prerequisite is the same single real
// tailnet). Absent → `describe.skipIf` SKIPS the whole file, so it lives OUTSIDE the
// credential-free CI `e2e` lane and never runs, nor fails, there. The JUDGMENT — the classifier
// and the per-session assertion — is proven credential-free in the `test` lane by
// `full-flow-gate.test.ts` + `inference-guarantee.test.ts`, and the composition itself is proven
// hermetically by `full-flow-inference.test.ts`; what is fenced here is the TRANSPORT.
//
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL,
// naming the violated checks) or `inconclusive` (a leg was never captured — runtime-skip, never a
// fabricated green). Every "session X's inference reached api.anthropic.com" is receiver-read from
// the stand-in's own log, never a sender's self-report — the oracle-independence property
// `docs/security-posture.md` names as do-not-weaken.

const ACCOUNT_BEARER = "oauth-account-secret-full-flow-e2e";

/** UC1's floor: the gate must carry ≥2 concurrent sessions alongside the launched one. */
const CONCURRENT_SESSIONS = 2;

const fence = resolveTunnelE2EEnv();

const ccctlServers: CcctlServer[] = [];

/**
 * A real local server wired with the recording launcher stand-in — the injected TERMINAL BACKEND
 * (`launch-tunnel.ts` § createRecordingLauncher explains why it must be a stand-in: the repo
 * ships no packaged patched worker, so a real tmux window would run nothing that could ever
 * register). `registrationTimeoutMs` is raised well above the daemon's product default so a slow
 * tailnet cannot evict the pending launch mid-drive and manufacture a false verdict.
 */
async function startLocalServer(recorder: RecordingLauncher): Promise<CcctlServer> {
  const server = await startServer({
    port: 0,
    host: DEFAULT_HOST,
    launcher: recorder.launcher,
    registrationTimeoutMs: LAUNCH_REGISTRATION_TIMEOUT_MS,
  });
  ccctlServers.push(server);
  return server;
}

afterEach(async () => {
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
});

// SKIPS the whole suite when the real-tunnel env is absent — the default in the hermetic CI `e2e`
// lane and in any local run without a tailnet. No synthetic tunnel is substituted to make an
// absent tailnet look green.
describe.skipIf(!fence.ready)(
  `ccctl e2e: the AC-5 inference-untouched assertion inside the full-flow release gate (#67) — ${describeTunnelFence(fence)}`,
  () => {
    describe("Rule: the inference-untouched assertion runs as part of the full-flow gate (AC-1/2/3)", () => {
      it("verifies that EVERY session's inference reaches api.anthropic.com across the full flow", async (ctx) => {
        const recorder = createRecordingLauncher();
        const server = await startLocalServer(recorder);

        // driveFullFlowGate NEVER throws on a divergence or a missing leg — it returns a verdict
        // — so the disposition below is the ONLY place a verdict becomes a pass / fail / skip.
        const report = await driveFullFlowGate({
          server,
          tunnel: new TailscaleTunnel(),
          bearer: ACCOUNT_BEARER,
          concurrentSessions: CONCURRENT_SESSIONS,
          inferenceHost: ANTHROPIC_INFERENCE_HOST,
          // The phone's own body, built by the REAL browser module for the drive's freshly-minted
          // canonical cwd.
          buildLaunchRequest: (cwd) =>
            launchRequest({ cwd, project: LAUNCH_PROJECT, initialPrompt: LAUNCH_INITIAL_PROMPT }),
        });

        switch (report.verdict) {
          case "verified":
            // ≥2 concurrent sessions plus a phone-launched one were carried over the tunnel, the
            // phone drove list / view / steer across them, and every one of their inference turns
            // was observed reaching api.anthropic.com.
            expect(report.violations).toEqual([]);
            // AC-1's receipt: the assertion ran across the flow's OWN sessions — all three of
            // them — rather than beside the flow as an optional check.
            expect(report.assertedSessionIds).toHaveLength(CONCURRENT_SESSIONS + 1);
            break;
          case "drift":
            // The flow ran but violated the guarantee (a session's inference reached the local
            // server, a session's inference was never seen reaching Anthropic, or the base was
            // public). FAIL the release, naming the violated check(s).
            expect.fail(`full-flow gate DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
            break;
          case "inconclusive":
            // Couldn't capture the full flow over a real tunnel (no tailnet / an unreachable base
            // / a leg never observed). No signal — runtime-SKIP rather than fake a green or raise
            // a false red. Symmetric with the absent-env skip on the suite above.
            ctx.skip(`full-flow gate inconclusive — ${report.reason}`);
            break;
        }
      });
    });
  },
);
