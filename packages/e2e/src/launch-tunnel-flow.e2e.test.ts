// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { TailscaleTunnel } from "@ccctl/tunnel-adapters";
// The REAL browser module the phone's "New session" control uses (#37) — the phone leg must be the
// phone's OWN code, never a re-transcription of its body. It lives HERE, in the test file, because
// `@ccctl/web-ui` is dependency-free plain JS with no type declarations and `tsconfig.json` excludes
// test files from `typecheck` — the same placement every other web-ui call site in this package uses
// (`one-session-flow.e2e.test.ts`, `web-ui-launch-flow.test.ts`). The oracle takes it as an injected
// `LaunchRequestBuilder` rather than importing it into typechecked source.
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import {
  createRecordingLauncher,
  driveLaunchTunnelFlow,
  LAUNCH_INITIAL_PROMPT,
  LAUNCH_PROJECT,
  LAUNCH_REGISTRATION_TIMEOUT_MS,
  type RecordingLauncher,
} from "./launch-tunnel.js";
import { describeTunnelFence, resolveTunnelE2EEnv } from "./multi-session-tunnel.js";

// The fenced, self-classifying LAUNCH-FROM-THE-PHONE-OVER-A-REAL-TAILSCALE-TUNNEL oracle (issue #66,
// traces E2E-B-001 / UC2). UC1 (`multi-session-tunnel-flow.e2e.test.ts`, #65) proves the phone can
// list / view / steer sessions that ALREADY EXIST over a real tunnel; this drives the verb that brings
// one INTO BEING from the phone — `POST /api/sessions` over the tunnel — and then the whole lifecycle
// that follows it: listed from birth as `registering`, claimed by its own worker's registration (the
// row advancing IN PLACE, same id), and finally viewed + steered over the tunnel.
//
// Fenced / opt-in: the ENTIRE suite is gated on CCCTL_E2E + CCCTL_E2E_TAILSCALE (`resolveTunnelE2EEnv`,
// reused from the UC1 oracle — the infra prerequisite is the same single real tailnet). Absent →
// `describe.skipIf` SKIPS the whole file, so it lives OUTSIDE the credential-free CI `e2e` lane and
// never runs, nor fails, there. The fence + classifier LOGIC — the Tier-A encoding of UC2's three ACs
// — is proven credential-free in the `test` lane by `launch-tunnel.test.ts`, so what is fenced here is
// the TRANSPORT, not the judgment.
//
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL, naming
// the violated checks) or `inconclusive` (a leg was never captured — e.g. no real tailnet —
// runtime-skip, never a fabricated green). All grounding is receiver-read: the daemon's own 201, its
// own launcher's invocation record, its own over-tunnel list, the id its own §2 leg answered, the
// worker's own inbound frames, and the phone's own over-tunnel SSE log.

const ACCOUNT_BEARER = "oauth-account-secret-launch-tunnel-e2e";

const fence = resolveTunnelE2EEnv();

const ccctlServers: CcctlServer[] = [];

/**
 * A real local server wired with the recording launcher stand-in — the injected TERMINAL BACKEND
 * (`launch-tunnel.ts` § createRecordingLauncher explains why it must be a stand-in: the repo ships no
 * packaged patched worker, so a real tmux window would run nothing that could ever register and AC2
 * would be unreachable). Everything the ACs are actually about — the launch ingress, the
 * pending-launch bookkeeping, the §2 claim correlation, the registry, the SSE relay — is REAL.
 *
 * `registrationTimeoutMs` is raised well above the daemon's 10s product default so a slow tailnet
 * cannot evict the pending launch mid-drive and manufacture a false `drift` (see
 * LAUNCH_REGISTRATION_TIMEOUT_MS).
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
// lane and in any local run without a tailnet. This is the skips-never-fakes fence: no synthetic
// tunnel or loopback stand-in is substituted to make an absent tailnet look green.
describe.skipIf(!fence.ready)(
  `ccctl e2e: launch a session from the phone over a REAL Tailscale tunnel (#66) — ${describeTunnelFence(fence)}`,
  () => {
    describe("Rule: UC2 launches a session FROM THE PHONE over the tunnel, and it registers, lists from birth, and is viewable/steerable", () => {
      it("verifies the whole launch lifecycle over a real tailnet, with no public surface (AC1+2+3)", async (ctx) => {
        const recorder = createRecordingLauncher();
        const server = await startLocalServer(recorder);

        // Drive the real tunnel flow with a real TailscaleTunnel (default CommandRunner → real
        // `tailscale` binary). driveLaunchTunnelFlow NEVER throws on a divergence or a missing leg —
        // it returns a verdict — so the disposition below is the ONLY place a verdict becomes a
        // pass / fail / skip.
        const report = await driveLaunchTunnelFlow({
          server,
          tunnel: new TailscaleTunnel(),
          bearer: ACCOUNT_BEARER,
          recorder,
          // The phone's own body, built by the REAL browser module for the drive's freshly-minted
          // canonical cwd — seeded with a project + prompt so a daemon that dropped either is visible.
          buildLaunchRequest: (cwd) =>
            launchRequest({ cwd, project: LAUNCH_PROJECT, initialPrompt: LAUNCH_INITIAL_PROMPT }),
        });

        switch (report.verdict) {
          case "verified":
            // The phone launched over the tunnel and the daemon ran exactly that request; the session
            // was listed from birth as `registering`; its worker's registration claimed it (same id,
            // row advanced, no second row); and the phone viewed + steered it over the tunnel.
            expect(report.violations).toEqual([]);
            break;
          case "drift":
            // The flow ran but violated a contract over the tunnel (a public base, a launch that
            // wasn't the phone's, a session missing from birth, or a launch its own worker's
            // registration never claimed). FAIL the fenced run, naming the violated check(s).
            expect.fail(`UC2 launch tunnel flow DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
            break;
          case "inconclusive":
            // Couldn't capture the full flow over a real tunnel (no tailnet / an unreachable base / a
            // leg never observed). No signal — runtime-SKIP rather than fake a green or raise a false
            // red. Symmetric with the absent-env skip on the suite above.
            ctx.skip(`UC2 launch tunnel flow inconclusive — ${report.reason}`);
            break;
        }
      });
    });
  },
);
