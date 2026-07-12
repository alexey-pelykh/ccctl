// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/cli` — the `ccctl` command-line entry point.
 *
 * Three verbs orchestrate the local setup, each delegating to a real capability
 * behind an injectable seam ({@link CliDependencies}):
 *
 *   - `ccctl patch` — delegate to the external `ccctl-patch` binary to prepare the
 *     patched Claude Code worker (the patcher ships in its own repository, not this
 *     workspace).
 *   - `ccctl serve` — start the loopback-bound {@link https://ccctl | @ccctl/server}
 *     daemon, optionally exposing it through a tunnel in one step (`--tunnel`).
 *   - `ccctl tunnel <kind>` — establish a {@link https://ccctl | @ccctl/tunnel-adapters}
 *     tunnel to an already-running loopback server.
 *
 * Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
 * and expose it via a `tunnel`. `serve` still enforces the baseline startup guards
 * (refuse-start-without-auth + localhost-bind, #14) BEFORE anything binds; completing
 * each guard to spec is tracked separately (the auth credential boundary is #57, the
 * full localhost-bind guarantee is #58). This module builds the command tree; `cli.ts`
 * is the thin executable that runs it.
 */

import { Command } from "commander";
import { formatAuthority, type HostEndpoint } from "@ccctl/core";
import { DEFAULT_HOST, requireLocalServerAuth, resolveBindHost } from "@ccctl/server";
import type { TunnelKind } from "@ccctl/tunnel-adapters";
import { defaultDependencies, type CliDependencies } from "./dependencies.js";

/**
 * Parse a `--port` option into a bound port number, failing closed on anything that
 * is not an integer in `0`–`65535` (`0` selects an ephemeral port). A clear upfront
 * error beats a confusing failure deep inside the daemon's `listen`.
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ccctl: invalid port "${value}" — expected an integer between 0 and 65535`);
  }
  return port;
}

/**
 * Narrow an operator-supplied tunnel name to a {@link TunnelKind}, failing closed on
 * an unknown one. Validated against the injected `adapters` (the backends actually
 * available), so the accepted set and the error's advice never drift from what can
 * run.
 */
function requireTunnelKind(adapters: CliDependencies["adapters"], value: string): TunnelKind {
  if (!(value in adapters)) {
    throw new Error(`ccctl: unknown tunnel "${value}" — expected one of ${Object.keys(adapters).join(", ")}`);
  }
  return value as TunnelKind;
}

/** Render a bound `host:port` as an `http://` URL, bracketing an IPv6 host correctly. */
function serverUrl(host: string, port: number): string {
  return `http://${formatAuthority(host, port)}`;
}

/**
 * Establish `local` through the chosen tunnel and report the public host the patched
 * worker's `--sdk-url` allowlist must then permit — the single place that renders the
 * "reachable via" line, shared by `serve --tunnel` and the standalone `tunnel` verb.
 */
async function establishAndReport(
  adapters: CliDependencies["adapters"],
  kind: TunnelKind,
  local: HostEndpoint,
): Promise<void> {
  const established = await adapters[kind]().establish(local);
  console.log(`ccctl: reachable via ${established.kind} at ${established.publicHost}`);
}

/**
 * Build the `ccctl` command tree. `deps` are the injectable I/O seams (defaulting to
 * the real daemon / tunnels / patcher); a test passes fakes so the verbs are exercised
 * without binding a socket or spawning a process. Exposed for testing and `cli.ts`.
 */
export function buildProgram(deps: CliDependencies = defaultDependencies): Command {
  const program = new Command();
  // Positional options let the `patch` verb pass unknown flags through to the patcher
  // (see its command below); it is a no-op for `serve` / `tunnel`, whose options sit
  // after the subcommand name.
  program.enablePositionalOptions();

  program.name("ccctl").description("Self-hosted control plane for Claude Code").version("0.0.0");

  const tunnelChoices = Object.keys(deps.adapters).join(" | ");

  // --- patch: delegate to the external patcher --------------------------------------
  program
    .command("patch")
    .description("Prepare the patched Claude Code worker by delegating to the ccctl-patch binary")
    .argument("[patcherArgs...]", "arguments forwarded verbatim to ccctl-patch (use `--` before flags)")
    .allowUnknownOption()
    .passThroughOptions()
    .action((patcherArgs: string[]) => {
      // The patcher owns "prepare the binary"; the CLI only delegates. Returning the
      // promise lets `cli.ts` surface a patcher failure as a non-zero exit.
      return deps.runPatcher(patcherArgs);
    });

  // --- serve: start the daemon (optionally behind a tunnel) -------------------------
  program
    .command("serve")
    .description("Start the local control-plane server, optionally behind a tunnel")
    .option("-p, --port <port>", "loopback port to bind", "4321")
    .option("--host <host>", "bind host", DEFAULT_HOST)
    .option("-t, --tunnel <kind>", `expose via a tunnel (${tunnelChoices})`)
    .action(async (options: { port: string; host: string; tunnel?: string }) => {
      // Baseline security guards run BEFORE anything binds (#14). Refuse-start-without-auth:
      // with no configured local-server auth the daemon refuses to start — this throw
      // propagates to `cli.ts`, which sets a non-zero exit code. Localhost-bind: refuse the
      // `0.0.0.0` wildcard so nothing is exposed off-box. Both are the server's own invariants
      // (@ccctl/server); the daemon only applies them.
      requireLocalServerAuth();
      const host = resolveBindHost(options.host);
      // Validate the tunnel choice up front, before binding, so an unknown one fails fast
      // with no side effects.
      const kind = options.tunnel === undefined ? undefined : requireTunnelKind(deps.adapters, options.tunnel);
      const port = parsePort(options.port);

      const server = await deps.startServer({ host, port });
      // Report the address actually bound (`server.address` carries the resolved port,
      // which matters when `--port 0` selects an ephemeral one).
      console.log(`ccctl: serving on ${serverUrl(server.address.host, server.address.port)}`);

      if (kind !== undefined) {
        // Expose the bound endpoint through the chosen tunnel. If it cannot be established, tear
        // the daemon back down rather than leave a half-up, loopback-only server running — its
        // listening socket would otherwise keep the process alive with the exit code set but never
        // applied. `--tunnel` is atomic: both come up, or it fails clean.
        try {
          await establishAndReport(deps.adapters, kind, server.address);
        } catch (error) {
          await server.close();
          throw error;
        }
      }

      // The listening socket keeps the process alive; there is nothing more to do here.
    });

  // --- tunnel: establish a tunnel to an already-running server ----------------------
  program
    .command("tunnel")
    .description("Establish a tunnel exposing an already-running loopback server")
    .argument("<kind>", `tunnel backend (${tunnelChoices})`)
    .option("-p, --port <port>", "loopback port the server is on", "4321")
    .option("--host <host>", "loopback host the server is on", DEFAULT_HOST)
    .action(async (kindArg: string, options: { port: string; host: string }) => {
      const kind = requireTunnelKind(deps.adapters, kindArg);
      const host = resolveBindHost(options.host);
      const port = parsePort(options.port);

      await establishAndReport(deps.adapters, kind, { host, port });
    });

  return program;
}
