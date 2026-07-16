// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LogEvent, Logger } from "@ccctl/core";
import {
  installShutdownSignalHandler,
  SHUTDOWN_SIGNALS,
  type ExitFn,
  type ShutdownableServer,
} from "./shutdown-signal.js";
// `SignalSource` is the shared process-signal seam, owned by the heap-snapshot module (#62) — the test
// sources the type from the same home the handler does.
import { type SignalSource } from "./heap-snapshot.js";

/** A capturing log sink — the fake the failure-path tests assert against. */
function capturingLogger(): { logger: Logger; captured: LogEvent[] } {
  const captured: LogEvent[] = [];
  return { logger: { log: (event) => captured.push(event) }, captured };
}

/** A recording `exit` seam — collects the codes it was asked to exit with instead of killing the test process. */
function recordingExit(): { exit: ExitFn; codes: number[] } {
  const codes: number[] = [];
  return { exit: (code) => codes.push(code), codes };
}

/**
 * A fake server whose `close` is controllable: by default it resolves immediately; pass `mode: "pending"`
 * to hold it open (for the second-signal test) or `mode: "reject"` to reject (for the failure path). Tracks
 * the call count so a test can assert a second signal did NOT kick off a second close.
 */
function fakeServer(mode: "resolve" | "pending" | "reject" = "resolve"): {
  server: ShutdownableServer;
  calls: () => number;
} {
  let calls = 0;
  const server: ShutdownableServer = {
    close: () => {
      calls += 1;
      if (mode === "pending") {
        return new Promise<void>(() => undefined);
      }
      if (mode === "reject") {
        return Promise.reject(new Error("teardown wedged"));
      }
      return Promise.resolve();
    },
  };
  return { server, calls: () => calls };
}

/** Flush the microtask/immediate queue so a `server.close().then(...)` settlement runs before assertions. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("installShutdownSignalHandler", () => {
  // Rule (AC1/AC2): the daemon arms BOTH standard termination signals for a graceful local shutdown —
  // SIGTERM (the default `kill`) and SIGINT (Ctrl-C). A fake EventEmitter stands in for `process`.
  it("arms every SHUTDOWN_SIGNALS handler, and removes them on the disposer", () => {
    const source = new EventEmitter();
    const { exit } = recordingExit();
    const dispose = installShutdownSignalHandler({ server: fakeServer().server, source, exit });

    for (const signal of SHUTDOWN_SIGNALS) {
      expect(source.listenerCount(signal)).toBe(1);
    }
    expect(SHUTDOWN_SIGNALS).toEqual(["SIGTERM", "SIGINT"]);

    dispose();
    for (const signal of SHUTDOWN_SIGNALS) {
      expect(source.listenerCount(signal)).toBe(0);
    }
  });

  // Rule: the first signal gracefully closes the server and THEN exits 0 — the graceful path.
  it("closes the server and exits 0 on the first signal", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    const server = fakeServer("resolve");
    installShutdownSignalHandler({ server: server.server, source, exit, logger });

    source.emit("SIGTERM");
    await flush();

    expect(server.calls()).toBe(1);
    expect(codes).toEqual([0]);
    // A clean shutdown adds no error line to the trail.
    expect(captured).toEqual([]);
  });

  // Rule: a close that REJECTS still stops — it records error/shutdown-failed on the #61 trail and
  // force-exits 1. A failed graceful stop is still a stop.
  it("records shutdown-failed and exits 1 when the close rejects", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    installShutdownSignalHandler({ server: fakeServer("reject").server, source, exit, logger });

    source.emit("SIGINT");
    await flush();

    expect(codes).toEqual([1]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ category: "error", level: "error", event: "shutdown-failed", sessionId: null });
    expect((captured[0] as { detail: string }).detail).toContain("teardown wedged");
  });

  // Rule: a SECOND termination signal while the first close is still in flight means the operator is
  // insisting — force-exit 1 immediately, and do NOT start a second close.
  it("force-exits 1 on a second signal while the close is still in flight", () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const server = fakeServer("pending");
    installShutdownSignalHandler({ server: server.server, source, exit });

    source.emit("SIGTERM"); // starts the (never-settling) close
    source.emit("SIGINT"); // second signal → force exit

    expect(server.calls()).toBe(1); // no second close
    expect(codes).toEqual([1]); // force-exit fired before the close could settle
  });

  // Rule: only the SIGNALS asked for are armed — an injected set overrides the SIGTERM/SIGINT default.
  it("honours an injected signals set", () => {
    const source = new EventEmitter();
    const { exit } = recordingExit();
    const dispose = installShutdownSignalHandler({ server: fakeServer().server, source, exit, signals: ["SIGTERM"] });

    expect(source.listenerCount("SIGTERM")).toBe(1);
    expect(source.listenerCount("SIGINT")).toBe(0);
    dispose();
  });

  // Rule: a platform that cannot listen for one signal (Windows has no real SIGTERM) must not crash the
  // daemon — the inability is surfaced once as error(warn)/shutdown-arm-failed, the OTHER signals still
  // arm, and the disposer removes only the ones that armed.
  it("survives a signal that cannot be armed, still arming the rest", () => {
    const armed: NodeJS.Signals[] = [];
    const removed: NodeJS.Signals[] = [];
    const source: SignalSource = {
      on: (signal) => {
        if (signal === "SIGTERM") {
          throw new Error("no SIGTERM on this platform");
        }
        armed.push(signal);
      },
      removeListener: (signal) => {
        removed.push(signal);
      },
    };
    const { exit } = recordingExit();
    const { logger, captured } = capturingLogger();
    const dispose = installShutdownSignalHandler({ server: fakeServer().server, source, exit, logger });

    expect(armed).toEqual(["SIGINT"]); // SIGTERM threw; SIGINT still armed
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ category: "error", level: "warn", event: "shutdown-arm-failed" });
    expect((captured[0] as { detail: string }).detail).toContain("SIGTERM");

    dispose();
    expect(removed).toEqual(["SIGINT"]); // only the armed signal is removed, never the one that threw
  });

  // Rule: the logger defaults to a no-op sink — arming without one never crashes.
  it("defaults the logger to a no-op sink (no crash when none is injected)", () => {
    const source = new EventEmitter();
    const { exit } = recordingExit();
    expect(() => installShutdownSignalHandler({ server: fakeServer().server, source, exit })).not.toThrow();
    expect(source.listenerCount("SIGTERM")).toBe(1);
  });
});
