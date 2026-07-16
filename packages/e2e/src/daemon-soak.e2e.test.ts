// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type CcctlServer } from "@ccctl/server";
// The REAL browser modules the phone's "New session" (#37) and "Stop" (#76) controls use — the launch
// and stop legs must be the phone's OWN code, never a re-transcription of their bodies. They live HERE,
// in the test file, because `@ccctl/web-ui` is dependency-free plain JS with no type declarations and
// `tsconfig.json` excludes test files from `typecheck` — the same placement every other web-ui call site
// in this package uses. The oracle takes them as injected builders rather than importing them into
// typechecked source.
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import { sessionStopPath, stopRequest } from "@ccctl/web-ui/src/stop.js";
import { registerEnvironment } from "./bridge-wire-conformance.js";
import { LAUNCH_REGISTRATION_TIMEOUT_MS } from "./launch-tunnel.js";
import {
  createSoakLauncher,
  createSoakLifecycle,
  describeSoakFence,
  describeSoakPlan,
  driveDaemonSoak,
  resolveSoakE2EEnv,
  resolveSoakPlan,
  SOAK_SETTLE_TIMEOUT_MS,
  SOAK_WARMUP_CYCLES,
  type SoakPlan,
} from "./daemon-soak.js";

// The fenced, self-classifying LONG-RUN DAEMON SOAK oracle (issue #69, traces E2E-B-003).
//
// What it proves that nothing else does: every other oracle in this package asks about ONE pass, and a
// leak of one handle per session lifecycle passes all of them — one pass leaks one handle, nothing
// notices, every assertion is green. It is visible only as an ACCUMULATION. So this keeps ONE daemon up
// (`close()` is never called on it — that is #68's whole-daemon teardown, a different claim), runs
// session lifecycles against it through its own ingress, and reads #63's FD/handle diagnostics between
// cycles: the count must come back to baseline, and must not climb.
//
// Fenced / opt-in on its OWN arm: CCCTL_E2E + CCCTL_E2E_SOAK (`resolveSoakE2EEnv`) — and the
// prerequisite is TIME, not infrastructure, which puts this fence somewhere different from every
// sibling's. #65/#66/#67 need a tailnet, #68 a spawn-capable node-pty, #133 an API key — things a CI box
// does not HAVE, so their whole judgment is fenced. A soak needs only hours. So what is fenced here is
// the SPAN alone: the compressed soak against a REAL daemon, the negative control, the classifier, and
// even the drive's own mechanics all run credential-free in the `test` lane
// (`daemon-soak-lifecycle.test.ts` + `daemon-soak.test.ts`). This file only spends longer.
//
// To soak for the multiple days AC1 names, raise the plan (turbo passes both through to `test:e2e`):
//
//   CCCTL_E2E=1 CCCTL_E2E_SOAK=1 \
//   CCCTL_E2E_SOAK_CYCLES=2000 CCCTL_E2E_SOAK_DURATION_MS=172800000 \
//   pnpm --filter @ccctl/e2e test:e2e
//
// Armed with no plan, the defaults run a real but compressed soak in seconds — and the verdict SAYS so
// (`spannedMultiDay: false`, and the reason names the span it achieved), so a cheap run can never be
// read as the multi-day claim it did not buy.
//
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL, naming the
// violated checks) or `inconclusive` (a lifecycle could not complete, or the soak was cut short —
// runtime-skip, never a fabricated green).

const fence = resolveSoakE2EEnv();
const plan = resolveSoakPlan();

const ACCOUNT_BEARER = "oauth-account-secret-daemon-soak-e2e";

/** The logical project + seed prompt the phone's launch carries — so a daemon that dropped either is visible. */
const SOAK_PROJECT = "ccctl-e2e-daemon-soak";
const SOAK_INITIAL_PROMPT = "ccctl e2e: seed prompt for the long-run daemon soak";

const started: CcctlServer[] = [];
const tempDirs: string[] = [];

/**
 * The spec's timeout for a given plan: the whole declared span, plus the settling the readings can pay
 * in the worst case, plus a generous fixed margin.
 *
 * It must be COMPUTED rather than a constant, because the plan is the operator's and a multi-day one
 * would otherwise be killed by the e2e lane's 120s default long before it could answer — the soak would
 * fail as a timeout rather than report a verdict, and the arm would be unusable for the exact run AC1
 * asks for.
 *
 * The settle budget is one {@link SOAK_SETTLE_TIMEOUT_MS} per READING — the baseline's plus one per
 * measured cycle. The warmup runs lifecycles but takes no reading, so its cycles are budgeted here only
 * as headroom for their own duration, alongside the fixed margin. Every term is a worst case a healthy
 * run never approaches: a settled reading converges in milliseconds.
 */
