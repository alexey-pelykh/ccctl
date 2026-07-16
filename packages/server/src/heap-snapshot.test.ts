// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LogEvent, Logger } from "@ccctl/core";
import {
  captureHeapSnapshot,
  heapSnapshotFileName,
  HEAP_SNAPSHOT_DIR_ENV,
  HEAP_SNAPSHOT_FILE_MODE,
  HEAP_SNAPSHOT_SIGNAL,
  installHeapSnapshotSignalHandler,
  resolveHeapSnapshotDir,
  type SignalSource,
} from "./heap-snapshot.js";

/** A capturing log sink — the fake every emission test asserts against. */
function capturingLogger(): { logger: Logger; captured: LogEvent[] } {
  const captured: LogEvent[] = [];
  return { logger: { log: (event) => captured.push(event) }, captured };
}

// A fixed instant so the generated file name is deterministic.
const FIXED_NOW = 1_700_000_000_000;

describe("heapSnapshotFileName", () => {
  // Rule: the name is filesystem-safe (no `:` or `.` from the ISO instant, save the extension) and
  // stamped with pid + instant so two snapshots from one daemon never collide.
  it("builds a filesystem-safe, pid+stamp name with the .heapsnapshot extension", () => {
    const name = heapSnapshotFileName(4321, FIXED_NOW);
    expect(name).toBe("ccctl-heap-4321-2023-11-14T22-13-20-000Z.heapsnapshot");
    expect(name.slice(0, -".heapsnapshot".length)).not.toContain(":");
    expect(name.slice(0, -".heapsnapshot".length)).not.toContain(".");
  });
});

describe("resolveHeapSnapshotDir", () => {
  // Rule: an ABSOLUTE override wins; anything else (unset, blank, relative) falls back to the OS temp
  // dir — a relative path would resolve against the daemon cwd, a footgun (the XDG absolute-only idiom).
  it("honours an absolute override", () => {
    expect(resolveHeapSnapshotDir({ [HEAP_SNAPSHOT_DIR_ENV]: "/var/lib/ccctl/dumps" })).toBe("/var/lib/ccctl/dumps");
  });

  it("falls back to the OS temp dir when unset, blank, or relative", () => {
    expect(resolveHeapSnapshotDir({})).toBe(tmpdir());
    expect(resolveHeapSnapshotDir({ [HEAP_SNAPSHOT_DIR_ENV]: "   " })).toBe(tmpdir());
    expect(resolveHeapSnapshotDir({ [HEAP_SNAPSHOT_DIR_ENV]: "relative/dir" })).toBe(tmpdir());
  });
});

describe("captureHeapSnapshot", () => {
  // Rule: on success the outcome names the written path, and a `diagnostic`/`heap-snapshot` info line
  // rides the trail carrying that path (never the snapshot's contents).
  it("writes to the resolved path and records a diagnostic/heap-snapshot info event", () => {
    const { logger, captured } = capturingLogger();
    const writes: string[] = [];
    const outcome = captureHeapSnapshot({
      write: (path) => {
        writes.push(path);
        return path;
      },
      dir: "/snap",
      pid: 4321,
      now: () => FIXED_NOW,
      logger,
    });

    const expectedPath = join("/snap", "ccctl-heap-4321-2023-11-14T22-13-20-000Z.heapsnapshot");
    expect(outcome).toEqual({ ok: true, path: expectedPath });
    expect(writes).toEqual([expectedPath]);
    expect(captured).toEqual([
      { category: "diagnostic", level: "info", event: "heap-snapshot", sessionId: null, detail: expectedPath },
    ]);
  });

  // Rule: a failed snapshot must NOT throw (it would take a struggling daemon down) — the error is
  // caught, recorded as `diagnostic`/`heap-snapshot-failed` at error level, and returned.
  it("never throws on a write failure — it records a heap-snapshot-failed error and returns the reason", () => {
    const { logger, captured } = capturingLogger();
    let outcome: ReturnType<typeof captureHeapSnapshot> | undefined;
    expect(() => {
      outcome = captureHeapSnapshot({
        write: () => {
          throw new Error("EACCES: permission denied");
        },
        dir: "/snap",
        pid: 4321,
        now: () => FIXED_NOW,
        logger,
      });
    }).not.toThrow();

    const expectedPath = join("/snap", "ccctl-heap-4321-2023-11-14T22-13-20-000Z.heapsnapshot");
    expect(outcome).toEqual({ ok: false, path: expectedPath, reason: "EACCES: permission denied" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      category: "diagnostic",
      level: "error",
      event: "heap-snapshot-failed",
      sessionId: null,
    });
    expect((captured[0] as { detail: string }).detail).toContain("EACCES");
  });

  it("defaults the logger to a no-op sink (no crash when none is injected)", () => {
    const outcome = captureHeapSnapshot({ write: (path) => path, dir: "/snap", pid: 1, now: () => FIXED_NOW });
    expect(outcome.ok).toBe(true);
  });
});

