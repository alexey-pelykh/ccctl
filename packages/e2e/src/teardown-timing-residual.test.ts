// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { closeSync, openSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import {
  classifyTeardownTimingResidual,
  DEFAULT_TEARDOWN_TIMING_PLAN,
  describeTeardownTimingFence,
  driveTeardownTimingResidual,
  resolveTeardownTimingPlan,
  TIMING_RESIDUAL_CHECK,
  type TeardownTimingCapture,
  type TeardownTimingDriveConfig,
  type TimingCycleCapture,
} from "./teardown-timing-residual.js";
import { readHandleState, resolvePtyE2EEnv, type HandleReading } from "./pty-handle-residual.js";

// The CREDENTIAL-FREE half of the #70 teardown-timing residual oracle: its FENCE, its PURE CLASSIFIER
// (the Tier-A encoding of #70's two ACs), and the DRIVE's own pressure mechanics. This runs in the
// plain `test` lane on EVERY box — no node-pty, no native binding, no fenced env — because what is
// fenced about the oracle is the BINDING, not the JUDGMENT. The e2e spec
// (`teardown-timing-residual.e2e.test.ts`) drives the real binding and does nothing but dispatch on the
// verdict this file pins.
//
// The drive tests below are the notable ones. The drive is impure — it speaks HTTP to a daemon and
// reads the OS — but neither of those needs a pty: a stand-in daemon answering the two ingresses is
// twenty lines of `node:http`, and a live pid (our own) plus a real open character device
// (`/dev/null`) are exactly the readings its mechanics turn on. What they pin is the property that
// forced this oracle to widen #68's observer at all: a cycle whose launch spawned NOTHING must not
// inherit the previous cycle's handle.

const LIVE: HandleReading = {
  childPresent: true,
  fdOpen: true,
  fdIdentity: "16777232:268435459:610",
  fdCharacterDevice: true,
};

const GONE: HandleReading = {
  childPresent: false,
  childErrno: "ESRCH",
  fdOpen: false,
  fdErrno: "EBADF",
};

/** One healthy cycle — every leg observed, the two readings DISAGREEING as they must, well under the ceiling. */
function healthyCycle(index: number, overrides: Partial<TimingCycleCapture> = {}): TimingCycleCapture {
  return {
    index,
    spawned: { pid: 4242 + index, fd: 12 },
    launchStatus: 201,
    sessionId: `session-${index}`,
    atLaunch: LIVE,
    launchToStopGapMs: 1,
    stopStatus: 200,
    stopOutcome: "stopped",
    afterStop: GONE,
    ...overrides,
  };
}

/** A complete, healthy capture — the planned cycles all driven, all clean. */
function healthyCapture(overrides: Partial<TeardownTimingCapture> = {}): TeardownTimingCapture {
  const plan = overrides.plan ?? {
    cycles: 3,
    maxLaunchToStopGapMs: DEFAULT_TEARDOWN_TIMING_PLAN.maxLaunchToStopGapMs,
  };
  return {
    plan,
    cycles: Array.from({ length: plan.cycles }, (_value, index) => healthyCycle(index)),
    ...overrides,
  };
}

/**
 * A capture of exactly these cycles, under a plan that asked for precisely them — the shape of every
 * case whose subject is the CYCLES, not the plan. The ceiling comes from the shipped default rather
 * than a literal, so the fixtures track what the oracle actually ships. The cases that deliberately
 * plan a DIFFERENT number than they drove (the cardinality floor, the shortfall gap, and drift-outranks-
 * a-gap) state their plan explicitly, because for those the mismatch IS the subject.
 */
function captureOf(...cycles: TimingCycleCapture[]): TeardownTimingCapture {
  return {
    plan: { cycles: cycles.length, maxLaunchToStopGapMs: DEFAULT_TEARDOWN_TIMING_PLAN.maxLaunchToStopGapMs },
    cycles,
  };
}