function timeoutFor(soak: SoakPlan): number {
  const settling = (soak.cycles + 1 + SOAK_WARMUP_CYCLES) * SOAK_SETTLE_TIMEOUT_MS;
  return soak.durationMs + settling + 60_000;
}

/**
 * ONE canonical directory for the whole soak, reused by every cycle — deliberately NOT one per cycle.
 * `daemon-soak-lifecycle.test.ts` § `canonicalCwd` is the ONE canonical account of why (a soak measures
 * what the PROCESS holds, so a harness that minted a dir per cycle would become the thing under test);
 * deliberately not restated here, because a restated copy is what drifts.
 */
async function canonicalCwd(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-soak-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Unlike #68's, this drive never closes the daemon — the long-running daemon is the SUBJECT, not the
  // thing under teardown — so the server is still up here on every path, and this is its real cleanup
  // rather than a safety net.
  while (started.length > 0) {
    await started
      .pop()
      ?.close()
      .catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() ?? "", { recursive: true, force: true }).catch(() => undefined);
  }
});

// SKIPS the whole suite when the arm is absent — the default on CI and on any box that has not opted in
// to spending the time. Nothing is faked to fill the gap: the compressed soak in the `test` lane is the
// credential-free proof, and this is the same oracle given longer.
describe.skipIf(!fence.ready)(`ccctl e2e: the long-run daemon soak (#69) — ${describeSoakFence(fence)}`, () => {
  describe("Rule: a long-running daemon returns its FD/handle count to baseline after every session lifecycle", () => {
    it(
      `soaks ${describeSoakPlan(plan)} with no slow leak (AC1+AC2)`,
      async (ctx) => {
        const backend = createSoakLauncher();
        // The LONG-RUNNING subject: one daemon, up for the whole soak. Sessions come and go against it.
        const server = await startServer({
          port: 0,
          launcher: backend.launcher,
          // Keeps the ghost-reaper (#33) from tearing a session down before the soak's own stop does —
          // the teardown under measurement must be the one the soak drove. The same confound #68 pins,
          // for the same reason. Only the launch→stop window must fit inside it (the pacing sleep
          // happens after the stop, when there is no pending launch left to evict), so one window
          // suffices however long the soak runs.
          registrationTimeoutMs: LAUNCH_REGISTRATION_TIMEOUT_MS,
        });
        started.push(server);
        const cwd = await canonicalCwd();
        // The environment is per-DAEMON, not per-session: registered once, outside the cycle, so the
        // soak does not accumulate environments it never meant to test.
        await registerEnvironment(server, ACCOUNT_BEARER);

        // driveDaemonSoak NEVER throws on a divergence or a missing leg — it returns a verdict — so the
        // disposition below is the ONLY place a verdict becomes a pass / fail / skip.
        const report = await driveDaemonSoak({
          plan,
          lifecycle: createSoakLifecycle({
            server,
            cwd,
            bearer: ACCOUNT_BEARER,
            buildLaunchRequest: (at: string) =>
              launchRequest({ cwd: at, project: SOAK_PROJECT, initialPrompt: SOAK_INITIAL_PROMPT }),
            buildStopRequest: () => stopRequest(),
            stopPath: (sessionId: string) => sessionStopPath(sessionId),
          }),
        });

        switch (report.verdict) {
          case "verified":
            // The daemon carried every planned lifecycle and its FD/handle count came back after each
            // one, with no monotonic growth. The report states the span it ACTUALLY achieved, so this
            // pass claims exactly what it bought and no more.
            expect(report.violations).toEqual([]);
            expect(backend.launched()).toBe(plan.cycles + SOAK_WARMUP_CYCLES);
            break;
          case "drift":
            // The count did not come back, or it climbed on every cycle. FAIL the fenced run, naming the
            // violated check(s) — and, for a per-type growth, WHICH resource climbed.
            expect.fail(`daemon soak DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
            break;
          case "inconclusive":
            // A lifecycle could not complete, or the soak was cut short of the plan it declared — so the
            // question was never asked. No signal: runtime-SKIP rather than fake a green or raise a
            // false red. Symmetric with the absent-arm skip on the suite above.
            ctx.skip(`daemon soak inconclusive — ${report.reason}`);
            break;
        }
      },
      timeoutFor(plan),
    );
  });
});
