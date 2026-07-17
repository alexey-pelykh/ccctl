// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LogEvent, Logger } from "@ccctl/core";
import {
  captureHandleReport,
  captureTimerCensus,
  formatHandleReport,
  formatTimerCensusReport,
  installInspectorDiagnosticsSignalHandler,
  installTimerCensus,
  openInspector,
  INSPECTOR_DIAGNOSTICS_HOST,
  INSPECTOR_DIAGNOSTICS_SIGNAL,
  type HandleReport,
  type InspectorController,
  type TimerCensus,
  type TimerCensusReport,
} from "./inspector-diagnostics.js";
// `SignalSource` is the shared process-signal seam, owned by the heap-snapshot module (#62) and
// imported by inspector-diagnostics from there — so the test sources the type from the same home.
import { type SignalSource } from "./heap-snapshot.js";

/** A capturing log sink — the fake every emission test asserts against. */
function capturingLogger(): { logger: Logger; captured: LogEvent[] } {
  const captured: LogEvent[] = [];
  return { logger: { log: (event) => captured.push(event) }, captured };
}

/**
 * A fake `node:inspector`: tracks every `open` call and flips its reported `url` to a synthetic
 * loopback ws:// on open. `initialUrl` seeds the "already open" case; `openError` makes `open` throw
 * (the ERR_INSPECTOR_ALREADY_ACTIVATED race); `urlAfterOpen: null` makes `url` stay undefined even
 * after a "successful" open (the defensive no-URL case).
 */
function fakeInspector(options: { initialUrl?: string; openError?: Error; urlAfterOpen?: string | null } = {}): {
  controller: InspectorController;
  opens: Array<{ port: number; host: string; wait: boolean }>;
} {
  let current = options.initialUrl;
  const opens: Array<{ port: number; host: string; wait: boolean }> = [];
  return {
    controller: {
      url: () => current,
      open: (port, host, wait) => {
        opens.push({ port, host, wait });
        if (options.openError !== undefined) {
          throw options.openError;
        }
        current = options.urlAfterOpen === null ? undefined : (options.urlAfterOpen ?? `ws://${host}:${port}/fake-id`);
      },
    },
    opens,
  };
}

describe("formatHandleReport", () => {
  // Rule: the line names the total, then a per-type breakdown sorted by type name so it is
  // deterministic and diffable across successive samples (a climbing type count = a leak).
  it("renders a sorted total — type=count, … tally", () => {
    const report: HandleReport = { total: 4, byType: { Timeout: 2, TCPServerWrap: 1, PipeWrap: 1 } };
    expect(formatHandleReport(report)).toBe("4 active libuv resources — PipeWrap=1, TCPServerWrap=1, Timeout=2");
  });

  it("renders just the total when nothing is active", () => {
    expect(formatHandleReport({ total: 0, byType: {} })).toBe("0 active libuv resources");
  });
});

describe("captureHandleReport", () => {
  // Rule: a sample tallies the active libuv resources by type and rides the trail as a
  // diagnostic/handle-report info line carrying ONLY counts (never a credential).
  it("tallies the sampled resources and records a diagnostic/handle-report info event", () => {
    const { logger, captured } = capturingLogger();
    const outcome = captureHandleReport({
      sample: () => ["TCPServerWrap", "Timeout", "Timeout", "TTYWrap"],
      logger,
    });

    expect(outcome).toEqual({
      ok: true,
      report: { total: 4, byType: { TCPServerWrap: 1, Timeout: 2, TTYWrap: 1 } },
    });
    expect(captured).toEqual([
      {
        category: "diagnostic",
        level: "info",
        event: "handle-report",
        sessionId: null,
        detail: "4 active libuv resources — TCPServerWrap=1, TTYWrap=1, Timeout=2",
      },
    ]);
  });

  // Rule: a failed sample must NOT throw (it would take a struggling daemon down) — the error is
  // caught, recorded as diagnostic/handle-report-failed at error level, and returned.
  it("never throws on a sample failure — it records a handle-report-failed error and returns the reason", () => {
    const { logger, captured } = capturingLogger();
    let outcome: ReturnType<typeof captureHandleReport> | undefined;
    expect(() => {
      outcome = captureHandleReport({
        sample: () => {
          throw new Error("getActiveResourcesInfo exploded");
        },
        logger,
      });
    }).not.toThrow();

    expect(outcome).toEqual({ ok: false, reason: "getActiveResourcesInfo exploded" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      category: "diagnostic",
      level: "error",
      event: "handle-report-failed",
      sessionId: null,
    });
    expect((captured[0] as { detail: string }).detail).toContain("getActiveResourcesInfo exploded");
  });

  it("defaults the logger to a no-op sink (no crash when none is injected)", () => {
    const outcome = captureHandleReport({ sample: () => [] });
    expect(outcome).toEqual({ ok: true, report: { total: 0, byType: {} } });
  });

  // Rule (AC1): the default sampler reads the LIVE process's active libuv resources — observed by
  // proving a real sample returns a plausible report with no injected fake.
  it("samples the real live process by default", () => {
    const outcome = captureHandleReport();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.total).toBe(Object.values(outcome.report.byType).reduce((a, b) => a + b, 0));
  });
});

