// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { closeSync, openSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureHandleReport } from "@ccctl/server";
import {
  classifyDaemonSoak,
  DEFAULT_SOAK_CYCLES,
  DEFAULT_SOAK_DURATION_MS,
  describeSoakFence,
  describeSoakPlan,
  driveDaemonSoak,
  formatDuration,
  MIN_SOAK_CYCLES,
  MULTI_DAY_MS,
  resolveSoakE2EEnv,
  resolveSoakPlan,
  SOAK_BASELINE_TOLERANCE_HANDLES,
  SOAK_CHECK,
  SOAK_CYCLES_ENV,
  SOAK_DURATION_MS_ENV,
  SOAK_WARMUP_CYCLES,
  type SoakCapture,
  type SoakPlan,
  type SoakSample,
} from "./daemon-soak.js";

// The LONG-RUN DAEMON SOAK oracle's JUDGMENT (#69), proven credential-free — so it gates EVERY `test`
// run rather than only an operator's armed one. What the `CCCTL_E2E_SOAK` arm buys is the SPAN, never
// the judgment (see the module doc): the fence, the plan resolution, the tri-state classifier (the
// Tier-A encoding of both ACs), the drive's own mechanics — warmup / baseline / pacing / settling — and
// #63's sampler's own semantics are all reachable here with no daemon and no hours.
//
// The drive is exercised against INJECTED seams (a fake lifecycle, a fake sampler, a fake clock), which
// is why this package's other oracles cannot do the same: theirs need a tailnet or a native binding, so
// only their classifiers are unit-reachable. A soak needs only time, and time is an injectable seam.
//
// The REAL daemon, over real HTTP, is soaked in `daemon-soak-lifecycle.test.ts` — the hermetic skeleton
// that also carries the empirical negative control.

// --- fixtures ---

/** A settled reading, spelled by its total and (optionally) its per-type breakdown. */
function sample(cycle: number, total: number, byType: Record<string, number> = { Timeout: total }): SoakSample {
  return { cycle, total, byType };
}

/** A capture that VERIFIES — the shape every negative below perturbs exactly one field of. */
function verifiableCapture(overrides: Partial<SoakCapture> = {}): SoakCapture {
  const cycles = [sample(1, 10), sample(2, 10), sample(3, 10), sample(4, 10)];
  return {
    plan: { cycles: 4, durationMs: 0 },
    baseline: sample(0, 10),
    cycles,
    lifecyclesCompleted: 4,
    spanMs: 4_000,
    ...overrides,
  };
}

// --- the fence ---

describe("resolveSoakE2EEnv", () => {
  it("is READY only when both CCCTL_E2E and CCCTL_E2E_SOAK are set", () => {
    expect(resolveSoakE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_SOAK: "1" })).toEqual({ ready: true });
  });

  it("names every missing var rather than only the first", () => {
    expect(resolveSoakE2EEnv({})).toEqual({ ready: false, missing: ["CCCTL_E2E", "CCCTL_E2E_SOAK"] });
  });

  it("is NOT ready when only the master switch is set", () => {
    expect(resolveSoakE2EEnv({ CCCTL_E2E: "1" })).toEqual({ ready: false, missing: ["CCCTL_E2E_SOAK"] });
  });

  it("is NOT ready when only its own arm is set", () => {
    expect(resolveSoakE2EEnv({ CCCTL_E2E_SOAK: "1" })).toEqual({ ready: false, missing: ["CCCTL_E2E"] });
  });

  // The OFF spellings every fence in this package agrees on — so an operator who "turned it off" by
  // setting it to `0` gets a skip, not a multi-day soak.
  it.each(["", "0", "false", "no", "  ", "FALSE", "No"])("reads %o as OFF", (off) => {
    expect(resolveSoakE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_SOAK: off })).toEqual({
      ready: false,
      missing: ["CCCTL_E2E_SOAK"],
    });
  });

  it.each(["1", "true", "yes", "on", "anything"])("reads %o as ON", (on) => {
    expect(resolveSoakE2EEnv({ CCCTL_E2E: on, CCCTL_E2E_SOAK: on })).toEqual({ ready: true });
  });
});

