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
  startServer,
  type CcctlServer,
  type ISessionLauncher,
  type ServerConfig,
} from "@ccctl/server";
import { ADAPTERS, type Tunnel, type TunnelKind } from "@ccctl/tunnel-adapters";
import { defaultSessionClient, type SessionClient } from "./session-client.js";
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
   * samples the daemon's active FD/handle counts onto the trail AND attaches the loopback-bound Node
   * inspector for deeper diagnosis, and return a disposer. {@link installInspectorDiagnosticsSignalHandler}
   * in production; behind a seam so `serve` is exercised WITHOUT registering a real process-global
   * signal handler or opening a real inspector port (which would leak across the test process), the
   * same determinism discipline as the seams above. The daemon's structured-log sink is passed through
   * so a report (or a failure) rides the daemon's #61 trail.
   */
  readonly installInspectorDiagnosticsHandler: (options: { readonly logger: Logger }) => () => void;
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
  adapters: ADAPTERS,
  runPatcher: defaultRunPatcher,
  sessionClient: defaultSessionClient,
  // The real paired-device store (#88): the `0600` single-file JSON snapshot at the XDG state
  // path, the same backend the daemon selects. `revoke-all` loads it, empties it, and saves — a
  // local state-file op that needs no running daemon, which is what makes it a robust panic kill.
  deviceStore: createFileDeviceStore(),
  installHeapSnapshotHandler: (options) => installHeapSnapshotSignalHandler(options),
  installInspectorDiagnosticsHandler: (options) => installInspectorDiagnosticsSignalHandler(options),
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