/**
 * A fake census — a canned series of readings, one per `sample()` call, plus a disposal spy. Stands in
 * wherever the census's WIRING is under test rather than its measurement, so no real `async_hooks` hook
 * is enabled in the test process.
 */
function fakeCensus(readings: readonly TimerCensusReport[]): { census: TimerCensus; disposals: number } {
  let index = 0;
  let disposals = 0;
  const census: TimerCensus = {
    sample: () => readings[Math.min(index++, readings.length - 1)] ?? { total: 0, refd: 0, unrefd: 0 },
    dispose: () => {
      disposals += 1;
    },
  };
  return {
    census,
    get disposals() {
      return disposals;
    },
  };
}

describe("formatTimerCensusReport", () => {
  // Rule: the line LEADS with the unref'd count — the number the census exists for — then the ref'd
  // remainder, which cross-checks against handle-report's own Timeout tally.
  it("renders a total — unref'd, ref'd tally", () => {
    expect(formatTimerCensusReport({ total: 5, refd: 2, unrefd: 3 })).toBe("5 live timers — unref'd=3, ref'd=2");
  });

  // Rule: the ARMING poke's reading is ~0 for a reason the operator must not have to infer — async_hooks
  // reports nothing it was not yet listening for. Saying so inline is what stops a meaningless first `0`
  // being read as "this daemon holds no timers".
  it("marks the arming poke's reading so a meaningless first 0 cannot be misread", () => {
    expect(formatTimerCensusReport({ total: 0, refd: 0, unrefd: 0 }, true)).toBe(
      "0 live timers — unref'd=0, ref'd=0 (census just armed — timers predating this poke are untracked; poke again to read an accumulation)",
    );
  });
});

/**
 * #63's ref'd sampler's own `Timeout` tally — what the diagnostics report TODAY, and the series #69's
 * soak reads. The census's whole claim is a comparison against this number, so it is read through the
 * real {@link captureHandleReport} rather than restated.
 *
 * Absolute readings here are NOT zero and must never be asserted as such: the sample is PROCESS-WIDE, so
 * the test runner's own ref'd timers ride it. What is deterministic — and what AC2 actually claims — is
 * that it stays FLAT while a leak accumulates. Within a synchronous block that is exact rather than
 * hopeful: the event loop cannot turn, so no ambient timer can arm or fire mid-assertion.
 */
function refdTimeoutTally(): number {
  const outcome = captureHandleReport();
  if (!outcome.ok) {
    throw new Error(`ref'd sampler failed: ${outcome.reason}`);
  }
  return outcome.report.byType.Timeout ?? 0;
}