describe("describeSoakFence", () => {
  it("names the arm when ready", () => {
    expect(describeSoakFence({ ready: true })).toContain("armed");
  });

  it("names what is missing when not", () => {
    expect(describeSoakFence({ ready: false, missing: ["CCCTL_E2E_SOAK"] })).toContain("CCCTL_E2E_SOAK");
  });
});

// --- the plan (AC1's two axes) ---

describe("resolveSoakPlan", () => {
  it("falls back to the defaults when the operator named nothing", () => {
    expect(resolveSoakPlan({})).toEqual({ cycles: DEFAULT_SOAK_CYCLES, durationMs: DEFAULT_SOAK_DURATION_MS });
  });

  it("takes the operator's cycles and duration", () => {
    expect(resolveSoakPlan({ [SOAK_CYCLES_ENV]: "500", [SOAK_DURATION_MS_ENV]: "172800000" })).toEqual({
      cycles: 500,
      durationMs: 172_800_000,
    });
  });

  it("resolves AC1's literal multi-day span when the operator buys it", () => {
    const plan = resolveSoakPlan({ [SOAK_DURATION_MS_ENV]: String(MULTI_DAY_MS) });
    expect(plan.durationMs).toBe(MULTI_DAY_MS);
  });

  // `Number(undefined-ish)` yields NaN, and a NaN plan would make the drive's loop run zero times and
  // report a MISSING soak instead of the misconfiguration that caused it.
  it.each(["not-a-number", "-1", "NaN", "Infinity"])("falls back rather than propagating %o", (bad) => {
    expect(resolveSoakPlan({ [SOAK_CYCLES_ENV]: bad, [SOAK_DURATION_MS_ENV]: bad })).toEqual({
      cycles: DEFAULT_SOAK_CYCLES,
      durationMs: DEFAULT_SOAK_DURATION_MS,
    });
  });

  it("floors cycles at 1 so a `0` cannot request a soak with nothing in it", () => {
    expect(resolveSoakPlan({ [SOAK_CYCLES_ENV]: "0" }).cycles).toBe(1);
  });

  it("truncates a fractional cycle count", () => {
    expect(resolveSoakPlan({ [SOAK_CYCLES_ENV]: "7.9" }).cycles).toBe(7);
  });

  it("accepts a zero duration — cycles back to back is the default, not an error", () => {
    expect(resolveSoakPlan({ [SOAK_DURATION_MS_ENV]: "0" }).durationMs).toBe(0);
  });
});

describe("describeSoakPlan", () => {
  it("renders both axes", () => {
    expect(describeSoakPlan({ cycles: 24, durationMs: MULTI_DAY_MS })).toBe("24 session lifecycle(s) across 2.00 days");
  });
});

describe("formatDuration", () => {
  it.each([
    [500, "500ms"],
    [1_500, "1.5s"],
    [90_000, "1.5min"],
    [5_400_000, "1.5h"],
    [MULTI_DAY_MS, "2.00 days"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

// --- the classifier: AC2's "returns to baseline" ---

describe("classifyDaemonSoak — verified", () => {
  it("verifies a flat series that ran its whole plan", () => {
    const report = classifyDaemonSoak(verifiableCapture());
    expect(report.verdict).toBe("verified");
    expect(report.violations).toEqual([]);
  });

  it("verifies a series that DIPS below baseline — a count that fell is not a leak", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 8), sample(2, 6), sample(3, 9), sample(4, 7)] }),
    );
    expect(report.verdict).toBe("verified");
  });

  it("verifies jitter inside the tolerance that is NOT a trend", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 10), sample(2, 11), sample(3, 10), sample(4, 11)] }),
    );
    expect(report.verdict).toBe("verified");
  });

  it("states the span it ACTUALLY achieved, so a compressed run cannot read as a multi-day claim", () => {
    const report = classifyDaemonSoak(verifiableCapture());
    expect(report.spannedMultiDay).toBe(false);
    expect(report.reason).toContain("did NOT span multiple days");
    expect(report.reason).toContain(SOAK_DURATION_MS_ENV);
  });

  it("reports spannedMultiDay when the soak genuinely spanned it (AC1, literally)", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ plan: { cycles: 4, durationMs: MULTI_DAY_MS }, spanMs: MULTI_DAY_MS + 1 }),
    );
    expect(report.verdict).toBe("verified");
    expect(report.spannedMultiDay).toBe(true);
    expect(report.reason).toContain("DID span multiple days");
  });

  it("does not round a hair under two days up into a multi-day claim", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ plan: { cycles: 4, durationMs: MULTI_DAY_MS - 1 }, spanMs: MULTI_DAY_MS - 1 }),
    );
    expect(report.spannedMultiDay).toBe(false);
  });
});