describe("the teardown-timing oracle's fence (#70) — SHARED with #68, deliberately", () => {
  it("is #68's fence: the prerequisite is the same spawn-capable node-pty, so the arm is the same", () => {
    // Pins the design decision the module doc argues: this oracle does NOT invent a third env var. A
    // box that armed the pty oracle has armed this one, because there is nothing else it could need.
    expect(resolvePtyE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_PTY: "1" })).toEqual({ ready: true });
  });

  it("renders an ARMED fence naming both vars", () => {
    expect(describeTeardownTimingFence({ ready: true })).toBe(
      "teardown-timing oracle armed (CCCTL_E2E + CCCTL_E2E_PTY present)",
    );
  });

  it("renders a FENCED-OFF fence naming every absent var — an operator fixes one round-trip, not two", () => {
    expect(describeTeardownTimingFence({ ready: false, missing: ["CCCTL_E2E", "CCCTL_E2E_PTY"] })).toBe(
      "teardown-timing oracle fenced off — missing CCCTL_E2E, CCCTL_E2E_PTY",
    );
  });

  it("names THIS oracle rather than #68's, so a skip says which spec skipped", () => {
    expect(describeTeardownTimingFence({ ready: true })).toContain("teardown-timing");
  });
});

describe("resolveTeardownTimingPlan (#70) — AC1's operator lever", () => {
  it("defaults to the shipped plan when the env is silent", () => {
    expect(resolveTeardownTimingPlan({})).toEqual(DEFAULT_TEARDOWN_TIMING_PLAN);
  });

  it("drives MORE cycles when the operator asks for them — more is always a stronger AC1 claim", () => {
    expect(resolveTeardownTimingPlan({ CCCTL_E2E_TIMING_CYCLES: "40" })).toEqual({
      ...DEFAULT_TEARDOWN_TIMING_PLAN,
      cycles: 40,
    });
  });

  it.each(["", "  ", "0", "-3", "abc", "1.5e3z"])(
    "falls back to the default on %o — a typo in a shell must not read as a defect in the daemon",
    (raw) => {
      expect(resolveTeardownTimingPlan({ CCCTL_E2E_TIMING_CYCLES: raw })).toEqual(DEFAULT_TEARDOWN_TIMING_PLAN);
    },
  );

  it("exposes NO lever on the gap ceiling — a knob whose only use is switching the guard off", () => {
    // The ceiling is this oracle's own honesty tripwire (module doc). Raising it from the environment
    // would defeat the one thing it exists for, so no env var may.
    expect(resolveTeardownTimingPlan({ CCCTL_E2E_TIMING_CYCLES: "40" }).maxLaunchToStopGapMs).toBe(
      DEFAULT_TEARDOWN_TIMING_PLAN.maxLaunchToStopGapMs,
    );
  });

  it("ships a default that is genuinely MULTI-cycle — a one-cycle run would only restate #68", () => {
    expect(DEFAULT_TEARDOWN_TIMING_PLAN.cycles).toBeGreaterThan(1);
  });
});