/**
 * Yield until `async_hooks` has fired its pending `destroy` hooks. Needed because `destroy` lands on a
 * LATER loop turn than the `clearInterval` that causes it (see {@link TimerCensus.sample}), so a
 * synchronous assertion would read a cleared timer as still live.
 *
 * Measured at ONE `setImmediate` on this repo's Node; two are yielded for margin. A margin is safe here
 * in the one direction that matters — too few turns fails LOUDLY (the census reads a cleared timer as
 * live), never silently greens — and `setImmediate` inits an `Immediate`, never a `Timeout`, so the
 * settling cannot pollute the census it is settling.
 */
async function settleDestroyHooks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("installTimerCensus", () => {
  // Rule (AC1): the census sees an UNREF'D timer — the whole point — and the ref'd sampler does not move
  // at all for the same timer, which is the gap being closed. Run against the REAL async_hooks: a fake
  // here would prove nothing about whether the CHOSEN API actually sees these timers.
  it("counts an unref'd timer as unref'd, where the ref'd sampler does not move at all", () => {
    const census = installTimerCensus();
    try {
      const refdBefore = refdTimeoutTally();
      const leaked = setInterval(() => undefined, 60_000);
      leaked.unref();
      try {
        // The census sees it.
        expect(census.sample()).toEqual({ total: 1, refd: 0, unrefd: 1 });
        // #63's own sampler does not — asserted as a DELTA, because the absolute tally carries the
        // runner's own ambient timers. Exact, not hopeful: this block is synchronous.
        expect(refdTimeoutTally()).toBe(refdBefore);
      } finally {
        clearInterval(leaked);
      }
    } finally {
      census.dispose();
    }
  });

  // Rule: ref-state is read at SAMPLE time, not at `init` — load-bearing, because the daemon arms a
  // timer and calls `.unref()` on the NEXT line. An init-time read would call every one of them ref'd
  // and the census would report the exact opposite of the truth.
  it("reads ref-state at sample time, so an arm-then-unref timer reads unref'd", () => {
    const census = installTimerCensus();
    try {
      // The daemon's exact shape: armed, THEN unref'd on the following line.
      const timer = setInterval(() => undefined, 60_000);
      expect(census.sample()).toMatchObject({ refd: 1, unrefd: 0 });
      timer.unref();
      expect(census.sample()).toMatchObject({ refd: 0, unrefd: 1 });
      clearInterval(timer);
    } finally {
      census.dispose();
    }
  });

  // Rule: a cleared timer leaves the census — otherwise every faithful cycle would read as a leak and the
  // oracle would be useless. `destroy` does the dropping, on a LATER loop turn (hence the settle).
  it("drops a timer once it is cleared", async () => {
    const census = installTimerCensus();
    try {
      const timer = setInterval(() => undefined, 60_000);
      timer.unref();
      expect(census.sample().total).toBe(1);
      clearInterval(timer);
      await settleDestroyHooks();
      expect(census.sample().total).toBe(0);
    } finally {
      census.dispose();
    }
  });

  // Rule: a one-shot that FIRES leaves the census too — the sibling of the rule above, and the one that
  // matters most in production. Every unref'd timer the daemon arms is a one-shot whose NORMAL end is
  // firing, not being cleared: the #33 pending-launch eviction, the #41 idle check, the #173 eviction
  // grace. Were only the cleared path pruned, every healthy session would strand a fired one-shot in the
  // census and the oracle would report a FALSE accumulation on a FAITHFUL daemon — inverting what it
  // means while the cleared-timer test above stayed green. Pinned separately for exactly that reason.
  it("drops a one-shot once it has fired", async () => {
    const census = installTimerCensus();
    try {
      let fired = false;
      const oneShot = setTimeout(() => {
        fired = true;
      }, 1);
      oneShot.unref();
      expect(census.sample().unrefd).toBe(1);

      // A ref'd anchor is what lets the loop turn long enough for the unref'd one-shot to fire: an unref'd
      // timer cannot hold the loop open by itself — which is the very property that hides it from #63's
      // sampler. The anchor is ref'd, so it lands in `refd` and never in the `unrefd` count asserted here.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settleDestroyHooks();

      expect(fired).toBe(true);
      expect(census.sample().unrefd).toBe(0);
    } finally {
      census.dispose();
    }
  });

  // Rule: the disposer stops tracking — a census that outlived its handler would be one more leak in a
  // module whose whole job is finding leaks.
  it("stops tracking after dispose", () => {
    const census = installTimerCensus();
    census.dispose();
    const timer = setInterval(() => undefined, 60_000);
    timer.unref();
    expect(census.sample()).toEqual({ total: 0, refd: 0, unrefd: 0 });
    clearInterval(timer);
  });
});