describe("classifyDaemonSoak — drift (AC2: the count must return to baseline)", () => {
  it("catches an accumulation past tolerance, naming the FIRST cycle to cross", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 10), sample(2, 11), sample(3, 14), sample(4, 18)] }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(true);
    // Cycle 3 is the first at +4 > tolerance 2; cycle 2 at +1 is inside it.
    expect(report.violations.join(" ")).toContain("cycle 3");
  });

  it("does NOT fire while the series stays inside tolerance", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 12), sample(2, 12), sample(3, 12), sample(4, 12)] }),
    );
    expect(report.verdict).toBe("verified");
  });

  it("honors a caller-supplied tolerance", () => {
    const cycles = [sample(1, 13), sample(2, 13), sample(3, 13), sample(4, 13)];
    expect(classifyDaemonSoak(verifiableCapture({ cycles })).verdict).toBe("drift");
    expect(classifyDaemonSoak(verifiableCapture({ cycles, toleranceHandles: 5 })).verdict).toBe("verified");
  });

  // THE masked-leak case, and the whole reason the per-type detector exists: a leaked `Timeout` while a
  // pooled socket happens to close nets to ZERO on the total. A total-only oracle reads this clean.
  it("catches a leak the TOTAL masks, because one type grew while another shrank", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        baseline: sample(0, 10, { Timeout: 5, TCPSocketWrap: 5 }),
        cycles: [
          sample(1, 10, { Timeout: 6, TCPSocketWrap: 4 }),
          sample(2, 10, { Timeout: 7, TCPSocketWrap: 3 }),
          sample(3, 10, { Timeout: 8, TCPSocketWrap: 2 }),
          sample(4, 10, { Timeout: 9, TCPSocketWrap: 1 }),
        ],
      }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.typeGrowth))).toBe(true);
    expect(report.violations.join(" ")).toContain("`Timeout`");
    // The total never moved, so the baseline-return check is silent — only per-type saw it.
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(false);
  });

  it("catches a leak in a type the daemon never held at rest (absent from baseline = baseline 0)", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        baseline: sample(0, 5, { Timeout: 5 }),
        cycles: [
          sample(1, 6, { Timeout: 5, PipeWrap: 1 }),
          sample(2, 8, { Timeout: 5, PipeWrap: 3 }),
          sample(3, 10, { Timeout: 5, PipeWrap: 5 }),
          sample(4, 12, { Timeout: 5, PipeWrap: 7 }),
        ],
      }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain("`PipeWrap`");
  });

  it("does not fire per-type on a type that only SHRANK", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        baseline: sample(0, 10, { Timeout: 5, TCPSocketWrap: 5 }),
        cycles: [
          sample(1, 8, { Timeout: 5, TCPSocketWrap: 3 }),
          sample(2, 7, { Timeout: 5, TCPSocketWrap: 2 }),
          sample(3, 6, { Timeout: 5, TCPSocketWrap: 1 }),
          sample(4, 5, { Timeout: 5 }),
        ],
      }),
    );
    expect(report.verdict).toBe("verified");
  });
});