describe("classifyTeardownTimingResidual (#70) — Rule: rapid teardown leaves NO lingering handle", () => {
  describe("verified", () => {
    it("VERIFIES when every planned cycle opened a live handle and the stop left none behind", () => {
      const report = classifyTeardownTimingResidual(healthyCapture());
      expect(report.verdict).toBe("verified");
      expect(report.violations).toEqual([]);
    });

    it("reports the pressure it ACTUALLY bought — cycles driven and the worst gap", () => {
      const capture = captureOf(
        healthyCycle(0, { launchToStopGapMs: 2 }),
        healthyCycle(1, { launchToStopGapMs: 17 }),
        healthyCycle(2, { launchToStopGapMs: 4 }),
      );
      const report = classifyTeardownTimingResidual(capture);
      expect(report.verdict).toBe("verified");
      expect(report.observed).toEqual({ cycles: 3, maxLaunchToStopGapMs: 17 });
    });

    it("PASSES an fd whose NUMBER was recycled onto a different object — the rapid-cycle case", () => {
      // POSIX hands out the lowest free descriptor, so the number this cycle's pty master just freed is
      // a prime candidate for the next cycle's. A bare "is fd 12 open?" would fail a faithful daemon on
      // cycle 2; only the IDENTITY tells a leak from a reuse.
      const recycled: HandleReading = { childPresent: false, childErrno: "ESRCH", fdOpen: true, fdIdentity: "1:2:999" };
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { atLaunch: LIVE, afterStop: recycled })),
      );
      expect(report.verdict).toBe("verified");
    });
  });

  describe("drift — a residual the probe actually OBSERVED", () => {
    it("DRIFTS when a child survived the stop, naming the cycle", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(
          healthyCycle(0),
          healthyCycle(1, { afterStop: { ...GONE, childPresent: true, childErrno: undefined } }),
        ),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.childReaped);
      expect(report.violations.join(" ")).toContain("cycle 1");
    });

    it("DRIFTS when the pty master fd is still open on the SAME object after the stop", () => {
      const leaked: HandleReading = {
        childPresent: false,
        childErrno: "ESRCH",
        fdOpen: true,
        fdIdentity: LIVE.fdIdentity,
      };
      const report = classifyTeardownTimingResidual(captureOf(healthyCycle(0, { afterStop: leaked })));
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.fdReleased);
    });

    it("DRIFTS when the stop itself failed under pressure — AC2's 'behaves correctly'", () => {
      // `stop-failed` is what the server raises when a close rejected, or when its own post-close
      // re-read caught a surface that "reported a successful close but is still running" — and `502` is
      // the status it actually answers with (`ui-session-stop.ts` § `STOP_FAILURE_STATUS`), not a
      // stand-in number, so this fixture is the wire the fenced control really observes.
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { stopStatus: 502, stopOutcome: undefined, stopFailure: "stop-failed" })),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.stopAnswered);
      expect(report.violations.join(" ")).toContain("stop-failed");
    });

    it("NEVER verifies a probe stuck on 'gone' — the at-launch reading is a claim under test", () => {
      // The residual self-guard. If the child reads as already-gone at launch, the after-reading's
      // "gone" is the probe's default answer rather than evidence of a teardown.
      const report = classifyTeardownTimingResidual(captureOf(healthyCycle(0, { atLaunch: GONE })));
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.childLive);
    });

    it("DRIFTS when the master fd was not open at launch", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { atLaunch: { childPresent: true, fdOpen: false, fdErrno: "EBADF" } })),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.fdOpened);
    });

    it("DRIFTS when the launched fd is open but is NOT a character device — that is not a pty master", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { atLaunch: { ...LIVE, fdCharacterDevice: false } })),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain("NOT a character device");
    });

    it("DRIFTS when a real pty spawned but the daemon's own launch denied it", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { launchStatus: 409, launchFailure: "at-capacity" })),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.launch);
    });

    it("NAMES a stop that never reached the daemon, rather than reporting its residual as a leak", () => {
      // The transport half of the "unrelated finding wearing this oracle's red" hazard. When the stop's
      // `fetch` throws, the daemon was never asked — but the after-reading still runs (a failed stop is
      // when a residual is there to see), so the residual checks fire and DRIFT outranks gaps, which
      // suppresses the gap report that would otherwise have named the failed request. Without the
      // drift-half violation, the verdict reads "the child survived the daemon's stop" and sends the
      // reader hunting a handle leak that is really a broken drive.
      const report = classifyTeardownTimingResidual(
        captureOf(
          healthyCycle(0, {
            stopStatus: undefined,
            stopOutcome: undefined,
            stopFailure: "the stop request itself failed: fetch failed",
            afterStop: { ...GONE, childPresent: true, childErrno: undefined },
          }),
        ),
      );
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain("never reached the daemon");
      expect(report.violations.join(" ")).toContain("fetch failed");
      // And it says so about the residual it also names, so the two are not confused.
      expect(report.violations.join(" ")).toContain("UNATTRIBUTED");
    });

    it("still reports the pressure it achieved on a DRIFT — the verdict never drops AC1", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(healthyCycle(0, { launchToStopGapMs: 9 }), healthyCycle(1, { atLaunch: GONE, launchToStopGapMs: 3 })),
      );
      expect(report.verdict).toBe("drift");
      expect(report.observed).toEqual({ cycles: 2, maxLaunchToStopGapMs: 9 });
    });
  });

  describe("inconclusive — a question this run could not ask", () => {
    it("is INCONCLUSIVE on a ZERO-cycle run, even when the plan asked for NONE — the cardinality floor", () => {
      // The plan is DELIBERATELY zero, and that is the whole point of the case: against any positive
      // plan a zero-cycle run is already caught by the shortfall gap below, so a `cycles: 12` fixture
      // would pass with the floor deleted and prove nothing about it. `cycles: 0` is the one capture
      // only the floor catches — without it, `0 < 0` is false, no gap fires, and a run that measured
      // NOTHING reports `verified`: this package's worst failure mode, a green from a probe that never
      // ran. (Not reachable through `resolveTeardownTimingPlan`, which floors at 1 — but a classifier is
      // pure over its input and must not depend on its callers to stay honest.)
      const report = classifyTeardownTimingResidual({ plan: { cycles: 0, maxLaunchToStopGapMs: 250 }, cycles: [] });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("no cycle was driven at all");
      expect(report.observed).toEqual({ cycles: 0, maxLaunchToStopGapMs: undefined });
    });

    it("REFUSES to verify a run that fell short of its plan — it cannot claim pressure it did not buy", () => {
      const report = classifyTeardownTimingResidual({
        plan: { cycles: 12, maxLaunchToStopGapMs: 250 },
        cycles: [healthyCycle(0), healthyCycle(1)],
      });
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain("only 2 of the planned 12");
    });

    it("REFUSES to verify a cycle that SETTLED before stopping — AC1's teeth", () => {
      // The tripwire on this oracle's own honesty: a settling sleep between the two legs would leave the
      // run green while it silently stopped testing anything #68 does not already cover.
      const report = classifyTeardownTimingResidual(captureOf(healthyCycle(0, { launchToStopGapMs: 900 })));
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(TIMING_RESIDUAL_CHECK.pressure);
      expect(report.reason).toContain("this teardown was not raced");
    });

    it("is INCONCLUSIVE when the stop reports `already-exited` — the teardown under test never ran", () => {
      // The confound #68 had to engineer its stand-in's sleep floor around: a child that died by some
      // other hand leaves a clean after-reading that would otherwise read as a green for a teardown that
      // never happened. The stop path REPORTS it, so it lands as a gap.
      const report = classifyTeardownTimingResidual(captureOf(healthyCycle(0, { stopOutcome: "already-exited" })));
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(TIMING_RESIDUAL_CHECK.stopTore);
    });

    it("is INCONCLUSIVE when the backend never brought a pty up, carrying the daemon's OWN typed reason", () => {
      const report = classifyTeardownTimingResidual(
        captureOf({ index: 0, launchStatus: 503, launchFailure: "backend-unavailable" }),
      );
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(TIMING_RESIDUAL_CHECK.backend);
      expect(report.reason).toContain("backend-unavailable");
    });

    it("is INCONCLUSIVE when the handle exposes no master fd — a ConPTY has none, so the question cannot be asked", () => {
      const report = classifyTeardownTimingResidual(
        captureOf({ index: 0, spawned: { pid: 1 }, launchStatus: 201, sessionId: "s" }),
      );
      expect(report.verdict).toBe("inconclusive");
      expect(report.reason).toContain(TIMING_RESIDUAL_CHECK.masterFd);
    });

    it("reports ONE gap for a spawnless cycle, not the pile that follows from it", () => {
      const report = classifyTeardownTimingResidual(
        captureOf({ index: 0, launchStatus: 503, launchFailure: "backend-unavailable" }),
      );
      // Every later gap for that cycle follows from the absent spawn; naming them all would bury the one
      // fact that explains them.
      expect(report.reason).not.toContain(TIMING_RESIDUAL_CHECK.fdReleased);
      expect(report.reason).not.toContain(TIMING_RESIDUAL_CHECK.stopAnswered);
    });
  });

  describe("ordering", () => {
    it("DRIFT outranks a gap — a leak is the news even when the run also fell short of its plan", () => {
      const report = classifyTeardownTimingResidual({
        plan: { cycles: 12, maxLaunchToStopGapMs: 250 },
        cycles: [healthyCycle(0, { afterStop: { ...GONE, childPresent: true, childErrno: undefined } })],
      });
      expect(report.verdict).toBe("drift");
      expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.childReaped);
    });

    it("DRIFT outranks the pressure gap — a leak is a leak whether or not it was raced", () => {
      const report = classifyTeardownTimingResidual(
        captureOf(
          healthyCycle(0, {
            launchToStopGapMs: 900,
            afterStop: { ...GONE, childPresent: true, childErrno: undefined },
          }),
        ),
      );
      expect(report.verdict).toBe("drift");
    });
  });
});

