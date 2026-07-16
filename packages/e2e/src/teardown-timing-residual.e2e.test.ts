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
// `tsconfig.json` excludes test files from `typecheck` — the same placement every other web-ui call
// site in this package uses (`daemon-soak.e2e.test.ts`, `pty-handle-residual.e2e.test.ts`).
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import { sessionStopPath, stopRequest } from "@ccctl/web-ui/src/stop.js";
import {
  createLeakingPtyLauncher,
  createObservedPtyLauncher,
  PTY_REGISTRATION_TIMEOUT_MS,
  resolvePtyE2EEnv,
} from "./pty-handle-residual.js";
import {
  describeTeardownTimingFence,
  driveTeardownTimingResidual,
  resolveTeardownTimingPlan,
  TIMING_RESIDUAL_CHECK,
} from "./teardown-timing-residual.js";

// The fenced, self-classifying TEARDOWN-TIMING RESIDUAL oracle (issue #70, traces E2E-B-003).
//
// What it proves that nothing else does: #68 asks the per-fd residual question ONCE, unpressured, over
// the whole-daemon shutdown path; #69 drives many lifecycles but is PACED and — its own module doc says
// so — structurally fd-BLIND (#63's sampler counts ref'd libuv resources, not bare descriptors). A
// handle that lingers only when teardown is RACED is unasked by the first and unseeable by the second.
// This drives rapid, back-to-back launch/stop cycles against the REAL node-pty backend through the
// daemon's own ingresses and asks the kernel, per cycle: `process.kill(pid, 0)` for the child,
// `fstat(fd)` for the pty master descriptor.
//
// The STOP path (#76) is FORCED by AC1 rather than chosen: shutdown is terminal and the ghost-reaper is
// a timer, so it is the only teardown a drive can cycle. It is also the one where timing is
// load-bearing by its own documentation — the only `close()` caller with a deadline, and the one whose
// abandoned close leaves the owned pty latched `closed` "cheerfully, and to a still-running child".
//
// Fenced / opt-in on #68's arm — CCCTL_E2E + CCCTL_E2E_PTY (`resolvePtyE2EEnv`), SHARED deliberately
// because the prerequisite is identical: a real, SPAWN-CAPABLE node-pty, which a default checkout has
// on neither platform (#68's module doc is the one canonical account of why, per-platform). Absent →
// `describe.skipIf` SKIPS the whole file, so it lives OUTSIDE the credential-free CI `e2e` lane and
// never runs, nor fails, there. The fence, the classifier (the Tier-A encoding of #70's two ACs) and
// the drive's own pressure mechanics are proven credential-free in `teardown-timing-residual.test.ts`,
// so what is fenced here is the BINDING, not the judgment.
//
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL, naming
// the violated checks and the cycle) or `inconclusive` (a leg was never captured, or the run did not
// buy the pressure it would be claiming — runtime-skip, never a fabricated green).

const fence = resolvePtyE2EEnv();
const plan = resolveTeardownTimingPlan();

/** The logical project + seed prompt the phone's launch carries — so a daemon that dropped either is visible. */
const TIMING_PROJECT = "ccctl-e2e-teardown-timing";
const TIMING_INITIAL_PROMPT = "ccctl e2e: seed prompt for the teardown-timing residual";

const started: CcctlServer[] = [];
const tempDirs: string[] = [];

/**
 * A fresh, canonical directory to root each cycle's launch at — `realpathSync.native` because the
 * daemon's ingress canonicalizes the cwd it is handed, and the same dialect is what the sibling launch
 * specs mint. Fresh PER CYCLE for the reason the drive's `freshCwd` doc gives: #33 keys launch
 * correlation on `(cwd, mode)`, so a reused directory would let one cycle's failure surface as the
 * next cycle's `ambiguous-surface` refusal — a second, unrelated finding wearing this oracle's red.
 */
async function freshCanonicalCwd(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-teardown-timing-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Unlike #68's, this oracle's drive never closes the server — the teardown under test is the
  // per-session stop, and the daemon must stay UP across every cycle. So this really does tear it down.
  while (started.length > 0) {
    await started
      .pop()
      ?.close()
      .catch(() => {});
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() ?? "", { recursive: true, force: true }).catch(() => {});
  }
});