/**
 * AC2 — the NEGATIVE CONTROL. A census that reported a leak it imagined would be worse than none, so the
 * probe is proven against an accumulation that is really there: a stand-in strands exactly one UNREF'D
 * timer per cycle, the census must climb 1:1 with it, and #63's existing ref'd sampler — the one that
 * misses it today — must read FLAT across the identical run.
 *
 * Real `async_hooks` and real timers throughout: the claim is about what the CHOSEN API can see, which a
 * fake census would assert nothing about.
 */
describe("installTimerCensus — negative control (AC2)", () => {
  const CYCLES = 5;

  it("reports a stranded-unref'd-timer accumulation 1:1 while the ref'd sampler reads flat", () => {
    const census = installTimerCensus();
    const stranded: NodeJS.Timeout[] = [];
    try {
      const censusSeries: number[] = [];
      const refdSeries: number[] = [];

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        // The leak, stood in for: a cycle that arms an unref'd timer and never clears it — a
        // `reapWorkerChannel` that missed a `clearInterval`, say.
        const leaked = setInterval(() => undefined, 60_000);
        leaked.unref();
        stranded.push(leaked);

        censusSeries.push(census.sample().unrefd);
        refdSeries.push(refdTimeoutTally());
      }

      // The census sees it: one per cycle, climbing 1:1 with the strand.
      expect(censusSeries).toEqual([1, 2, 3, 4, 5]);
      // The existing ref'd sampler does NOT — FLAT across the identical run, which is AC2's own word and
      // the honest claim. Not flat at ZERO: the sample is process-wide, so the runner's own ref'd timers
      // sit in the baseline; asserting 0 would be asserting something about vitest, not about the leak.
      // Flatness is what indicts the ref'd sampler, and this whole loop is synchronous, so it is exact.
      expect(refdSeries).toEqual(Array<number>(CYCLES).fill(refdSeries[0] as number));
      // Guard the guard: a series that was flat because the census never moved would prove nothing.
      expect(censusSeries[CYCLES - 1]).toBe(CYCLES);
    } finally {
      stranded.forEach(clearInterval);
      census.dispose();
    }
  });

  // The control's own control: a FAITHFUL cycle (one that clears what it arms) must read flat, or the
  // detector above would be firing on the CYCLE rather than on the LEAK — and a detector that fires
  // either way detects nothing.
  it("reads flat across a faithful cycle that clears what it arms", async () => {
    const census = installTimerCensus();
    try {
      const series: number[] = [];
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const timer = setInterval(() => undefined, 60_000);
        timer.unref();
        clearInterval(timer);
        await settleDestroyHooks();
        series.push(census.sample().unrefd);
      }
      expect(series).toEqual([0, 0, 0, 0, 0]);
    } finally {
      census.dispose();
    }
  });
});

