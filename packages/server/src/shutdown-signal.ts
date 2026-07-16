// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Local daemon shutdown on a termination signal (#82) — the "stop the server from the local machine"
 * half of the LOCAL CONTROL FLOOR (security-posture.md § "Local control floor").
 *
 * **The floor.** The operator must ALWAYS be able to kill sessions / stop the server from the box —
 * even with a lost phone and every device token revoked. Device-auth gates REMOTE control (over the
 * tunnel); it never gates the local control path. This handler is one of the two OUT-OF-BAND local
 * controls that make the floor structural rather than a promise: because they never traverse the
 * (future, deferred) device-auth-gated HTTP surface, they cannot be gated on a device token by
 * construction. Its sibling is `ccctl revoke-all` (#88 — a direct device-store op, no daemon/network);
 * this one stops the daemon itself, which releases every server-owned session with it.
 *
 * **Trigger — a POSIX termination signal ({@link SHUTDOWN_SIGNALS}: `SIGTERM` + `SIGINT`), not an HTTP
 * route.** A signal's authorization is the OS's own: only a process running as the SAME uid (or root)
 * on the SAME host can deliver it — unreachable off-box, over any network or tunnel. That is "local
 * auth" in its strongest form, the same choice the heap-snapshot (#62, `SIGUSR2`) and inspector (#63,
 * `SIGUSR1`) diagnostics made, and exactly what AC2 requires ("available only on the local machine,
 * not over the tunnel"). `SIGTERM` (the default `kill`) and `SIGINT` (`Ctrl-C` at the `ccctl serve`
 * terminal) are the two standard termination signals, so arming both is what an operator already
 * expects to reach for. No HTTP route is added — so nothing here can front-run the deferred
 * per-request local-server-auth boundary (#57/#58).
 *
 * **Graceful, not a hard exit.** On the first signal it drives `CcctlServer.close` — which
 * settles held work-polls, ends every SSE stream, and releases every terminal this server launched
 * (a taken-over one is left running for the operator, #35/#76) — and THEN exits `0`. A second signal
 * while that close is still in flight means the operator is insisting: it stops waiting and force-exits
 * (`1`), so a wedged teardown can never trap them. A close that REJECTS is recorded on the #61 trail as
 * an `error`/`shutdown-failed` line and force-exits `1` — a failed graceful stop still stops.
 *
 * Everything host-touching (the signal source, the process exit) is an INJECTED seam so the wiring is
 * unit-testable with fakes — no real process-global handler registered, no real `process.exit` called —
 * the same determinism discipline the diagnostic handlers follow. Production wires the real `process`.
 * The daemon (the CLI `serve` verb) arms this once at its composition root, passing the same
 * structured-log sink it gave the server so a failed shutdown rides the daemon's trail.
 */

import { NO_OP_LOGGER, type Logger } from "@ccctl/core";
// The process-signal seam is shared with the heap-snapshot (#62) and inspector (#63) diagnostics — the
// one server-wide shape a fake `EventEmitter` stands in for; type-only import, erased at compile.
import { type SignalSource } from "./heap-snapshot.js";

/**
 * The two termination signals the daemon arms for a graceful local shutdown: `SIGTERM` (the default
 * `kill`) and `SIGINT` (`Ctrl-C`). Named so the daemon, the operator-facing hint, and the tests
 * reference the one set. Not `SIGUSR1`/`SIGUSR2` — those are taken by the diagnostic pokes (#62/#63)
 * and are not what an operator reaches for to STOP a process.
 */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/**
 * The minimal server surface {@link installShutdownSignalHandler} needs — just an async `close`, which
 * the full `CcctlServer` satisfies structurally. Kept narrow (not the whole `CcctlServer`) so a
 * test passes a trivial fake and there is no import cycle with the server barrel.
 */
export interface ShutdownableServer {
  /** Stop accepting connections and release everything the server owns. */
  close(): Promise<void>;
}

/** The injectable `process.exit` seam — a test passes a fake that records the code instead of exiting. */
export type ExitFn = (code: number) => void;

/** The production exit: really terminate the process with `code`. */
const defaultExit: ExitFn = (code) => {
  process.exit(code);
};

/** The seams {@link installShutdownSignalHandler} runs over — the server to close, plus the injectable wiring. */
export interface ShutdownSignalDeps {
  /** The running server to gracefully close on a termination signal. */
  readonly server: ShutdownableServer;
  /** The signals to arm (default: {@link SHUTDOWN_SIGNALS}). */
  readonly signals?: readonly NodeJS.Signals[];
  /** The signal source (default: {@link process}). */
  readonly source?: SignalSource;
  /** How to exit the process once the close settles (default: {@link process.exit}). */
  readonly exit?: ExitFn;
  /** Structured-log sink a FAILED shutdown is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
}

/**
 * Arm the local-shutdown trigger: install a handler for each of {@link SHUTDOWN_SIGNALS} that, on the
 * first delivery, gracefully closes the server and exits `0`; on a second delivery while that close is
 * still running, force-exits `1`; and on a close that rejects, records `error`/`shutdown-failed` on the
 * trail and force-exits `1`. Returns a disposer that removes every handler it armed.
 *
 * Each signal is armed independently and guarded: a platform that cannot listen for one (Windows has no
 * real `SIGTERM`) must not crash the daemon — the inability is surfaced once on the trail as
 * `error`(warn)/`shutdown-arm-failed` and the other signals are still armed, so `Ctrl-C` keeps working
 * where `SIGTERM` does not. The disposer only removes the handlers that actually armed.
 */
export function installShutdownSignalHandler(deps: ShutdownSignalDeps): () => void {
  const { server, signals = SHUTDOWN_SIGNALS, source = process, exit = defaultExit, logger = NO_OP_LOGGER } = deps;

  // Latched at the FIRST signal so a second one force-exits rather than kicking off a second close —
  // scoped to this install call, so two independent handlers never share the latch.
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) {
      // A second termination signal while the graceful close is still in flight: the operator is
      // insisting, so stop waiting and exit now rather than risk a wedged teardown trapping them.
      exit(1);
      return;
    }
    shuttingDown = true;
    // A signal handler cannot be async; drive the close and settle the exit off its resolution. The
    // rejection arm is provided, so this promise never goes unhandled — `void` marks it deliberately
    // fire-and-forget (the process is ending either way).
    void server.close().then(
      () => {
        exit(0);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.log({
          category: "error",
          level: "error",
          event: "shutdown-failed",
          sessionId: null,
          detail: `graceful shutdown failed, exiting anyway: ${reason}`,
        });
        exit(1);
      },
    );
  };

  // Arm each signal independently so one unsupported signal does not drop the others. Track exactly the
  // ones that armed, so the disposer removes only those (a never-armed signal has no listener to remove).
  const armed: NodeJS.Signals[] = [];
  for (const signal of signals) {
    try {
      source.on(signal, handler);
      armed.push(signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.log({
        category: "error",
        level: "warn",
        event: "shutdown-arm-failed",
        sessionId: null,
        detail: `shutdown signal handler could not be armed for ${signal}: ${reason}`,
      });
    }
  }

  return () => {
    for (const signal of armed) {
      source.removeListener(signal, handler);
    }
  };
}
