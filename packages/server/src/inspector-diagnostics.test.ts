// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LogEvent, Logger } from "@ccctl/core";
import {
  captureHandleReport,
  formatHandleReport,
  installInspectorDiagnosticsSignalHandler,
  openInspector,
  INSPECTOR_DIAGNOSTICS_HOST,
  INSPECTOR_DIAGNOSTICS_SIGNAL,
  type HandleReport,
  type InspectorController,
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

    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => ["TCPServerWrap"],
    });

    expect(source.listenerCount(INSPECTOR_DIAGNOSTICS_SIGNAL)).toBe(1);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    // Handle report precedes inspector attach (ordering is load-bearing — clean baseline before the
    // inspector perturbs the handle set).
    expect(captured.map((event) => event.event)).toEqual(["handle-report", "inspector-open"]);
    expect(opens).toHaveLength(1);

    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    // Second poke: the inspector is already open, so it is reported (not re-opened); a fresh handle
    // report still rides.
    expect(captured.map((event) => event.event)).toEqual([
      "handle-report",
      "inspector-open",
      "handle-report",
      "inspector-open",
    ]);
    expect(opens).toHaveLength(1); // never re-opened

    dispose();
    expect(source.listenerCount(INSPECTOR_DIAGNOSTICS_SIGNAL)).toBe(0);
    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);
    expect(captured).toHaveLength(4); // unchanged — the handler is gone
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

    const dispose = installInspectorDiagnosticsSignalHandler({
      source,
      logger,
      controller,
      sample: () => {
        throw new Error("sample down");
      },
    });
    source.emit(INSPECTOR_DIAGNOSTICS_SIGNAL);

    expect(captured.map((event) => event.event)).toEqual(["handle-report-failed", "inspector-open"]);
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