// --- the drive's own pressure mechanics, credential-free ---

const openedFds: number[] = [];
const standIns: Server[] = [];

afterEach(async () => {
  while (openedFds.length > 0) {
    try {
      closeSync(openedFds.pop() ?? -1);
    } catch {
      // Already closed by the test — nothing to do.
    }
  }
  while (standIns.length > 0) {
    const server = standIns.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

/** A REAL open character device — what a pty master reads as, obtainable with no pty. */
function openCharacterDevice(): number {
  const fd = openSync("/dev/null", "r");
  openedFds.push(fd);
  return fd;
}

/**
 * A stand-in daemon answering the two ingresses the drive speaks to. Not a fake `@ccctl/server` — it
 * asserts nothing about the daemon and is never the receiver of record for any verdict. It exists so
 * the DRIVE's own mechanics (which cycle probes which handle, how the gap is measured, when it stops)
 * can be proven on a box with no node-pty at all.
 */
async function startStandInDaemon(answers: {
  launch: (index: number) => { status: number; body: unknown };
  stop?: (url: string) => { status: number; body: unknown };
}): Promise<{ address: { host: string; port: number } }> {
  let launches = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const answer = url.endsWith("/stop")
        ? (answers.stop ?? (() => ({ status: 200, body: { outcome: "stopped" } })))(url)
        : answers.launch(launches++);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  standIns.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stand-in daemon did not bind a port");
  }
  return { address: { host: "127.0.0.1", port: address.port } };
}

/**
 * The drive's config, with every host-touching seam pointed at a stand-in.
 *
 * Typed rather than cast: `TeardownTimingDriveConfig.server` asks only for the address it binds, so a
 * stand-in satisfies it structurally and these tests keep the typechecker on the very seams — `spawns`,
 * `plan`, `now` — that they exist to pin.
 */
function driveConfig(
  overrides: Partial<TeardownTimingDriveConfig> & Pick<TeardownTimingDriveConfig, "server" | "spawns">,
): TeardownTimingDriveConfig {
  return {
    freshCwd: () => Promise.resolve("/tmp/ccctl-timing-unit"),
    buildLaunchRequest: (cwd: string) => ({ cwd }),
    stopPath: (sessionId: string) => `/api/sessions/${sessionId}/stop`,
    buildStopRequest: () => ({}),
    // Nothing is in flight to converge to — these handles are ours and never move.
    settleTimeoutMs: 0,
    ...overrides,
  };
}

/**
 * A spawning stand-in daemon: the launch ingress PUSHES a spawn, exactly as the real one does — the
 * pty comes up during the launch, so a `spawns()` that already held it before the request would not be
 * simulating anything the drive has to cope with.
 *
 * `spawningCycles` says which cycles actually bring a pty up; any other cycle answers `201` having
 * spawned NOTHING, which is the case the stale-spawn guard exists for.
 */
async function startSpawningDaemon(
  options: {
    spawningCycles?: (index: number) => boolean;
    stop?: (url: string) => { status: number; body: unknown };
  } = {},
): Promise<{ server: { address: { host: string; port: number } }; spawns: () => Array<{ pid: number; fd: number }> }> {
  const spawns: Array<{ pid: number; fd: number }> = [];
  const spawningCycles = options.spawningCycles ?? (() => true);
  const server = await startStandInDaemon({
    launch: (index) => {
      if (spawningCycles(index)) {
        // A live child (our own pid) on a real open character device — what a pty master reads as.
        spawns.push({ pid: process.pid, fd: openCharacterDevice() });
      }
      return { status: 201, body: { sessionId: `s${index}` } };
    },
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  });
  return { server, spawns: () => spawns };
}

describe("driveTeardownTimingResidual (#70) — the drive's own pressure mechanics", () => {
  it("MEASURES the launch→stop gap on its injected clock — the drive's half of AC1's teeth", async () => {
    const { server, spawns } = await startSpawningDaemon();
    // Cycle 0 races (5ms); cycle 1 dawdles (300ms, over the 250ms ceiling).
    const ticks = [0, 5, 0, 300];
    const report = await driveTeardownTimingResidual(
      driveConfig({
        server,
        spawns,
        plan: { cycles: 2, maxLaunchToStopGapMs: 250 },
        now: () => ticks.shift() ?? 0,
      }),
    );
    expect(report.observed.maxLaunchToStopGapMs).toBe(300);
  });

  it("does NOT let a spawnless cycle inherit the previous cycle's handle — the stale-spawn guard", async () => {
    // THE property that forced this oracle to widen #68's single-slot observer. With one slot, cycle 1
    // (which spawned nothing) would read cycle 0's pid + fd and probe a handle belonging to a session
    // that is already gone — fabricating a verdict about a cycle that never opened anything. The two
    // outcomes are distinguishable: guarded, only cycle 0 is ever probed (and drifts, since these
    // handles are ours and never close); unguarded, cycle 1 drifts too, on cycle 0's handle.
    const { server, spawns } = await startSpawningDaemon({ spawningCycles: (index) => index === 0 });
    const report = await driveTeardownTimingResidual(
      driveConfig({ server, spawns, plan: { cycles: 3, maxLaunchToStopGapMs: 250 } }),
    );
    expect(report.violations.join(" ")).toContain("cycle 0");
    expect(report.violations.join(" ")).not.toContain("cycle 1");
  });

  it("STOPS driving once the backend brings no pty up — N copies of one gap buy nothing", async () => {
    const server = await startStandInDaemon({
      launch: () => ({ status: 503, body: { code: "backend-unavailable" } }),
    });
    const report = await driveTeardownTimingResidual(
      driveConfig({ server, spawns: () => [], plan: { cycles: 12, maxLaunchToStopGapMs: 250 } }),
    );
    expect(report.verdict).toBe("inconclusive");
    // The verdict stays HONEST about the shortfall rather than merely being faster.
    expect(report.observed.cycles).toBe(1);
    expect(report.reason).toContain("backend-unavailable");
  });

  it("drives EVERY planned cycle when the backend keeps spawning", async () => {
    const { server, spawns } = await startSpawningDaemon();
    const report = await driveTeardownTimingResidual(
      driveConfig({ server, spawns, plan: { cycles: 4, maxLaunchToStopGapMs: 250 } }),
    );
    expect(report.observed.cycles).toBe(4);
  });

  it("NEVER throws on a daemon that refuses the stop — it returns a verdict for the caller to dispatch on", async () => {
    const { server, spawns } = await startSpawningDaemon({
      stop: () => ({ status: 502, body: { code: "stop-failed" } }),
    });
    const report = await driveTeardownTimingResidual(
      driveConfig({ server, spawns, plan: { cycles: 1, maxLaunchToStopGapMs: 250 } }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.stopAnswered);
  });

  it("reads the handle AFTER a stop that FAILED — that is exactly when the residual is there to see", async () => {
    const { server, spawns } = await startSpawningDaemon({
      stop: () => ({ status: 502, body: { code: "stop-failed" } }),
    });
    const report = await driveTeardownTimingResidual(
      driveConfig({ server, spawns, plan: { cycles: 1, maxLaunchToStopGapMs: 250 } }),
    );
    // Our own pid is live and our own fd is open, so a probe that ran names BOTH halves of the residual
    // alongside the failed stop. A drive that skipped the after-reading would name only the stop.
    expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.childReaped);
    expect(report.violations.join(" ")).toContain(TIMING_RESIDUAL_CHECK.fdReleased);
  });

  it("reads a REAPED child as GONE and a live one as PRESENT — the drive's receiver of record", () => {
    // Guards the probe the way #68's suite guards its own: if it could not tell a reaped pid from a live
    // one, every verdict above would be worthless. Both readings are obtainable with no pty.
    const reaped = spawnSync("/bin/sh", ["-c", "exit 0"]);
    expect(reaped.status).toBe(0);
    const fd = openCharacterDevice();
    expect(readHandleState(process.pid, fd)).toMatchObject({
      childPresent: true,
      fdOpen: true,
      fdCharacterDevice: true,
    });
    expect(readHandleState(reaped.pid, fd).childPresent).toBe(false);
    closeSync(fd);
    expect(readHandleState(process.pid, fd)).toMatchObject({ fdOpen: false, fdErrno: "EBADF" });
  });
});