describe("captureHeapSnapshot — real V8 writer (AC1/AC2 + 0600 secrets-at-rest)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Rule (AC1 + AC2): the default writer produces a REAL heap snapshot of the LIVE process, no restart —
  // observed by writing one and reading a plausible V8 snapshot back. Rule (security): the file is
  // owner-only 0600, because it holds a copy of process memory (every in-flight Bearer / ingress token).
  it("writes a real, owner-only 0600 heap snapshot of the live process", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccctl-heap-test-"));
    dirs.push(dir);

    const outcome = captureHeapSnapshot({ dir, pid: 424242, now: () => FIXED_NOW });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return; // narrow for the assertions below
    // A V8 heap snapshot is a JSON document whose top-level object carries a `snapshot` section.
    const contents = readFileSync(outcome.path, "utf8");
    expect(contents.startsWith("{")).toBe(true);
    expect(contents).toContain("snapshot");
    // Owner-only: no group/other bits set.
    expect(statSync(outcome.path).mode & 0o777).toBe(HEAP_SNAPSHOT_FILE_MODE);
  });
});

describe("installHeapSnapshotSignalHandler", () => {
  // Rule: arming installs a handler that captures a snapshot each time the signal fires; the returned
  // disposer removes it. A fake EventEmitter stands in for `process` so no real signal is delivered.
  it("captures on each signal and stops after the disposer runs", () => {
    const { logger, captured } = capturingLogger();
    const source = new EventEmitter();
    const writes: string[] = [];

    const dispose = installHeapSnapshotSignalHandler({
      source,
      logger,
      write: (path) => {
        writes.push(path);
        return path;
      },
      dir: "/snap",
      pid: 7,
      now: () => FIXED_NOW,
    });

    expect(source.listenerCount(HEAP_SNAPSHOT_SIGNAL)).toBe(1);

    source.emit(HEAP_SNAPSHOT_SIGNAL);
    source.emit(HEAP_SNAPSHOT_SIGNAL);
    expect(writes).toHaveLength(2);
    expect(captured).toHaveLength(2);
    expect(captured.every((event) => event.category === "diagnostic" && event.event === "heap-snapshot")).toBe(true);

    dispose();
    expect(source.listenerCount(HEAP_SNAPSHOT_SIGNAL)).toBe(0);
    source.emit(HEAP_SNAPSHOT_SIGNAL);
    expect(writes).toHaveLength(2); // unchanged — the handler is gone
  });

  it("arms the configured signal, defaulting to SIGUSR2", () => {
    const source = new EventEmitter();
    const dispose = installHeapSnapshotSignalHandler({ source, write: (path) => path });
    expect(source.listenerCount("SIGUSR2")).toBe(1);
    dispose();
  });

  // Rule: a platform that cannot listen for the signal (Windows has no SIGUSR2) must not crash the
  // daemon — installation is guarded, the inability is surfaced once as a warn, and a no-op disposer
  // is returned so a caller can uninstall unconditionally.
  it("does not throw when the source cannot arm the signal — it warns and returns a no-op disposer", () => {
    const { logger, captured } = capturingLogger();
    const throwingSource: SignalSource = {
      on: () => {
        throw new Error("SIGUSR2 is not supported on this platform");
      },
      removeListener: () => undefined,
    };

    let dispose: (() => void) | undefined;
    expect(() => {
      dispose = installHeapSnapshotSignalHandler({ source: throwingSource, logger });
    }).not.toThrow();
    expect(() => dispose?.()).not.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ category: "diagnostic", level: "warn", event: "heap-snapshot-failed" });
  });
});
