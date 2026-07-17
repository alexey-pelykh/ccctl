// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type CcctlServer } from "@ccctl/server";
// The REAL browser module the phone's "New session" control uses (#37) — the launch leg must be the
// phone's OWN code, never a re-transcription of its body. It lives HERE, in the test file, because
// `@ccctl/web-ui` is dependency-free plain JS with no type declarations and `tsconfig.json` excludes
// test files from `typecheck` — the same placement every other web-ui call site in this package uses
// (`launch-tunnel-flow.e2e.test.ts`, `one-session-flow.e2e.test.ts`, `web-ui-launch-flow.test.ts`).
// The oracle takes it as an injected builder rather than importing it into typechecked source.
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import {
  createLeakingPtyLauncher,
  createObservedPtyLauncher,
  createSighupIgnoringPtyLauncher,
  describePtyFence,
  drivePtyHandleResidual,
  ESCALATION_CONTROL_WINDOW_MS,
  ESCALATION_WINDOW_MS,
  LEAK_CONTROL_REAP_TIMEOUT_MS,
  PTY_REGISTRATION_TIMEOUT_MS,
  PTY_RESIDUAL_CHECK,
  resolvePtyE2EEnv,
} from "./pty-handle-residual.js";

// The fenced, self-classifying REAL-node-pty HANDLE-RESIDUAL oracle (issue #68, traces E2E-B-003).
//
// What it proves that nothing else does: `@ccctl/server`'s owned-pty backend (#30) is unit-proven
// against an IN-MEMORY FAKE pty — deliberately, and its own suite says so. That proves the
// orchestration (kill → escalate → reap → idempotent close) but cannot prove the orchestration's
// promise against the REAL native binding, because "the pty fd is released and the child is reaped"
// is a claim about the OPERATING SYSTEM, and a fake `kill()` firing a synthetic `onExit` only ever
// proves the backend BELIEVES it. This drives the real binding, through the daemon's own launch
// ingress, and asks the kernel: `process.kill(pid, 0)` for the child, `fstat(fd)` for the pty master
// descriptor the real handle exposes. `ESRCH` is the answer that means REAPED — a zombie would still
// answer — which is the difference AC2 is actually about.
//
// Fenced / opt-in on its OWN arm: CCCTL_E2E + CCCTL_E2E_PTY (`resolvePtyE2EEnv`). The prerequisite is
// neither a tailnet (#65/#66/#67) nor an API key (#133) but a real, SPAWN-CAPABLE node-pty, which
// this repo's default install does not have on EITHER platform — for two DIFFERENT per-platform
// reasons, and with a different lever each. That account is `pty-handle-residual.ts`'s module doc
// (the canonical one; not restated here — #235), and `pnpm --filter @ccctl/e2e arm:pty` probes this
// box and prints the lever it needs. Absent → `describe.skipIf` SKIPS the whole file, so it lives
// OUTSIDE the credential-free CI `e2e` lane and never runs, nor fails, there. The fence + classifier
// LOGIC — the Tier-A encoding of #68's two ACs, plus the OS probe's own semantics — is proven
// credential-free in the `test` lane by `pty-handle-residual.test.ts`, so what is fenced here is the
// BINDING, not the judgment.
//
// Self-classifying + skips-never-fakes: a driven run yields `verified` (pass), `drift` (FAIL, naming
// the violated checks) or `inconclusive` (a leg was never captured — the binding could not load or
// could not spawn — runtime-skip, never a fabricated green).

const fence = resolvePtyE2EEnv();

/** The logical project + seed prompt the phone's launch carries — so a daemon that dropped either is visible. */
const PTY_PROJECT = "ccctl-e2e-pty-residual";
const PTY_INITIAL_PROMPT = "ccctl e2e: seed prompt for the real-pty handle residual";

const started: CcctlServer[] = [];
const tempDirs: string[] = [];

/**
 * A fresh, canonical directory to root the launch at — `realpathSync.native` because the daemon's
 * ingress canonicalizes the cwd it is handed, and the same dialect is what the sibling launch specs
 * mint (`launch-lifecycle.test.ts`).
 */
