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
import { startServer, type CcctlServer, type ServerConfig } from "@ccctl/server";
import { ADAPTERS, type Tunnel, type TunnelKind } from "@ccctl/tunnel-adapters";
import { defaultSessionClient, type SessionClient } from "./session-client.js";

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

/** The production seams: the real daemon, the real tunnel adapters, the real patcher delegation, and the real session client. */
export const defaultDependencies: CliDependencies = {
  startServer,
  adapters: ADAPTERS,
  runPatcher: defaultRunPatcher,
  sessionClient: defaultSessionClient,
};