describe("classifyDaemonSoak — drift (AC2: no monotonic growth)", () => {
  // THE case this detector exists for, and the one a STRICT-increase predicate silently missed: a leak of
  // one handle every five lifecycles. It never gets more than +1 over baseline, so `baselineReturn` is
  // silent for the whole compressed run — but the count climbs and never comes back, which over the
  // multi-day run AC1 describes is what eventually exhausts the host.
  it("catches a leak of ONE handle per five cycles — a climb that never exceeds tolerance", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        plan: { cycles: 8, durationMs: 0 },
        baseline: sample(0, 8),
        lifecyclesCompleted: 8,
        cycles: [
          sample(1, 8),
          sample(2, 8),
          sample(3, 8),
          sample(4, 8),
          sample(5, 9),
          sample(6, 9),
          sample(7, 9),
          sample(8, 9),
        ],
      }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.monotonic))).toBe(true);
    // +1 never clears the tolerance of 2, so the accumulation detector cannot see this at THIS length —
    // which is precisely why the trend detector must, and why it carries no tolerance of its own.
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(false);
  });

  // The same leak at the DEFAULT plan's length, one handle every twelve cycles. Pinned separately
  // because a detector that only works at one series length is a detector tuned to its own fixture.
  it("catches a leak of ONE handle per twelve cycles at the default plan's length", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        plan: { cycles: 24, durationMs: 0 },
        baseline: sample(0, 8),
        lifecyclesCompleted: 24,
        cycles: Array.from({ length: 24 }, (_, index) => sample(index + 1, index < 12 ? 8 : 9)),
      }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.monotonic))).toBe(true);
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(false);
  });

  it("catches a climb that rises on every cycle (the fast case the accumulation detector also sees)", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 9), sample(2, 10), sample(3, 11), sample(4, 12)] }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.startsWith(SOAK_CHECK.monotonic))).toBe(true);
  });

  // The boundary the predicate turns on: a series that comes back DOWN even once is not monotonic growth.
  // A plateau is NOT a reversal — a leak slower than one-per-cycle is mostly plateau, so treating one as
  // jitter is exactly how the strict predicate went blind.
  it("does NOT fire when the series comes back down — that is jitter, not a trend", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 9), sample(2, 10), sample(3, 9), sample(4, 11)] }),
    );
    expect(report.verdict).toBe("verified");
  });

  it("does not read a flat series as a climb", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ cycles: [sample(1, 10), sample(2, 10), sample(3, 10), sample(4, 10)] }),
    );
    expect(report.verdict).toBe("verified");
  });

  // The real daemon's own measured series (20 settled cycles read `8` every time, `byType` identical).
  // The detector firing on THIS would make every skeleton run a red — the flake case, pinned.
  it("does not read the real daemon's measured flat series as a climb", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        plan: { cycles: 8, durationMs: 0 },
        baseline: sample(0, 8, { PipeWrap: 4, TCPServerWrap: 1, TCPSocketWrap: 3 }),
        lifecyclesCompleted: 8,
        cycles: Array.from({ length: 8 }, (_, index) =>
          sample(index + 1, 8, { PipeWrap: 4, TCPServerWrap: 1, TCPSocketWrap: 3 }),
        ),
      }),
    );
    expect(report.verdict).toBe("verified");
  });

  it("needs a real series before calling a climb a trend", () => {
    // Climbing, but under MIN_SOAK_CYCLES — the honest answer is `inconclusive` (too short), never a
    // `drift` read off noise.
    const report = classifyDaemonSoak(
      verifiableCapture({ plan: { cycles: 2, durationMs: 0 }, cycles: [sample(1, 9), sample(2, 10)] }),
    );
    expect(report.verdict).toBe("inconclusive");
  });
});