async function freshCanonicalCwd(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-pty-residual-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // The drive closes the server ITSELF — that teardown is the thing under test — so by the time this
  // runs the server is normally already down and `close()` rejects with "Server is not running". This
  // is only the safety net for a run that failed BEFORE reaching the teardown, so the reject is
  // swallowed: it is the expected outcome of the happy path, not a failure to report.
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

// SKIPS the whole suite when the real-pty env is absent — the default on CI and on any box that has
// not opted in. This is the skips-never-fakes fence: no fake pty is substituted to make an absent
// binding look green (the whole point of this oracle is that the fake CANNOT answer the question).
describe.skipIf(!fence.ready)(`ccctl e2e: the REAL node-pty handle residual (#68) — ${describePtyFence(fence)}`, () => {
  describe("Rule: a session launched onto the REAL owned-pty backend leaves NO residual once the daemon tears it down", () => {
    it("verifies the pty master fd is open + the child live at launch, and both are gone after teardown (AC1+AC2)", async (ctx) => {
      // The REAL backend: `createPtySessionLauncher` wired to the REAL `defaultPtySpawner` — the
      // very spawner it would have constructed for itself — merely OBSERVED so the drive learns
      // which pid and fd to ask the kernel about. Nothing about the orchestration is faked.
      const { launcher, observed } = createObservedPtyLauncher();
      const server = await startServer({
        port: 0,
        launcher,
        // Keeps the ghost-reaper from stealing the teardown under test — see
        // PTY_REGISTRATION_TIMEOUT_MS. The stand-in worker never registers, so the eviction timer
        // WILL fire on any launch this oracle makes; the window is raised past any plausible drive
        // duration so the only teardown that can have run is the one being measured.
        registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS,
      });
      started.push(server);
      const cwd = await freshCanonicalCwd();

      // drivePtyHandleResidual NEVER throws on a divergence or a missing leg — it returns a
      // verdict — so the disposition below is the ONLY place a verdict becomes a pass / fail / skip.
      const report = await drivePtyHandleResidual({
        server,
        observed,
        cwd,
        // The phone's own body, built by the REAL browser module for the drive's fresh canonical cwd.
        buildLaunchRequest: (dir) =>
          launchRequest({ cwd: dir, project: PTY_PROJECT, initialPrompt: PTY_INITIAL_PROMPT }),
        // The REAL teardown path whose residual is under test: the daemon's own shutdown, which
        // runs `releaseLaunchedSessions` → `releaseLaunchedSession` (probe, then close) → the pty
        // backend's `close()` (kill, await the reap).
        teardown: () => server.close(),
      });

      switch (report.verdict) {
        case "verified":
          // The daemon launched a session onto a real pty: the kernel confirmed a live child and an
          // open pty-master character device while it was up, and — after the daemon's own teardown
          // — that the descriptor was released (EBADF) and the child REAPED (ESRCH, not a zombie).
          expect(report.violations).toEqual([]);
          break;
        case "drift":
          // The real pty ran but left a residual (an orphaned child, a leaked descriptor), or the
          // daemon disowned a surface it spawned. FAIL the fenced run, naming the violated check(s).
          expect.fail(`real-pty handle residual DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
          break;
        case "inconclusive":
          // The binding could not load or could not spawn, so the question was never asked. No
          // signal — runtime-SKIP rather than fake a green or raise a false red. Symmetric with the
          // absent-env skip on the suite above.
          ctx.skip(`real-pty handle residual inconclusive — ${report.reason}`);
          break;
      }
    });

    it("DETECTS a daemon that tears nothing down — the negative control that keeps the pass non-vacuous", async (ctx) => {
      // The self-guard, empirically (the `probeStandInLiveness` #134 posture). The test above
      // asserts an ABSENCE, and every absence-assertion passes when the probe never looked. The
      // unit suite proves the CLASSIFIER cannot verify vacuously, but only over constructed
      // readings — it cannot prove that `readHandleState`, pointed at a REAL pid and fd on THIS
      // box, observes a residual that is really there. If it could not, the run above would be
      // green for the worst possible reason and every unit test would still pass.
      //
      // So: the same real backend, the same real pty, the same real child — with teardown DISABLED.
      // The residual is now really there, and the same probe must SAY so.
      const { launcher, observed, reap } = createLeakingPtyLauncher();
      const server = await startServer({ port: 0, launcher, registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS });
      started.push(server);
      const cwd = await freshCanonicalCwd();

      try {
        const report = await drivePtyHandleResidual({
          server,
          observed,
          cwd,
          buildLaunchRequest: (dir) =>
            launchRequest({ cwd: dir, project: PTY_PROJECT, initialPrompt: PTY_INITIAL_PROMPT }),
          teardown: () => server.close(),
          // Nothing is in flight to converge to — see LEAK_CONTROL_REAP_TIMEOUT_MS.
          reapTimeoutMs: LEAK_CONTROL_REAP_TIMEOUT_MS,
        });

        switch (report.verdict) {
          case "drift":
            // The probe saw BOTH halves of the residual it was pointed at: the stranded child still
            // in the process table, and the pty master fd still open ON THE SAME OBJECT (identity
            // matched — a recycled number would not count, and must not).
            expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.childReaped);
            expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.fdReleased);
            break;
          case "verified":
            // The probe called a daemon that tore NOTHING down clean. Every reading it takes is
            // therefore worthless, and the positive above is vacuous.
            expect.fail(
              "the oracle VERIFIED a daemon whose close() is a no-op — the probe cannot see a residual " +
                "that is really there, so the positive run's `no residual` means nothing",
            );
            break;
          case "inconclusive":
            // Same absent-binding gap as the positive; skip for the same reason.
            ctx.skip(`negative control inconclusive — ${report.reason}`);
            break;
        }
      } finally {
        // This launcher leaks ON PURPOSE — kill the child it stranded, whatever the verdict was.
        reap();
      }
    });
  });

  describe("Rule: a child that IGNORES the polite signal is still reaped — the backend escalates to SIGKILL", () => {
    // The other half of `close()` (#237). The rule above drives a `sleep`, which dies on the polite
    // signal, so it only ever exercises the COOPERATIVE path — leaving the escalation proven solely by
    // #30's unit suite, against a fake whose `kill()` fires a synthetic `onExit`. That is the very
    // argument this oracle rejects for the polite path ("a claim about the OPERATING SYSTEM, and only a
    // real pty can be asked"), so the escalation carried the gap the happy path no longer does. These
    // two ask the kernel instead, with a stand-in that really ignores a real signal.

    it("VERIFIES that the escalation reaps a child the polite signal could not (AC2)", async (ctx) => {
      // The REAL backend again — the only differences from the positive above are the stand-in's argv
      // (it traps the polite signal) and a short escalation window. Nothing about the orchestration is
      // faked: this is `createPtySessionLauncher` on the real `defaultPtySpawner`, and the SIGKILL is
      // the backend's own, fired by its own timer.
      const { launcher, observed, reap, armed } = createSighupIgnoringPtyLauncher(ESCALATION_WINDOW_MS);
      const server = await startServer({ port: 0, launcher, registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS });
      started.push(server);
      const cwd = await freshCanonicalCwd();

      try {
        const report = await drivePtyHandleResidual({
          server,
          observed,
          cwd,
          buildLaunchRequest: (dir) =>
            launchRequest({ cwd: dir, project: PTY_PROJECT, initialPrompt: PTY_INITIAL_PROMPT }),
          teardown: () => server.close(),
        });

        // A stand-in that never armed is one the polite signal COULD have ended, so a green below would
        // mean nothing (see SIGHUP_IGNORING_WORKER_ARMED_COMMAND — this is the startup race). Not a
        // failure: the question was never askable, which is a skip in this package's vocabulary.
        if (!armed()) {
          ctx.skip("the SIGHUP-ignoring stand-in never armed — the escalation cannot be asked about here");
          return;
        }

        switch (report.verdict) {
          case "verified":
            // The kernel confirmed the child gone (ESRCH — reaped, not a zombie) and the master fd
            // released, for a child that the control below proves the polite signal does NOT end. So
            // the escalation is the only thing that can have done it, and it did it against the real
            // binding rather than a fake's synthetic `onExit`.
            expect(report.violations).toEqual([]);
            break;
          case "drift":
            // The escalation did not land: the trapping child outlived the whole teardown. That is the
            // orphan-with-an-open-pty-fd AC2 forbids, and the one `session-launcher-pty.ts` § `close`
            // names as the case where "every layer above this fails together".
            expect.fail(`SIGKILL escalation DRIFT: ${report.violations.join("; ")} — ${report.reason}`);
            break;
          case "inconclusive":
            ctx.skip(`escalation run inconclusive — ${report.reason}`);
            break;
        }
      } finally {
        // This stand-in ignores the polite signal, so SIGKILL is the only thing that can clean up after
        // a run that failed before the backend's own escalation fired.
        reap();
      }
    });

    it("DETECTS that the polite signal alone does NOT end it — the control that licenses the attribution", async (ctx) => {
      // Without this, the run above is titled after the escalation while proving nothing about it. A
      // stand-in that quietly stopped trapping — a `trap` typo, a shell that reset the disposition, a
      // node-pty that grew a process-group kill — would make it green via the POLITE path, and the
      // suite would report a passing escalation test that never escalated.
      //
      // So: the same real backend, the same trapping stand-in, with the escalation pushed out of
      // reach. Nothing but the polite signal can fire inside this drive — and the child must therefore
      // still be there.
      const { launcher, observed, reap, armed } = createSighupIgnoringPtyLauncher(ESCALATION_CONTROL_WINDOW_MS);
      const server = await startServer({ port: 0, launcher, registrationTimeoutMs: PTY_REGISTRATION_TIMEOUT_MS });
      started.push(server);
      const cwd = await freshCanonicalCwd();

      try {
        const report = await drivePtyHandleResidual({
          server,
          observed,
          cwd,
          buildLaunchRequest: (dir) =>
            launchRequest({ cwd: dir, project: PTY_PROJECT, initialPrompt: PTY_INITIAL_PROMPT }),
          teardown: () => server.close(),
          // The escalation cannot fire inside this window — that is the point. Waiting the full
          // convergence window would only be slower to reach a verdict already readable.
          reapTimeoutMs: LEAK_CONTROL_REAP_TIMEOUT_MS,
        });

        if (!armed()) {
          ctx.skip("the SIGHUP-ignoring stand-in never armed — nothing to control for");
          return;
        }

        switch (report.verdict) {
          case "drift":
            // The stand-in really is deaf to the polite signal: it survived it, holding its pty master
            // fd open. Which is what makes the run above a statement about the escalation.
            expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.childReaped);
            break;
          case "verified":
            expect.fail(
              "the stand-in died WITHOUT the escalation — the polite signal ended it, so the run above " +
                "proves nothing about the SIGKILL path it is named for",
            );
            break;
          case "inconclusive":
            ctx.skip(`escalation control inconclusive — ${report.reason}`);
            break;
        }
      } finally {
        // Stranded BY CONSTRUCTION — the escalation was armed past this drive on purpose.
        reap();
      }
    });
  });
});
