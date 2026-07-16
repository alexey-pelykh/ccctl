// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type CcctlServer, type ISessionLauncher } from "@ccctl/server";
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import { sessionStopPath, stopRequest } from "@ccctl/web-ui/src/stop.js";
import { registerEnvironment } from "./bridge-wire-conformance.js";
import { LAUNCH_REGISTRATION_TIMEOUT_MS } from "./launch-tunnel.js";
import {
  createLeakingSoakLauncher,
  createSoakLauncher,
  createSoakLifecycle,
  driveDaemonSoak,
  SOAK_CHECK,
  SOAK_SKELETON_CYCLES,
  SOAK_WARMUP_CYCLES,
  type SoakLifecycle,
  type SoakPlan,
} from "./daemon-soak.js";

// The LONG-RUN DAEMON SOAK over LOOPBACK (#69) — the hermetic skeleton, in the posture every oracle in
// this package holds (`multi-session-harness` #20 → #65; `launch-lifecycle.test.ts` → #66;
// `full-flow-inference.test.ts` → #67).
//
// It differs from those in ONE way, and the difference is the point: their skeletons gate every run
// while their ORACLES stay fenced, because a tailnet / a native binding / an API key is infrastructure
// a CI box does not have. A soak needs no infrastructure — only TIME — so what the `CCCTL_E2E_SOAK` arm
// buys is the SPAN, and the compressed soak runs right here, against a REAL daemon, on every `test`
// run. Nothing about the judgment is fenced; `daemon-soak.e2e.test.ts` only spends longer.
//
// What this pins that `daemon-soak.test.ts` structurally cannot: that soaking a REAL daemon — its real
// registry, its real pending-launch records, its real worker channels and the downstream pipes/sockets
// they hold, its real event relays (#176), all retired through the real `stopSession` teardown (#76) —
// genuinely returns #63's FD/handle tally to baseline. The unit suite proves the CLASSIFIER cannot
// verify vacuously, but only over CONSTRUCTED readings; it says nothing about whether a real daemon
// carrying real sessions actually comes back. (The daemon's per-session TIMERS are not on that list on
// purpose: every one is `.unref()`'d and therefore invisible to this sampler — see the module doc's
// scope boundary in `daemon-soak.ts`. A real run's settled tally is `PipeWrap`/`TCPServerWrap`/
// `TCPSocketWrap` only, with no `Timeout` in it at all.)
//
// And the NEGATIVE CONTROL below is what keeps that positive from being vacuous — the
// `probeStandInLiveness` (#134) posture this package holds everywhere, here EMPIRICAL rather than
// merely logical. A soak asserts an ABSENCE ("no growth"), and every absence-assertion passes when the
// probe never looked. So the same daemon, the same sampler, the same classifier, on the same box, is
// driven against a launcher that leaks ONE ref'd handle per session — standing in for the class this
// oracle CAN see, a per-session ref'd resource the daemon never retires — and must report `drift`.
// Without it, a probe that always read a flat tally because it was asking wrongly would make the
// positive green for the worst possible reason while every unit test still passed.

const ACCOUNT_BEARER = "oauth-account-secret-daemon-soak";

const started: CcctlServer[] = [];
const tempDirs: string[] = [];

async function serve(launcher: ISessionLauncher): Promise<CcctlServer> {
  const server = await startServer({
    port: 0,
    launcher,
    // Matches the sibling skeletons: a window far above any plausible cycle duration, so the
    // ghost-reaper (#33) cannot tear a session down before the soak's own stop does. The teardown under
    // measurement must be the one the soak drove — the same confound #68 pins for the same reason.
    registrationTimeoutMs: LAUNCH_REGISTRATION_TIMEOUT_MS,
  });
  started.push(server);
  return server;
}

/**
 * ONE canonical directory, reused by every cycle — deliberately NOT a fresh temp dir per cycle, which
 * is what the sibling skeletons do. This is the ONE canonical account of why (`daemon-soak.ts` §
 * `SoakLifecycleConfig.cwd` and the fenced spec both point here rather than restate it).
 *
 * A soak measures what the process holds, so anything the HARNESS accumulates is attributed to the
 * daemon. Minting a directory per cycle would leak one per cycle for the length of the soak — thousands
 * over the multi-day run AC1 describes — and the harness would be the thing under test. Reuse is also
 * sound rather than merely cheap: each cycle fully completes (launch → claim → stop) before the next
 * begins, and `stopSession` consumes the pending launch, so no stale record survives for the next
 * cycle's registration to correlate against.
 *
 * `realpathSync.native` because the daemon's ingress canonicalizes the cwd it is handed, and the
 * launch↔§2 claim correlates on it — the same dialect every launch spec in this package mints.
 */
async function canonicalCwd(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-soak-")));
  tempDirs.push(dir);
  return dir;
}

/**
 * The soak's own lifecycle, wired to the REAL phone modules — the one seam this file owns.
 *
 * The web-ui builders are passed in here rather than reached for inside `daemon-soak.ts` because
 * `@ccctl/web-ui` is dependency-free plain JS with no type declarations, so its import belongs in an
 * (untypechecked) test file. The lifecycle's own composition is shared, so this skeleton and the fenced
 * long soak drive the SAME cycle rather than two copies that could drift apart.
 */
function soakLifecycle(server: CcctlServer, cwd: string): SoakLifecycle {
  return createSoakLifecycle({
    server,
    cwd,
    bearer: ACCOUNT_BEARER,
    buildLaunchRequest: (at: string) => launchRequest({ cwd: at, project: "soak", initialPrompt: "seed" }),
    buildStopRequest: () => stopRequest(),
    stopPath: (sessionId: string) => sessionStopPath(sessionId),
  });
}