// SKIPS the whole suite when the real-pty env is absent — the default on CI and on any box that has not
// opted in. This is the skips-never-fakes fence: no fake pty is substituted to make an absent binding
// look green (the whole point of this oracle is that the fake CANNOT answer the question — a fake
// `kill()` firing a synthetic `onExit` proves the backend BELIEVES the child is reaped, never that the
// OS agrees, and least of all under a race).
describe.skipIf(!fence.ready)(
  `ccctl e2e: the teardown-timing residual (#70) — ${describeTeardownTimingFence(fence)}`,
  () => {
    describe("Rule: the daemon's stop leaves NO lingering handle, however rapidly it is driven", () => {
      it(
        "verifies that every rapid launch/stop cycle opens a live pty handle and leaves none behind (AC1+AC2)",
        async (ctx) => {
          // The REAL backend: `createPtySessionLauncher` wired to the REAL `defaultPtySpawner` — the very
          // spawner it would have constructed for itself — merely OBSERVED so the drive learns which pid
          // and fd to ask the kernel about on each cycle. Nothing about the orchestration is faked.
          const { launcher, spawns } = createObservedPtyLauncher();
          const server = await startServer({
            port: 0,
            launcher,
            // Keeps the ghost-reaper from stealing the teardown under test — see #68's
            // PTY_REGISTRATION_TIMEOUT_MS. The stand-in worker never registers, so the eviction timer
            // WILL fire on every launch this oracle makes; the window is raised past any plausible drive
            // duration so the only teardown that can have run on any cycle is the stop being measured.
            registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS,
          });
          started.push(server);

          // driveTeardownTimingResidual NEVER throws on a divergence or a missing leg — it returns a
          // verdict — so the disposition below is the ONLY place a verdict becomes a pass / fail / skip.
          const report = await driveTeardownTimingResidual({
            server,
            spawns,
            freshCwd: freshCanonicalCwd,
            // The phone's own bodies, built by the REAL browser modules.
            buildLaunchRequest: (dir) =>
              launchRequest({ cwd: dir, project: TIMING_PROJECT, initialPrompt: TIMING_INITIAL_PROMPT }),
            stopPath: (sessionId) => sessionStopPath(sessionId),
            buildStopRequest: () => stopRequest(),
            plan,
          });

          switch (report.verdict) {
            case "verified":
              // Every planned cycle raced its teardown and came back clean: the kernel confirmed a live
              // child and an open pty-master character device while each session was up, and — after the
              // daemon's own stop — that each descriptor was released and each child REAPED (ESRCH, not
              // a zombie). The report's `observed` says how much pressure that verdict actually bought.
              expect(report.violations).toEqual([]);
              expect(report.observed.cycles).toBe(plan.cycles);
              break;
            case "drift":
              // A handle lingered after a raced teardown, or the stop itself failed under pressure. FAIL
              // the fenced run, naming the violated check(s) and the cycle.
              expect.fail(`teardown-timing residual DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
              break;
            case "inconclusive":
              // The binding could not load or could not spawn, or the run could not buy the pressure it
              // would be claiming. No signal — runtime-SKIP rather than fake a green or raise a false
              // red. Symmetric with the absent-env skip on the suite above.
              ctx.skip(`teardown-timing residual inconclusive — ${report.reason}`);
              break;
          }
        },
        // The lane's default would be generous for a run of milliseconds-per-cycle, but the cycle count
        // is an operator lever (CCCTL_E2E_TIMING_CYCLES) — computed from the plan so a raised count is
        // not killed by a timeout that never heard about it.
        Math.max(30_000, plan.cycles * 5_000),
      );

      it("DETECTS a daemon that tears nothing down — the negative control that keeps the pass non-vacuous", async (ctx) => {
        // The self-guard, empirically (the `probeStandInLiveness` #134 posture). The test above asserts
        // an ABSENCE, and every absence-assertion passes when the probe never looked. The unit suite
        // proves the CLASSIFIER cannot verify vacuously, but only over constructed readings — it cannot
        // prove that the probe, pointed at a REAL pid and fd on THIS box, observes a residual that is
        // really there. If it could not, the run above would be green for the worst possible reason and
        // every unit test would still pass.
        //
        // So: the same real backend, the same real pty, the same real child — with teardown DISABLED.
        // ONE cycle is enough to prove the probe sees the residual, and one is all this should strand.
        const { launcher, spawns, reap } = createLeakingPtyLauncher();
        const server = await startServer({ port: 0, launcher, registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS });
        started.push(server);

        try {
          const report = await driveTeardownTimingResidual({
            server,
            spawns,
            freshCwd: freshCanonicalCwd,
            buildLaunchRequest: (dir) =>
              launchRequest({ cwd: dir, project: TIMING_PROJECT, initialPrompt: TIMING_INITIAL_PROMPT }),
            stopPath: (sessionId) => sessionStopPath(sessionId),
            buildStopRequest: () => stopRequest(),
            plan: { ...plan, cycles: 1 },
          });

          switch (report.verdict) {
            case "drift":
              // The probe saw BOTH halves of the residual it was pointed at: the stranded child still in
              // the process table, and the pty master fd still open ON THE SAME OBJECT (identity matched
              // — a recycled number would not count, and must not).
              expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.childReaped);
              expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.fdReleased);
              // And the server's OWN #76 guard caught it too: `stopLaunchedSession` re-reads the surface
              // after the close and refuses to report a stop that did not happen ("the surface reported a
              // successful close but is still running"). A control that drifted ONLY on the residual
              // checks would mean that guard had gone quiet.
              expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.stopAnswered);
              break;
            case "verified":
              // The probe called a daemon that tore NOTHING down clean. Every reading it takes is
              // therefore worthless, and the positive above is vacuous.
              expect.fail(
                "the oracle VERIFIED a daemon whose close() is a no-op — the probe cannot see a residual " +
                  "that is really there, so the positive run's `no lingering handle` means nothing",
              );
              break;
            case "inconclusive":
              // Same absent-binding gap as the positive; skip for the same reason.
              ctx.skip(`negative control inconclusive — ${report.reason}`);
              break;
          }
        } finally {
          // This launcher leaks ON PURPOSE — kill every child it stranded, whatever the verdict was.
          reap();
        }
      });
    });
  },
);