describe("captureTimerCensus", () => {
  // Rule (AC1): the census rides the trail as its OWN diagnostic/timer-census info line — ALONGSIDE
  // handle-report, never merged into it, so HandleReport's contract and #69's baseline semantics are
  // untouched.
  it("records a diagnostic/timer-census info line carrying only counts", () => {
    const { logger, captured } = capturingLogger();
    const { census } = fakeCensus([{ total: 3, refd: 1, unrefd: 2 }]);

    const outcome = captureTimerCensus({ census, logger });

    expect(outcome).toEqual({ ok: true, report: { total: 3, refd: 1, unrefd: 2 } });
    expect(captured).toEqual([
      {
        category: "diagnostic",
        level: "info",
        event: "timer-census",
        sessionId: null,
        detail: "3 live timers — unref'd=2, ref'd=1",
      },
    ]);
  });

  it("marks the arming poke's line when justArmed is set", () => {
    const { logger, captured } = capturingLogger();
    const { census } = fakeCensus([{ total: 0, refd: 0, unrefd: 0 }]);

    captureTimerCensus({ census, logger, justArmed: true });

    expect((captured[0] as { detail: string }).detail).toContain("census just armed");
  });

  // Rule: a failed census must NOT throw — same discipline as its sibling sampler; a struggling daemon
  // must not be taken down by the diagnostic sent to diagnose it.
  it("never throws on a sample failure — it records timer-census-failed and returns the reason", () => {
    const { logger, captured } = capturingLogger();
    const census: TimerCensus = {
      sample: () => {
        throw new Error("hook exploded");
      },
      dispose: () => undefined,
    };

    let outcome: ReturnType<typeof captureTimerCensus> | undefined;
    expect(() => {
      outcome = captureTimerCensus({ census, logger });
    }).not.toThrow();

    expect(outcome).toEqual({ ok: false, reason: "hook exploded" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      category: "diagnostic",
      level: "error",
      event: "timer-census-failed",
      sessionId: null,
    });
    expect((captured[0] as { detail: string }).detail).toContain("hook exploded");
  });

  it("defaults the logger to a no-op sink (no crash when none is injected)", () => {
    const { census } = fakeCensus([{ total: 1, refd: 0, unrefd: 1 }]);
    expect(captureTimerCensus({ census }).ok).toBe(true);
  });
});

describe("openInspector", () => {
  // Rule (AC2 + AC3): when the inspector is not yet open, it is opened bound to LOOPBACK, and its
  // ws:// URL rides the trail as diagnostic/inspector-open (info).
  it("opens the inspector on loopback and records the ws:// URL", () => {
    const { logger, captured } = capturingLogger();
    const { controller, opens } = fakeInspector();

    const outcome = openInspector({ controller, logger });

    expect(opens).toEqual([{ port: 0, host: INSPECTOR_DIAGNOSTICS_HOST, wait: false }]);
    expect(outcome).toEqual({ ok: true, url: `ws://${INSPECTOR_DIAGNOSTICS_HOST}:0/fake-id`, alreadyOpen: false });
    expect(captured).toEqual([
      {
        category: "diagnostic",
        level: "info",
        event: "inspector-open",
        sessionId: null,
        detail: `ws://${INSPECTOR_DIAGNOSTICS_HOST}:0/fake-id`,
      },
    ]);
  });

  // Rule: inspector.open() is NOT idempotent (it throws once active). If the inspector is ALREADY
  // open — Node's own SIGUSR1 auto-open, or a prior poke — report the existing URL and do NOT re-open.
  it("reports the existing URL without re-opening when the inspector is already active", () => {
    const { logger, captured } = capturingLogger();
    const { controller, opens } = fakeInspector({ initialUrl: "ws://127.0.0.1:9229/existing" });

    const outcome = openInspector({ controller, logger });

    expect(opens).toEqual([]); // never re-opened
    expect(outcome).toEqual({ ok: true, url: "ws://127.0.0.1:9229/existing", alreadyOpen: true });
    expect(captured).toEqual([
      {
        category: "diagnostic",
        level: "info",
        event: "inspector-open",
        sessionId: null,
        detail: "ws://127.0.0.1:9229/existing",
      },
    ]);
  });

  // Rule: a failed open must NOT throw — the error (e.g. ERR_INSPECTOR_ALREADY_ACTIVATED from a race)
  // is caught, recorded as diagnostic/inspector-open-failed at error level, and returned.
  it("never throws on an open failure — it records inspector-open-failed and returns the reason", () => {
    const { logger, captured } = capturingLogger();
    const { controller } = fakeInspector({ openError: new Error("Inspector is already activated.") });

    let outcome: ReturnType<typeof openInspector> | undefined;
    expect(() => {
      outcome = openInspector({ controller, logger });
    }).not.toThrow();

    expect(outcome).toEqual({ ok: false, reason: "Inspector is already activated." });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      category: "diagnostic",
      level: "error",
      event: "inspector-open-failed",
      sessionId: null,
    });
    expect((captured[0] as { detail: string }).detail).toContain("Inspector is already activated.");
  });

  // Rule (defensive): if the agent reports active but hands back no URL, treat it as a failure rather
  // than assert a useless empty URL an operator cannot attach to.
  it("records inspector-open-failed when the agent opens but reports no URL", () => {
    const { logger, captured } = capturingLogger();
    const { controller } = fakeInspector({ urlAfterOpen: null });

    const outcome = openInspector({ controller, logger });

    expect(outcome).toEqual({ ok: false, reason: "inspector opened but reported no URL" });
    expect(captured[0]).toMatchObject({ category: "diagnostic", level: "error", event: "inspector-open-failed" });
  });

  it("honours an injected host and port", () => {
    const { controller, opens } = fakeInspector();
    openInspector({ controller, host: "127.0.0.1", port: 9229 });
    expect(opens).toEqual([{ port: 9229, host: "127.0.0.1", wait: false }]);
  });

  it("defaults the logger to a no-op sink (no crash when none is injected)", () => {
    const { controller } = fakeInspector();
    expect(openInspector({ controller }).ok).toBe(true);
  });
});

