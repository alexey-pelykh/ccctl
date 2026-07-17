// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LogEvent, Logger } from "@ccctl/core";
import {
  installShutdownSignalHandler,
  SHUTDOWN_SIGNALS,
  type ExitFn,
  type ReleasableTunnel,
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

/**
 * A fake tunnel (#242) that records its teardown against a shared `order` log — so a test can prove the
 * tunnel is released AFTER the server closes, not merely that both happened. `mode: "reject"` drives
 * the failure path.
 */
function fakeTunnel(
  order: string[],
  mode: "resolve" | "reject" = "resolve",
): {
  tunnel: ReleasableTunnel;
  calls: () => number;
} {
  let calls = 0;
  const tunnel: ReleasableTunnel = {
    teardown: () => {
      calls += 1;
      order.push("tunnel");
      return mode === "reject" ? Promise.reject(new Error("acl revert wedged")) : Promise.resolve();
    },
  };
  return { tunnel, calls: () => calls };
}

/** A {@link ShutdownableServer} that records its close against a shared `order` log — the ordering test's other half. */
function orderedServer(order: string[]): ShutdownableServer {
  return {
    close: () => {
      order.push("server");
      return Promise.resolve();
    },
  };
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

// ---------------------------------------------------------------------------
// tunnel release on shutdown (#242)
//
// The daemon owns its tunnel's lifetime, so it owns its teardown — and until this, nothing did: the
// CLI dropped the tunnel the moment `establish` returned, so `serve --tunnel`'s shutdown closed the
// server and left the mapping (and any ACL grant provisioned for it) behind.
// ---------------------------------------------------------------------------

describe("installShutdownSignalHandler — tunnel release (#242)", () => {
  // Rule (AC1): the tunnel is released — and AFTER the server closes. Closing the server is what ends
  // reach (nothing is listening afterwards), so reverting the grant first would buy no security; and
  // #82's floor must never be gated on the tunnel's network round-trip.
  it("closes the server BEFORE releasing the tunnel, then exits 0", async () => {
    const order: string[] = [];
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    const { tunnel, calls } = fakeTunnel(order);
    installShutdownSignalHandler({ server: orderedServer(order), tunnel: () => tunnel, source, exit, logger });

    source.emit("SIGTERM");
    await flush();

    expect(order).toEqual(["server", "tunnel"]);
    expect(calls()).toBe(1);
    expect(codes).toEqual([0]);
    expect(captured).toEqual([]); // a clean shutdown adds no error line
  });

  // Rule (#82's floor, the load-bearing one): the close must NOT wait on the tunnel. A Tailscale revert
  // is a round-trip to api.tailscale.com — unreachable exactly when SIGTERM tends to fire (a laptop
  // shutting down, a partitioned network). A tunnel that never settles must still let the server close.
  it("closes the server even when the tunnel teardown never settles (the floor is not gated on it)", async () => {
    const order: string[] = [];
    const source = new EventEmitter();
    const { exit } = recordingExit();
    const wedged: ReleasableTunnel = { teardown: () => new Promise<void>(() => undefined) };
    installShutdownSignalHandler({ server: orderedServer(order), tunnel: () => wedged, source, exit });

    source.emit("SIGTERM");
    await flush();

    // The server closed on its own schedule, with a permanently-hung tunnel in the same shutdown.
    expect(order).toEqual(["server"]);
  });

  // Rule: the revert is time-boxed, so a hung API cannot hold the daemon open forever — #82 promises the
  // daemon STOPS, and that promise cannot be pledged against an unbounded third-party wait. Giving up is
  // reported exactly like any other failed teardown: the grant may still be in the policy either way.
  it("gives up on a hung tunnel teardown after the budget, reporting it and exiting 1", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    const wedged: ReleasableTunnel = { teardown: () => new Promise<void>(() => undefined) };
    installShutdownSignalHandler({
      server: fakeServer("resolve").server,
      tunnel: () => wedged,
      tunnelTeardownTimeoutMs: 1,
      source,
      exit,
      logger,
    });

    source.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(codes).toEqual([1]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ event: "tunnel-teardown-failed", level: "error" });
    const { detail } = captured[0] as { detail: string };
    expect(detail).toContain("gave up after 1ms");
    expect(detail).toContain("ccctl tunnel <kind> --off"); // still names the remedy
  });

  // Rule: the budget is a CEILING, not a delay — a healthy revert settles immediately and never waits
  // it out. (A regression here would make every shutdown pay the full budget.)
  it("does not wait out the budget when the teardown resolves promptly", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    installShutdownSignalHandler({
      server: fakeServer("resolve").server,
      tunnel: () => fakeTunnel([]).tunnel,
      tunnelTeardownTimeoutMs: 60_000,
      source,
      exit,
    });

    source.emit("SIGTERM");
    await flush(); // a single microtask/immediate turn — nowhere near 60s

    expect(codes).toEqual([0]);
  });

  // Rule: the thunk is resolved AT SIGNAL TIME, not at arm time. The daemon arms shutdown as soon as the
  // server binds — deliberately BEFORE it establishes the tunnel, so a Ctrl-C during a slow establish
  // still shuts down gracefully — so at arm time there is no tunnel to pass.
  it("resolves the tunnel when the signal lands, not when the handler arms", async () => {
    const order: string[] = [];
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { tunnel, calls } = fakeTunnel(order);
    // Armed with nothing — exactly the daemon's state before `establish` resolves.
    let current: ReleasableTunnel | null = null;
    installShutdownSignalHandler({ server: orderedServer(order), tunnel: () => current, source, exit });

    // … the establish completes and the daemon retains it …
    current = tunnel;
    source.emit("SIGTERM");
    await flush();

    expect(calls()).toBe(1);
    expect(order).toEqual(["server", "tunnel"]);
    expect(codes).toEqual([0]);
  });

  // Rule: a loopback-only daemon has no tunnel — the close path is exactly as it was, with nothing to
  // release. Covers both the `null` thunk (establish never finished / failed) and an absent seam.
  it("releases nothing and closes normally when there is no tunnel", async () => {
    for (const deps of [{ tunnel: () => null }, {}]) {
      const source = new EventEmitter();
      const { exit, codes } = recordingExit();
      const { logger, captured } = capturingLogger();
      const server = fakeServer("resolve");
      installShutdownSignalHandler({ server: server.server, ...deps, source, exit, logger });

      source.emit("SIGTERM");
      await flush();

      expect(server.calls()).toBe(1);
      expect(codes).toEqual([0]);
      expect(captured).toEqual([]);
    }
  });

  // Rule (AC4): a failed tunnel teardown is NOT swallowed — the adapter leaves the tunnel established
  // and retryable, and a shutdown cannot retry, so the trail must name what is still out there and the
  // verb that clears it. It still exits 1: the operator needs to know a grant may remain.
  it("records tunnel-teardown-failed and exits 1 when the tunnel will not release", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    const { tunnel } = fakeTunnel([], "reject");
    installShutdownSignalHandler({ server: fakeServer("resolve").server, tunnel: () => tunnel, source, exit, logger });

    source.emit("SIGINT");
    await flush();

    expect(codes).toEqual([1]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      category: "error",
      level: "error",
      event: "tunnel-teardown-failed",
      sessionId: null,
    });
    const { detail } = captured[0] as { detail: string };
    expect(detail).toContain("acl revert wedged"); // the underlying reason
    expect(detail).toContain("ccctl tunnel <kind> --off"); // …and the remedy, since we cannot retry here
  });

  // Rule: a close that FAILED must not skip the tunnel revert — the grant is in the operator's policy
  // regardless, and leaving it there because an unrelated step broke is the orphaned-grant bug this
  // exists to fix.
  it("still releases the tunnel when the server close fails", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { tunnel, calls } = fakeTunnel([]);
    installShutdownSignalHandler({ server: fakeServer("reject").server, tunnel: () => tunnel, source, exit });

    source.emit("SIGTERM");
    await flush();

    expect(calls()).toBe(1); // the revert ran despite the close failing
    expect(codes).toEqual([1]);
  });

  // Rule: both halves failing is reported as BOTH — neither failure may mask the other, and the exit is
  // still a single force-exit 1. Order follows the shutdown's own: close, then tunnel.
  it("reports both failures when the close AND the tunnel reject", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const { logger, captured } = capturingLogger();
    const { tunnel } = fakeTunnel([], "reject");
    installShutdownSignalHandler({ server: fakeServer("reject").server, tunnel: () => tunnel, source, exit, logger });

    source.emit("SIGTERM");
    await flush();

    expect(captured.map((event) => event.event)).toEqual(["shutdown-failed", "tunnel-teardown-failed"]);
    expect(codes).toEqual([1]);
  });

  // Rule: the second-signal escape hatch still works with a tunnel in the path — a wedged TUNNEL
  // teardown must be as escapable as a wedged server close, and must not wait out the budget to become
  // so. (The budget is generous by design; an insisting operator should never have to sit through it.)
  it("force-exits 1 on a second signal while a wedged tunnel teardown is in flight", async () => {
    const source = new EventEmitter();
    const { exit, codes } = recordingExit();
    const server = fakeServer("resolve");
    const wedged: ReleasableTunnel = { teardown: () => new Promise<void>(() => undefined) };
    installShutdownSignalHandler({
      server: server.server,
      tunnel: () => wedged,
      tunnelTeardownTimeoutMs: 60_000,
      source,
      exit,
    });

    source.emit("SIGTERM");
    await flush(); // the close lands; the never-settling tunnel teardown is now in flight
    expect(server.calls()).toBe(1);
    expect(codes).toEqual([]); // still waiting on the tunnel — not exited yet

    source.emit("SIGINT"); // the operator insists → force exit, without waiting out the 60s budget

    expect(codes).toEqual([1]);
    expect(server.calls()).toBe(1); // no second close
  });
});
