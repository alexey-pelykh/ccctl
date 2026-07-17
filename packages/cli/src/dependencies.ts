// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The injectable I/O seams the `ccctl` command tree orchestrates over.
 *
 * Every verb ({@link https://ccctl | patch / serve / tunnel}) delegates to one of
 * three real capabilities: the external `ccctl-patch` binary, the local
 * {@link https://ccctl | @ccctl/server} daemon, and a
 * {@link https://ccctl | @ccctl/tunnel-adapters} tunnel. Each is behind a seam here
 * so {@link https://ccctl | buildProgram} is unit-testable with fakes — no real
 * socket bound, no real process spawned — the same determinism discipline the rest
 * of the codebase follows (the server's injectable `env`/`config`, the tunnel
 * adapter's {@link https://ccctl | defaultCommandRunner}). Production wires the real
 * implementations via {@link defaultDependencies}.
 */

import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import type { IDeviceStore, Logger } from "@ccctl/core";
import {
  createFallbackSessionLauncher,
  createFileDeviceStore,
  createTmuxSessionLauncher,
  installHeapSnapshotSignalHandler,
  installInspectorDiagnosticsSignalHandler,
  installShutdownSignalHandler,
  startServer,
  type CcctlServer,
  type ISessionLauncher,
  type ReleasableTunnel,
  type ServerConfig,
} from "@ccctl/server";
import { ADAPTERS, type Tunnel, type TunnelKind } from "@ccctl/tunnel-adapters";
import { defaultSessionClient, type SessionClient } from "./session-client.js";
import { createTailscaleTunnel } from "./tailscale-acl.js";
import { defaultWorkerCommand } from "./worker-command.js";

/** The command-line name of the external patcher the `patch` verb delegates to. */
export const PATCHER_BIN = "ccctl-patch";

/**
 * The three seams the `ccctl` verbs orchestrate over. Interchangeable so a test
 * substitutes fakes (no bound socket, no spawned process) while production uses
 * {@link defaultDependencies}.
 */
export interface CliDependencies {
  /** Start the local daemon (the `serve` verb) — {@link startServer} in production. */
  readonly startServer: (config: ServerConfig) => Promise<CcctlServer>;
  /** The tunnel backends, keyed by {@link TunnelKind} — {@link ADAPTERS} in production. */
  readonly adapters: Record<TunnelKind, () => Tunnel>;
  /** Delegate to the external patcher (the `patch` verb) — {@link defaultRunPatcher} in production. */
  readonly runPatcher: (args: readonly string[]) => Promise<void>;
  /**
   * The `/api/sessions` client the `launch` / `attach` verbs drive against a running daemon
   * (#38) — {@link defaultSessionClient} in production. Behind a seam so the verbs are exercised
   * with a fake (no real socket, no running daemon), the same as the three seams above.
   */
  readonly sessionClient: SessionClient;
  /**
   * The paired-device store the `revoke-all` verb drives (#88) — the server-side registry a
   * panic kill wipes to force every device to re-pair. {@link createFileDeviceStore} (the `0600`
   * XDG-state snapshot) in production; behind a seam so the verb is exercised with an in-memory
   * fake (no real state file touched), the same determinism discipline as the seams above. The
   * `IDeviceStore` port, not a concrete backend, so the verb depends on the contract.
   */
  readonly deviceStore: IDeviceStore;
  /**
   * The session launcher the `serve` verb injects into the daemon (#157 wires production;
   * #31 shaped the port) — the {@link https://ccctl | ISessionLauncher} a `POST /api/sessions`
   * "New session" request runs to bring up a headful terminal running the PATCHED `claude`.
   * {@link defaultDependencies} composes the tmux backend (#29) with the production
   * `remote-control` worker-argv builder ({@link defaultWorkerCommand}); a test injects a fake
   * so `serve` is exercised without a real tmux or a spawned worker, the same as the seams above.
   */
  readonly launcher: ISessionLauncher;
  /**
   * Arm the daemon's on-demand heap-snapshot trigger (#62) — install the {@link https://ccctl |
   * HEAP_SNAPSHOT_SIGNAL} (`SIGUSR2`) handler that dumps a live snapshot without a restart, and
   * return a disposer. {@link installHeapSnapshotSignalHandler} in production; behind a seam so
   * `serve` is exercised WITHOUT registering a real process-global signal handler (which would leak
   * across the test process), the same determinism discipline as the seams above. The daemon's
   * structured-log sink is passed through so a snapshot (or a failure) rides the daemon's #61 trail.
   */
  readonly installHeapSnapshotHandler: (options: { readonly logger: Logger }) => () => void;
  /**
   * Arm the daemon's on-demand inspector-attach + FD/handle-count diagnostics trigger (#63) — install
   * the {@link https://ccctl | INSPECTOR_DIAGNOSTICS_SIGNAL} (`SIGUSR1`) handler that, on each poke,
   * samples the daemon's active FD/handle counts onto the trail, reads the unref'd-timer census that
   * tally cannot see (#238), AND attaches the loopback-bound Node inspector for deeper diagnosis, and
   * return a disposer. {@link installInspectorDiagnosticsSignalHandler} in production; behind a seam so
   * `serve` is exercised WITHOUT registering a real process-global signal handler, opening a real
   * inspector port, or enabling a real `async_hooks` census (each of which would leak across the test
   * process), the same determinism discipline as the seams above. The daemon's structured-log sink is
   * passed through so a report (or a failure) rides the daemon's #61 trail.
   */
  readonly installInspectorDiagnosticsHandler: (options: { readonly logger: Logger }) => () => void;
  /**
   * Arm the daemon's local-shutdown trigger (#82) — install the {@link https://ccctl | SHUTDOWN_SIGNALS}
   * (`SIGTERM` + `SIGINT`) handlers that gracefully close the running daemon and exit, and return a
   * disposer. {@link installShutdownSignalHandler} in production. This is the "stop the server from the
   * local machine" half of the local-control floor — an OUT-OF-BAND, device-auth-independent control
   * (an OS signal, unreachable over the tunnel), the sibling of `revoke-all`. Behind a seam so `serve`
   * is exercised WITHOUT registering a real process-global signal handler or a real `process.exit`
   * (either would leak across / kill the test process), the same determinism discipline as the seams
   * above. Takes the bound {@link https://ccctl | CcctlServer} to close and the daemon's structured-log
   * sink so a FAILED shutdown rides the daemon's #61 trail.
   *
   * Also takes the daemon's tunnel, to RELEASE after closing the server (#242) — the daemon owns the
   * tunnel's lifetime, so its shutdown is where any ACL grant the adapter provisioned gets removed. A
   * thunk, because `serve` arms this BEFORE it establishes the tunnel (so a Ctrl-C mid-establish still
   * shuts down gracefully); it is resolved when the signal lands. `@ccctl/server` types it as the narrow
   * structural {@link https://ccctl | ReleasableTunnel} port, which `Tunnel` satisfies.
   */
  readonly installShutdownHandler: (options: {
    readonly server: CcctlServer;
    readonly logger: Logger;
    readonly tunnel: () => ReleasableTunnel | null;
  }) => () => void;
  /**
   * Render a scannable terminal QR of `text` — the QR-pair onboarding block `serve` / `tunnel`
   * print after a tunnel is up (#74) — {@link defaultRenderQr} (a zero-dependency `qrcode-terminal`)
   * in production. Behind a seam so those verbs are exercised with a fake that just captures the
   * encoded payload (no real QR drawn), the same determinism discipline as the seams above.
   */
  readonly renderQr: (text: string) => string;
}

/**
 * The default `runPatcher`: delegate to the external {@link PATCHER_BIN} binary,
 * forwarding `args` verbatim. The patcher ships in its OWN repository (not this
 * workspace, for takedown-isolation — see the ccctl README), so it is reached as a
 * PATH command, exactly as the Tailscale adapter reaches `tailscale`. `stdio` is
 * inherited so the operator sees the patcher's own progress and errors, and there
 * is no shell (arguments are never word-split or glob-expanded).
 *
 * Rejects — which `cli.ts` turns into a non-zero process exit — when the patcher
 * cannot be launched (a clear, actionable message on `ENOENT`: it is not installed),
 * exits non-zero, or is killed by a signal. Resolves only on a clean exit.
 */
export function defaultRunPatcher(args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(PATCHER_BIN, [...args], { stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `ccctl: could not run \`${PATCHER_BIN}\` — is it installed and on your PATH? ` +
              `The patcher ships in its own repository (see the ccctl README) and is not part of this package.`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`ccctl: ${PATCHER_BIN} was terminated by signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`ccctl: ${PATCHER_BIN} exited with code ${code ?? 1}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * The default `renderQr`: a compact, scannable terminal QR via the zero-dependency
 * `qrcode-terminal` (#74). `small` packs the code with unicode half-blocks — half the height
 * and no ANSI color — so it fits an 80-column terminal without wrapping (a wrapped QR is
 * unscannable) and survives being piped to a log. The library invokes the callback
 * synchronously, so the rendered string is captured and returned rather than printed here —
 * the `serve` / `tunnel` verbs own the surrounding onboarding lines.
 */
export function defaultRenderQr(text: string): string {
  let rendered = "";
  qrcodeTerminal.generate(text, { small: true }, (qrcode) => {
    rendered = qrcode;
  });
  return rendered;
}

/** The production seams: the real daemon, the real tunnel adapters, the real patcher delegation, the real session client, the real session launcher, and the real terminal-QR renderer. */
export const defaultDependencies: CliDependencies = {
  startServer,
  // The registry's backends, with Tailscale's factory swapped for the ACL-aware composition (#153):
  // #148 landed opt-in provisioning behind the adapter's injectable API seam, but the credential's
  // source is the CLI's concern (ADR-002 § (2) fixes it as INJECTED — `@ccctl/tunnel-adapters` reads
  // no env), so the token→client→provisioning wiring belongs HERE, at the composition root, exactly
  // like the launcher below. `createTailscaleTunnel` resolves per establish: with BOTH
  // CCCTL_TAILSCALE_API_TOKEN and CCCTL_TAILSCALE_ACL_GRANT configured, the tunnel brackets the
  // grant the OPERATOR declared to the session (ccctl authors none). With either one missing it is
  // `new TailscaleTunnel(defaultCommandRunner, null)` — identical to the registry's default, so the
  // #139 operator-managed-ACL posture is unchanged. Cloudflare / Headscale are untouched stubs.
  adapters: { ...ADAPTERS, tailscale: () => createTailscaleTunnel() },
  runPatcher: defaultRunPatcher,
  sessionClient: defaultSessionClient,
  // The real paired-device store (#88): the `0600` single-file JSON snapshot at the XDG state
  // path, the same backend the daemon selects. `revoke-all` loads it, empties it, and saves — a
  // local state-file op that needs no running daemon, which is what makes it a robust panic kill.
  deviceStore: createFileDeviceStore(),
  installHeapSnapshotHandler: (options) => installHeapSnapshotSignalHandler(options),
  installInspectorDiagnosticsHandler: (options) => installInspectorDiagnosticsSignalHandler(options),
  // Arm the local-shutdown floor (#82): SIGTERM/SIGINT gracefully closes the daemon (releasing every
  // server-owned session) and exits — an OS-signal control, unreachable over the tunnel and needing no
  // device token, the sibling of `revoke-all`. The real `process` and `process.exit` are wired by
  // installShutdownSignalHandler's own defaults; the daemon passes the bound server + its #61 sink.
  installShutdownHandler: (options) => installShutdownSignalHandler(options),
  renderQr: defaultRenderQr,
  // Compose the tmux backend (#29) behind the fallback launcher composite (#31) — the documented
  // composition-root shape — driving the production `remote-control` worker-argv builder (#157) on
  // the CONFIGURED binary (CCCTL_CLAUDE_BIN, default `claude`). Absent tmux, a launch fails closed
  // daemon-side; a missing/unrunnable worker binary is caught by the tmux backend's own pre-flight
  // and fails closed as a typed `worker-not-found` (#33). The owned-pty backend (#30) has LANDED but
  // is deliberately NOT in this chain yet: tmux does not FAIL when it cannot run the worker (it opens
  // a window and the command dies), so a fallback behind it would never be reached — wiring pty needs
  // the composite to fall back on a launch that "succeeded" into nothing, which is its own item.
  // The CONFIGURED binary MUST be the PATCHED `claude` — an unpatched one reaches the real bridge, since
  // local-server registration is its baked-in `--sdk-url` wiring, not this argv (see `worker-command.ts`).
  launcher: createFallbackSessionLauncher([createTmuxSessionLauncher({ workerCommand: defaultWorkerCommand })]),
};