describe("installInspectorDiagnosticsSignalHandler", () => {
  // Rule: arming installs a handler that, on EACH signal, samples the FD/handle counts AND ensures the
  // inspector is attached — the handle sample FIRST, so the first poke's counts precede the inspector's
  // own socket handle. The returned disposer removes it. A fake EventEmitter stands in for `process`.
  it("captures the handle report then attaches the inspector on each signal, and stops after the disposer runs", () => {
    const { logger, captured } = capturingLogger();
    const source = new EventEmitter();
    const { controller, opens } = fakeInspector();

    const { census } = fakeCensus([{ total: 0, refd: 0, unrefd: 0 }]);
    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => ["TCPServerWrap"],
      installCensus: () => census,
    });

    expect(source.listenerCount(INSPECTOR_DIAGNOSTICS_SIGNAL)).toBe(1);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    // Handle report precedes inspector attach (ordering is load-bearing — clean baseline before the
    // inspector perturbs the handle set); the timer census rides alongside, between the two.
    expect(captured.map((event) => event.event)).toEqual(["handle-report", "timer-census", "inspector-open"]);
    expect(opens).toHaveLength(1);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    // Second poke: the inspector is already open, so it is reported (not re-opened); a fresh handle
    // report and a fresh census still ride.
    expect(captured.map((event) => event.event)).toEqual([
      "handle-report",
      "timer-census",
      "inspector-open",
      "handle-report",
      "timer-census",
      "inspector-open",
    ]);
    expect(opens).toHaveLength(1); // never re-opened

    dispose();
    expect(source.listenerCount(INSPECTOR_DIAGNOSTICS_SIGNAL)).toBe(0);
    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(captured).toHaveLength(6); // unchanged — the handler is gone
  });

  // Rule (AC1): the census is armed LAZILY — on the FIRST poke, exactly once — so a daemon nobody is
  // diagnosing pays no async_hooks tax, and no restart is needed to start paying it. The arming poke's
  // line says it armed; later pokes' lines do not.
  it("arms the census once on the first poke, never at install time, and marks only that first line", () => {
    const { logger, captured } = capturingLogger();
    const source = new EventEmitter();
    const { controller } = fakeInspector();
    const { census } = fakeCensus([
      { total: 0, refd: 0, unrefd: 0 },
      { total: 2, refd: 0, unrefd: 2 },
    ]);
    let arms = 0;

    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => [],
      installCensus: () => {
        arms += 1;
        return census;
      },
    });

    // Installing must not arm: the whole point of lazy arming is that an unpoked daemon pays nothing.
    expect(arms).toBe(0);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(arms).toBe(1);
    const first = captured.find((event) => event.event === "timer-census") as { detail: string };
    expect(first.detail).toContain("census just armed");

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(arms).toBe(1); // armed once, reused after
    const second = captured.filter((event) => event.event === "timer-census")[1] as { detail: string };
    expect(second.detail).toBe("2 live timers — unref'd=2, ref'd=0");
    expect(second.detail).not.toContain("just armed");

    dispose();
  });

  // Rule: the disposer disposes the census — a leak diagnostic that outlived its own handler would be
  // one more leak in the module whose job is finding them.
  it("disposes the armed census when the disposer runs", () => {
    const source = new EventEmitter();
    const { controller } = fakeInspector();
    const spy = fakeCensus([{ total: 0, refd: 0, unrefd: 0 }]);

    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      controller,
      sample: () => [],
      installCensus: () => spy.census,
    });
    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(spy.disposals).toBe(0);

    dispose();
    expect(spy.disposals).toBe(1);
  });

  // Rule: a disposer must be safe to call when no poke ever armed a census — a caller uninstalls
  // unconditionally and cannot know whether the daemon was ever poked.
  it("does not throw when disposed without ever having been poked", () => {
    const source = new EventEmitter();
    const { controller } = fakeInspector();
    const dispose = installInspectorDiagnosticsSignalHandler({ source, controller, sample: () => [] });
    expect(() => dispose()).not.toThrow();
  });

  // Rule: each action is independently guarded — a census that cannot be armed must not suppress the
  // handle report or the inspector attach, and it must say so ONCE rather than on every poke.
  it("still reports and attaches when the census cannot be armed, and reports the reason once", () => {
    const { logger, captured } = capturingLogger();
    const source = new EventEmitter();
    const { controller, opens } = fakeInspector();

    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => ["TCPServerWrap"],
      installCensus: () => {
        throw new Error("async_hooks unavailable");
      },
    });

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(captured.map((event) => event.event)).toEqual(["handle-report", "timer-census-failed", "inspector-open"]);
    expect((captured[1] as { detail: string }).detail).toContain("async_hooks unavailable");
    expect(opens).toHaveLength(1);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    // Latched: the reason rides once, not on every poke thereafter.
    expect(captured.map((event) => event.event)).toEqual([
      "handle-report",
      "timer-census-failed",
      "inspector-open",
      "handle-report",
      "inspector-open",
    ]);
    dispose();
  });

  it("arms the configured signal, defaulting to SIGUSR1", () => {
    const source = new EventEmitter();
    const { controller } = fakeInspector();
    const dispose = installInspectorDiagnosticsSignalHandler({ source, controller, sample: () => [] });
    expect(source.listenerCount("SIGUSR1")).toBe(1);
    dispose();
  });

  // Rule: a struggling daemon poked repeatedly must not fall over — each action is independently
  // guarded, so a failing sample does not suppress the inspector attach.
  it("still attaches the inspector when the handle sample fails", () => {
    const { logger, captured } = capturingLogger();
    const source = new EventEmitter();
    const { controller, opens } = fakeInspector();

    const { census } = fakeCensus([{ total: 0, refd: 0, unrefd: 0 }]);
    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => {
        throw new Error("sample down");
      },
      installCensus: () => census,
    });
    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);

    expect(captured.map((event) => event.event)).toEqual(["handle-report-failed", "timer-census", "inspector-open"]);
    expect(opens).toHaveLength(1);
    dispose();
  });

  // Rule: a platform that cannot listen for the signal (Windows has no SIGUSR1) must not crash the
  // daemon — installation is guarded, the inability is surfaced once as a warn, and a no-op disposer
  // is returned so a caller can uninstall unconditionally.
  it("does not throw when the source cannot arm the signal — it warns and returns a no-op disposer", () => {
    const { logger, captured } = capturingLogger();
    const throwingSource: SignalSource = {
      on: () => {
        throw new Error("SIGUSR1 is not supported on this platform");
      },
      removeListener: () => undefined,
    };

    let dispose: (() => void) | undefined;
    expect(() => {
      dispose = installInspectorDiagnosticsSignalHandler({ source: throwingSource, logger });
    }).not.toThrow();
    expect(() => dispose?.()).not.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ category: "diagnostic", level: "warn", event: "inspector-open-failed" });
  });
});