describe("classifyDaemonSoak — inconclusive (skips, never fakes)", () => {
  it("cannot verify a soak that declared no plan", () => {
    const report = classifyDaemonSoak({ ...verifiableCapture(), plan: undefined });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(SOAK_CHECK.plan);
  });

  it("cannot verify without a post-warmup baseline — 'returns to baseline' has no referent", () => {
    const report = classifyDaemonSoak({ ...verifiableCapture(), baseline: undefined });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(SOAK_CHECK.baseline);
  });

  it("cannot verify with no cycle measured", () => {
    const report = classifyDaemonSoak({ ...verifiableCapture(), cycles: [] });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(SOAK_CHECK.series);
  });

  it("cannot verify a series too short to be a trend", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ plan: { cycles: 3, durationMs: 0 }, cycles: [sample(1, 10), sample(2, 10), sample(3, 10)] }),
    );
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(`fewer than the ${MIN_SOAK_CYCLES}`);
  });

  // AC1 is STRUCTURAL, not a convention: a soak cut short cannot report "no leak over a long run",
  // because it did not have one.
  it("cannot verify a soak cut short of its declared cycles", () => {
    const report = classifyDaemonSoak(verifiableCapture({ plan: { cycles: 500, durationMs: 0 } }));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("cut short");
    expect(report.reason).toContain("4 of the planned 500");
  });

  it("cannot verify a soak that fell short of its declared SPAN", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({ plan: { cycles: 4, durationMs: MULTI_DAY_MS }, spanMs: 4_000 }),
    );
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("did not run for as long as it claimed to");
  });

  it("cannot verify readings with no lifecycle behind them", () => {
    const report = classifyDaemonSoak(verifiableCapture({ lifecyclesCompleted: 2 }));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("only 2 lifecycle(s) completed");
  });

  it("cannot verify when a lifecycle could not run at all", () => {
    const report = classifyDaemonSoak(verifiableCapture({ lifecycleFailure: "launch answered 503" }));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("launch answered 503");
  });

  it("cannot verify without a recorded span", () => {
    const report = classifyDaemonSoak({ ...verifiableCapture(), spanMs: undefined });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(SOAK_CHECK.span);
  });
});

describe("classifyDaemonSoak — drift outranks an inconclusive gap", () => {
  // The package-wide ordering: a leak that was OBSERVED is reported as a leak, even though the soak also
  // fell short. A present-but-wrong observation is never masked by a missing leg.
  it("reports an observed leak over a soak that was also cut short", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        plan: { cycles: 500, durationMs: MULTI_DAY_MS },
        cycles: [sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 40)],
      }),
    );
    expect(report.verdict).toBe("drift");
  });

  it("reports an observed leak even when the lifecycle then failed", () => {
    const report = classifyDaemonSoak(
      verifiableCapture({
        cycles: [sample(1, 10), sample(2, 20)],
        lifecycleFailure: "the daemon stopped answering",
      }),
    );
    expect(report.verdict).toBe("drift");
  });
});

// --- the drive's own mechanics, against injected seams ---

/** A clock whose `sleep` is what advances it — so pacing and span are provable without spending them. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let ms = 1_000_000;
  const start = ms;
  return {
    now: () => ms,
    sleep: async (waitMs: number): Promise<void> => {
      ms += waitMs;
    },
    elapsed: () => ms - start,
  };
}

/** A sampler returning a fixed tally — so every reading is equal and the settle converges immediately. */
function fixedSampler(types: readonly string[]): () => readonly string[] {
  return () => types;
}