const SKELETON_PLAN: SoakPlan = { cycles: SOAK_SKELETON_CYCLES, durationMs: 0 };

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() ?? "", { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("the long-run soak the fenced oracle drives (#69) — over loopback, against a REAL daemon", () => {
  it("returns the daemon's FD/handle count to baseline after every session lifecycle (AC2)", async () => {
    const backend = createSoakLauncher();
    const server = await serve(backend.launcher);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    const report = await driveDaemonSoak({
      plan: SKELETON_PLAN,
      lifecycle: soakLifecycle(server, cwd),
    });

    // The verdict carries its own explanation, so a failure here reads as WHAT leaked rather than as
    // a bare boolean.
    expect({ verdict: report.verdict, violations: report.violations, reason: report.reason }).toEqual({
      verdict: "verified",
      violations: [],
      reason: expect.stringContaining("no slow leak"),
    });
    // The daemon really did carry every planned lifecycle — counted at the backend, not promised by
    // the drive: warmup cycles are real lifecycles too, they are only excluded from the SERIES.
    expect(backend.launched()).toBe(SOAK_SKELETON_CYCLES + SOAK_WARMUP_CYCLES);
  }, 30_000);

  it("is honest that a compressed soak did not span multiple days (AC1's span is the operator's to buy)", async () => {
    const backend = createSoakLauncher();
    const server = await serve(backend.launcher);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    const report = await driveDaemonSoak({
      plan: SKELETON_PLAN,
      lifecycle: soakLifecycle(server, cwd),
    });

    expect(report.verdict).toBe("verified");
    // The one thing a compressed run must never do: read as the multi-day claim it did not buy.
    expect(report.spannedMultiDay).toBe(false);
    expect(report.reason).toContain("did NOT span multiple days");
  }, 30_000);

  it("leaves NOTHING in the daemon's own registry — the row leaves on every cycle, so a slot always frees", async () => {
    const backend = createSoakLauncher();
    // At a cap of ONE: an unfreed slot refuses the very next launch with `at-capacity` (429), which
    // the lifecycle would throw on — so a soak that completes at this cap IS the proof that every
    // cycle's row left. This is the daemon's own bookkeeping view of what the handle tally sees in
    // aggregate.
    const server = await startServer({
      port: 0,
      launcher: backend.launcher,
      maxSessions: 1,
      registrationTimeoutMs: LAUNCH_REGISTRATION_TIMEOUT_MS,
    });
    started.push(server);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    const report = await driveDaemonSoak({
      plan: SKELETON_PLAN,
      lifecycle: soakLifecycle(server, cwd),
    });

    expect(report.verdict).toBe("verified");
    expect(server.sessions.size).toBe(0);
  }, 30_000);

  it("leaves the daemon UP — the caller owns the long-running subject, and the drive never tears it down", async () => {
    const backend = createSoakLauncher();
    const server = await serve(backend.launcher);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    const report = await driveDaemonSoak({
      plan: SKELETON_PLAN,
      lifecycle: soakLifecycle(server, cwd),
    });
    expect(report.verdict).toBe("verified");

    // The asymmetry that separates #69 from #68, whose drive DOES close the daemon: here the daemon is
    // the long-running SUBJECT, so the drive is handed no server and no teardown and can close nothing.
    // `SoakDriveConfig` carrying no such field makes that structurally true — but structure is not
    // evidence, so this drives one MORE full lifecycle against the same daemon after the soak has
    // already returned. It could only pass against a daemon that is still up and still working.
    await expect(soakLifecycle(server, cwd)(1)).resolves.toBeUndefined();
    expect(backend.launched()).toBe(SOAK_SKELETON_CYCLES + SOAK_WARMUP_CYCLES + 1);
  }, 30_000);
});

describe("the negative control: the same probe, on the same box, DOES see a leak that is really there", () => {
  it("reports `drift` against a daemon whose launcher strands one ref'd handle per session", async () => {
    const leaking = createLeakingSoakLauncher();
    const server = await serve(leaking.launcher);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    try {
      const report = await driveDaemonSoak({
        plan: SKELETON_PLAN,
        lifecycle: soakLifecycle(server, cwd),
      });

      expect(report.verdict).toBe("drift");
      // Both detectors see it, and each is named: the count did not come back (accumulation), and it
      // climbed without ever reversing (the trend). One handle per cycle is the smallest leak there is.
      expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(true);
      expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.monotonic))).toBe(true);
      // The per-type check names the real culprit rather than only the total — an operator reading
      // this verdict is told WHICH resource climbed.
      expect(report.violations.join(" ")).toContain("`Timeout`");
      // The control leaked on EVERY lifecycle, warmup included — so the drift is a real accumulation
      // and not an artifact of one stray handle.
      expect(leaking.leaked()).toBe(SOAK_SKELETON_CYCLES + SOAK_WARMUP_CYCLES);
    } finally {
      leaking.reap();
    }
  }, 30_000);

  it("…and its surface still tears down correctly, so the `drift` is a LEAK and not a broken stop", async () => {
    // The distinction the control rests on: had the surface not really closed, the daemon's post-close
    // liveness re-read would refuse every stop (502 `stop-failed`) and the run would be
    // `inconclusive` on a lifecycle that could not complete — a different finding wearing the same
    // red. This pins that the ONLY thing wrong with the control is the stranded handle.
    const leaking = createLeakingSoakLauncher();
    const server = await serve(leaking.launcher);
    const cwd = await canonicalCwd();
    await registerEnvironment(server, ACCOUNT_BEARER);

    try {
      await expect(soakLifecycle(server, cwd)(1)).resolves.toBeUndefined();
      expect(server.sessions.size).toBe(0);
    } finally {
      leaking.reap();
    }
  }, 30_000);
});
