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
 * **Graceful, not a hard exit.** On the first signal it drives `CcctlServer.close` — which settles held
 * work-polls, ends every SSE stream, and releases every terminal this server launched (a taken-over one
 * is left running for the operator, #35/#76) — then releases the tunnel (below), and THEN exits `0`. A
 * second signal while that is still in flight means the operator is insisting: it stops waiting and
 * force-exits (`1`), so a wedged teardown can never trap them. A close that REJECTS is recorded on the
 * #61 trail as an `error`/`shutdown-failed` line and force-exits `1` — a failed graceful stop still stops.
 *
 * **The tunnel goes after the close, and is time-boxed (#242).** A daemon exposed through a tunnel
 * (`ccctl serve --tunnel`) owns that tunnel's lifetime, so it owns its teardown: the daemon is the only
 * thing that knows when the session is over. Without this the daemon closed and left the mapping (and
 * any ACL grant the adapter had provisioned) behind, because nothing retained the tunnel.
 *
 * Two ordering constraints decide where it goes, and they agree. **Safety**: closing the server is what
 * actually ends reach — nothing is listening afterwards, so a still-live mapping to a dead port
 * authorizes nobody. Reverting the ACL grant first would buy no security while the socket was still
 * open. (The adapter's OWN internal order — revert the grant, THEN turn the serve off, ADR-002 § (3) —
 * is a different question and still holds: there, the serve mapping IS the reach.) **Liveness**: the
 * close is fast and local, while a Tailscale teardown is a network round-trip to `api.tailscale.com`
 * plus a `tailscale` spawn. #82's floor promises a graceful close that always lands; gating it on a
 * third-party API would break that promise exactly when it matters most — a laptop shutting down or a
 * partitioned network is precisely when `SIGTERM` fires and when that API is unreachable.
 *
 * So the close never waits on the tunnel, and the tunnel revert is **best-effort within
 * {@link DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS}** rather than unbounded — otherwise a hung API would hold
 * the process open forever and the daemon would never exit at all. A tunnel teardown that fails, or
 * outruns its budget, is recorded as `error`/`tunnel-teardown-failed` and forces exit `1`: the grant may
 * still be in the operator's policy, and a stop that says so beats one that silently claims to be clean.
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
 * How long the shutdown will wait for the tunnel teardown before giving up on it and exiting anyway
 * (#242). The teardown is a network round-trip to a third-party API; #82's floor promises the daemon
 * STOPS, so that promise cannot be pledged against an unbounded wait. Generous enough for a healthy
 * API round-trip plus the `tailscale` spawn, short enough that an operator killing a daemon on a
 * dying network is not left staring at a hung process. Exceeding it is not silent — it is reported as
 * `tunnel-teardown-failed` and exits non-zero, like any other failed teardown.
 *
 * Sized for the SETTLED case, which is every `SIGTERM` this is really for — a `kill`, or a laptop
 * shutting down long after the establish resolved. A signal landing mid-establish is budgeted by the
 * same number but has more to cover (#259: waiting out the establish, whose own provision may write
 * the policy this then reverts), so on a slow network it can exceed the budget and be reported rather
 * than complete. Deliberately not sized for that worst case: it is reachable only by a `Ctrl-C` inside
 * the establish's own brief window — an operator standing at the terminal, for whom a longer silent
 * wait is worse than a report naming `ccctl tunnel <kind> --off`, and who can force the issue with a
 * second `Ctrl-C` (which exits `1` immediately, by design).
 */
export const DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * The minimal server surface {@link installShutdownSignalHandler} needs — just an async `close`, which
 * the full `CcctlServer` satisfies structurally. Kept narrow (not the whole `CcctlServer`) so a
 * test passes a trivial fake and there is no import cycle with the server barrel.
 */
export interface ShutdownableServer {
  /** Stop accepting connections and release everything the server owns. */
  close(): Promise<void>;
}

/**
 * The minimal tunnel surface the shutdown path needs — just an async `teardown`, which
 * `@ccctl/tunnel-adapters`' `Tunnel` satisfies structurally. Kept narrow (not the whole
 * `Tunnel`) for the same reason as {@link ShutdownableServer}, and because it keeps
 * `@ccctl/server` free of a dependency on the tunnel package: the daemon needs to
 * RELEASE a tunnel, not to know what a tunnel is.
 */
export interface ReleasableTunnel {
  /**
   * Release the tunnel, leaving no mapping — and no provisioned ACL grant — behind.
   *
   * Not necessarily a tunnel OBJECT — see {@link ShutdownSignalDeps.tunnel} (#259).
   */
  teardown(): Promise<void>;
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
  /**
   * What to release AFTER closing the server, resolved AT SIGNAL TIME — `null` (or an absent
   * seam) when there is nothing to release, which leaves the close path exactly as it was.
   *
   * A THUNK, not a value, because of when the handler arms: the daemon arms shutdown as
   * soon as the server binds — deliberately BEFORE it establishes a tunnel, so a `Ctrl-C`
   * during a slow establish still shuts down gracefully — and at that moment there is no
   * tunnel to pass. Resolving on delivery instead means the handler releases whatever the
   * daemon owns WHEN the signal lands.
   *
   * `null` means NOTHING TO RELEASE, which is narrower than "no tunnel" (#259). A daemon
   * whose establish is still IN FLIGHT has no tunnel to hand over and yet may have plenty to
   * release — a `tailscale serve` mapping lands well before `establish` resolves — so an
   * honest `null` there would strand it. The daemon answers that window with a releaser that
   * waits for its establish to settle and then releases whatever it left; this path neither
   * knows nor cares which it was handed, because {@link ReleasableTunnel} is just the verb.
   *
   * What it DOES care about is that a waiting releaser can wait a while. That is already
   * budgeted: the teardown is raced against {@link ShutdownSignalDeps.tunnelTeardownTimeoutMs}
   * exactly so #82's floor is never gated on how long a release takes to decide, and a wedged
   * one is reported as `tunnel-teardown-failed` rather than trapping the operator.
   */
  readonly tunnel?: () => ReleasableTunnel | null;
  /**
   * How long to wait for the tunnel teardown before giving up and exiting anyway
   * (default: {@link DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS}). Injectable so a test drives the
   * timeout arm without waiting out the real budget.
   */
  readonly tunnelTeardownTimeoutMs?: number;
  /** The signals to arm (default: {@link SHUTDOWN_SIGNALS}). */
  readonly signals?: readonly NodeJS.Signals[];
  /** The signal source (default: {@link process}). */
  readonly source?: SignalSource;
  /** How to exit the process once the shutdown settles (default: {@link process.exit}). */
  readonly exit?: ExitFn;
  /** Structured-log sink a FAILED shutdown is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
}

/**
 * Arm the local-shutdown trigger: install a handler for each of {@link SHUTDOWN_SIGNALS} that, on the
 * first delivery, gracefully closes the server, then releases the tunnel (if any) within
 * {@link DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS}, and exits `0`; on a second delivery while that is still
 * running, force-exits `1`; and on a close that rejects — or a tunnel teardown that fails or outruns its
 * budget — records `error`/`shutdown-failed` (resp. `error`/`tunnel-teardown-failed`) on the trail and
 * force-exits `1`. Returns a disposer that removes every handler it armed.
 *
 * Each signal is armed independently and guarded: a platform that cannot listen for one (Windows has no
 * real `SIGTERM`) must not crash the daemon — the inability is surfaced once on the trail as
 * `error`(warn)/`shutdown-arm-failed` and the other signals are still armed, so `Ctrl-C` keeps working
 * where `SIGTERM` does not. The disposer only removes the handlers that actually armed.
 */
export function installShutdownSignalHandler(deps: ShutdownSignalDeps): () => void {
  const {
    server,
    tunnel = () => null,
    tunnelTeardownTimeoutMs = DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS,
    signals = SHUTDOWN_SIGNALS,
    source = process,
    exit = defaultExit,
    logger = NO_OP_LOGGER,
  } = deps;

  /** Describe a thrown value for the trail — an `Error`'s message, else the value itself. */
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /**
   * Release the tunnel, but never wait longer than the budget: the teardown is a network round-trip, and
   * #82's floor promises the daemon exits. Rejects on failure OR on the budget running out, so both
   * arrive at the same honest report — the tunnel may still be up and its grant still in the policy
   * either way, and which of the two it was does not change what the operator has to do about it.
   */
  const releaseTunnel = async (releasable: ReleasableTunnel): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`gave up after ${tunnelTeardownTimeoutMs}ms`));
      }, tunnelTeardownTimeoutMs);
      // Never let the budget timer itself hold the process open — the whole point is to let it exit.
      timer.unref();
    });
    try {
      await Promise.race([releasable.teardown(), budget]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The graceful shutdown itself: close the server, then release the tunnel, and answer with the exit
   * code they earned (`0` clean, `1` if either step failed). Each step is reported and survived
   * independently — neither failure may skip the other — so this settles rather than rejects.
   */
  const shutdown = async (): Promise<number> => {
    let code = 0;

    // The server FIRST: it is the fast, local step, and closing it is what actually ends reach — so
    // #82's floor is never gated on the tunnel's network round-trip (see the header).
    try {
      await server.close();
    } catch (error) {
      logger.log({
        category: "error",
        level: "error",
        event: "shutdown-failed",
        sessionId: null,
        detail: `graceful shutdown failed, exiting anyway: ${reasonOf(error)}`,
      });
      code = 1;
    }

    // Then the tunnel — best-effort within the budget. `null` when there is nothing to release (see
    // the `tunnel` seam — narrower than "no tunnel"). Attempted even if the close above failed: the
    // grant is in the operator's policy either way, and leaving it there because an unrelated step
    // broke would be the orphaned-grant bug this exists to fix.
    const releasable = tunnel();
    if (releasable !== null) {
      try {
        await releaseTunnel(releasable);
      } catch (error) {
        // Never swallowed: the adapter guarantees a failed teardown leaves the tunnel established and
        // retryable, and a shutdown cannot retry — so the honest move is to name what may still be out
        // there (the mapping, and any ACL grant provisioned for it) and the verb that clears it. Hedged
        // deliberately: the adapter reverts the grant BEFORE turning the serve off, so a teardown that
        // failed at the serve-off step has already removed the grant — and the budget arm cannot know
        // which step it died in. `--off` is the right remedy for every one of those cases.
        logger.log({
          category: "error",
          level: "error",
          event: "tunnel-teardown-failed",
          sessionId: null,
          detail:
            `tunnel teardown failed, exiting anyway — the tunnel, and any ACL grant it provisioned, may ` +
            `still be in place; clear them with \`ccctl tunnel <kind> --off\`: ${reasonOf(error)}`,
        });
        code = 1;
      }
    }

    return code;
  };

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
    // A signal handler cannot be async; drive the shutdown and settle the exit off its resolution. The
    // rejection arm is provided, so this promise never goes unhandled — `void` marks it deliberately
    // fire-and-forget (the process is ending either way). `shutdown` reports its own failures and
    // resolves with an exit code, so the rejection arm is the defensive floor (e.g. a throwing sink),
    // not the failure path.
    void shutdown().then(exit, () => {
      exit(1);
    });
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