describe("driveDaemonSoak", () => {
  const plan: SoakPlan = { cycles: 4, durationMs: 0 };

  it("runs the warmup lifecycles BEFORE the measured ones, and discards them", async () => {
    const seen: number[] = [];
    const report = await driveDaemonSoak({
      plan,
      lifecycle: async (cycle) => {
        seen.push(cycle);
      },
      sample: fixedSampler(["Timeout"]),
      ...fakeClock(),
    });
    expect(report.verdict).toBe("verified");
    // Warmup cycles are numbered negatively and precede every measured cycle.
    expect(seen).toEqual([-1, -2, 1, 2, 3, 4]);
    expect(seen.filter((cycle) => cycle < 0)).toHaveLength(SOAK_WARMUP_CYCLES);
  });

  it("honors a caller-supplied warmup count", async () => {
    const seen: number[] = [];
    await driveDaemonSoak({
      plan,
      warmupCycles: 5,
      lifecycle: async (cycle) => {
        seen.push(cycle);
      },
      sample: fixedSampler(["Timeout"]),
      ...fakeClock(),
    });
    expect(seen.filter((cycle) => cycle < 0)).toHaveLength(5);
  });

  it("takes one settled reading per measured cycle", async () => {
    const report = await driveDaemonSoak({
      plan,
      lifecycle: async () => undefined,
      sample: fixedSampler(["Timeout", "TCPServerWrap"]),
      ...fakeClock(),
    });
    expect(report.verdict).toBe("verified");
    expect(report.reason).toContain("4 session lifecycle(s)");
  });

  it("paces its cycles across the declared duration rather than racing through them", async () => {
    const clock = fakeClock();
    const report = await driveDaemonSoak({
      plan: { cycles: 4, durationMs: 40_000 },
      lifecycle: async () => undefined,
      sample: fixedSampler(["Timeout"]),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(report.verdict).toBe("verified");
    // The declared span was actually spent — the classifier's span gate would otherwise refuse it.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(40_000);
  });

  it("spends a multi-day plan's whole span, and says so — AC1, on an injected clock", async () => {
    const clock = fakeClock();
    const report = await driveDaemonSoak({
      plan: { cycles: MIN_SOAK_CYCLES, durationMs: MULTI_DAY_MS },
      lifecycle: async () => undefined,
      sample: fixedSampler(["Timeout"]),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(report.verdict).toBe("verified");
    expect(report.spannedMultiDay).toBe(true);
    expect(report.reason).toContain("DID span multiple days");
    expect(clock.elapsed()).toBeGreaterThanOrEqual(MULTI_DAY_MS);
  });

  it("reports `inconclusive` — never a green — when a measured lifecycle throws", async () => {
    const report = await driveDaemonSoak({
      plan,
      lifecycle: async (cycle) => {
        if (cycle === 3) {
          throw new Error("the daemon answered 500");
        }
      },
      sample: fixedSampler(["Timeout"]),
      ...fakeClock(),
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("the daemon answered 500");
  });

  it("reports `inconclusive` when the WARMUP itself cannot run — the soak never started", async () => {
    const report = await driveDaemonSoak({
      plan,
      lifecycle: async () => {
        throw new Error("no launcher configured");
      },
      sample: fixedSampler(["Timeout"]),
      ...fakeClock(),
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain("no launcher configured");
  });

  it("never throws on a leak — it returns `drift` for the caller's switch to act on", async () => {
    // A sampler that grows by one handle per read: the leaking daemon, in miniature.
    let handles = 4;
    const report = await driveDaemonSoak({
      plan: { cycles: 6, durationMs: 0 },
      lifecycle: async () => {
        handles += 3;
      },
      sample: () => new Array<string>(handles).fill("Timeout"),
      ...fakeClock(),
    });
    expect(report.verdict).toBe("drift");
    expect(report.violations.length).toBeGreaterThan(0);
  });

  // The lifecycle's own failure has two tests above; the SAMPLER's is the other way a reading can go
  // missing, and it must land the same way. #63's `captureHandleReport` never throws — it catches and
  // reports `ok: false` — so a sampler that cannot read leaves the drive with no baseline and no series
  // at all, which is a question that was never asked rather than a leak that was not there.
  it("reports `inconclusive` when the SAMPLER itself fails — a reading that was never taken is not a green", async () => {
    const report = await driveDaemonSoak({
      plan,
      lifecycle: async () => undefined,
      sample: () => {
        throw new Error("getActiveResourcesInfo is unavailable");
      },
      ...fakeClock(),
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(SOAK_CHECK.baseline);
    expect(report.reason).toContain(SOAK_CHECK.series);
  });
});

// --- #63's sampler: what it can and CANNOT see ---

/** The report or a thrown explanation — the outcome's failure branch is not this suite's subject. */
function handleReport(): { total: number; byType: Readonly<Record<string, number>> } {
  const outcome = captureHandleReport();
  if (!outcome.ok) {
    throw new Error(`ccctl e2e: the handle sampler failed: ${outcome.reason}`);
  }
  return outcome.report;
}

// The oracle's SCOPE BOUNDARY, pinned as a test rather than only as prose — because prose drifts and
// this boundary is the one thing a reader could over-read the verdict into. #63's endpoint tallies the
// libuv resources keeping the event loop alive, so it sees the vectors this daemon leaks through and
// does NOT see a raw file descriptor. That is not a defect in either oracle: it is exactly the division
// of labour between this one and #68's, which asks the kernel about ONE descriptor with `fstat`.
describe("captureHandleReport (#63) — the vectors this oracle can see", () => {
  it("counts a ref'd libuv handle — the daemon's own liveness timer is one of these", () => {
    const before = handleReport().byType.Timeout ?? 0;
    const timer = setInterval(() => undefined, 60_000);
    try {
      expect((handleReport().byType.Timeout ?? 0) - before).toBe(1);
    } finally {
      clearInterval(timer);
    }
  });

  it("stops counting it once it is cleared — a retired handle really does leave the tally", () => {
    const before = handleReport().byType.Timeout ?? 0;
    const timer = setInterval(() => undefined, 60_000);
    clearInterval(timer);
    expect((handleReport().byType.Timeout ?? 0) - before).toBe(0);
  });

  it("does NOT count an UNREF'd handle — it is not keeping the loop alive", () => {
    const before = handleReport().byType.Timeout ?? 0;
    const timer = setInterval(() => undefined, 60_000);
    timer.unref();
    try {
      expect((handleReport().byType.Timeout ?? 0) - before).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("captureHandleReport (#63) — the boundary this oracle must not be read past", () => {
  it("does NOT count bare file descriptors, so a raw fd leak is #68's question, not this one", () => {
    const opened: number[] = [];
    const before = handleReport().total;
    try {
      // Far more than any plausible background churn: if bare fds were counted at all, the delta would
      // be ~64. It is not — the tally does not move with them.
      for (let i = 0; i < 64; i += 1) {
        opened.push(openSync("/dev/null", "r"));
      }
      expect(handleReport().total - before).toBeLessThan(8);
    } finally {
      for (const fd of opened) {
        closeSync(fd);
      }
    }
  });
});

describe("the tolerance is a jitter margin, not a leak allowance", () => {
  // A per-cycle leak of ONE handle — the smallest there is — clears the tolerance within a few cycles
  // and is caught by the ACCUMULATION detector, not merely by the trend one. This is what keeps
  // SOAK_BASELINE_TOLERANCE_HANDLES from being a number anyone has to tune: no leak fits under it for
  // long. Named per cycle rather than asserted as a bare `drift`, because "the trend detector caught
  // it" would pass this too and would say nothing about the tolerance.
  it("catches the smallest possible leak — one handle per cycle — on the ACCUMULATION detector", () => {
    const cycles = Array.from({ length: 8 }, (_, index) => sample(index + 1, 10 + index + 1));
    const capture = verifiableCapture({ plan: { cycles: 8, durationMs: 0 }, lifecyclesCompleted: 8, cycles });
    const result = classifyDaemonSoak(capture);
    expect(result.verdict).toBe("drift");
    expect(result.violations.some((v) => v.startsWith(SOAK_CHECK.baselineReturn))).toBe(true);
    // The cycle it is caught on is DERIVED from the tolerance rather than written down, so raising the
    // tolerance moves this expectation with it instead of silently weakening the test: at one handle
    // per cycle the delta is the cycle number, so the first to EXCEED the tolerance is tolerance + 1.
    // That is the exact number of cycles of cover the tolerance buys a leak — and all it buys.
    expect(result.violations.join(" ")).toContain(`cycle ${SOAK_BASELINE_TOLERANCE_HANDLES + 1}`);
  });
});
