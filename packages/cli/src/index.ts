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
 * full localhost-bind guarantee is #58).
 *
 * Two more verbs BEGIN the launch/attach UX (#38) — unlike the three above (which stand the
 * local setup up), these are CLIENTS of an already-running daemon's browser-facing session
 * namespace, driving it from the command line the same way the phone does:
 *
 *   - `ccctl launch` — drive a UC2 "New session" launch (`POST /api/sessions`) on the running
 *     daemon and report how to attach the surface it brought up.
 *   - `ccctl attach` — the UC1 attach on-ramp: list the daemon's running sessions
 *     (`GET /api/sessions`) to pick one to attach to.
 *
 * Both go THROUGH the daemon, so a CLI-launched session lands in the same `/api/sessions`
 * list as the phone-driven ones. This is the on-ramp only: completing the attach (selecting a
 * session and taking over its terminal) and the full "New session" UX is #72. This module builds
 * the command tree; `cli.ts` is the thin executable that runs it.
 */

import { Command } from "commander";
import {
  formatAuthority,
  isPermissionMode,
  PERMISSION_MODES,
  type HostEndpoint,
  type PermissionMode,
  type SessionActivity,
} from "@ccctl/core";
import { DEFAULT_HOST, requireLocalServerAuth, resolveBindHost, type SessionLaunchOptions } from "@ccctl/server";
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
 * Narrow an operator-supplied permission mode to a {@link PermissionMode}, failing closed on an
 * unknown one — the same fail-fast, no-side-effects discipline as {@link parsePort} /
 * {@link requireTunnelKind}, so a typo is a clear upfront error BEFORE any network round-trip
 * rather than a daemon-side `400`. The accepted set is the pinned `@ccctl/core` one, so it never
 * drifts from what a launch actually honors.
 */
function requirePermissionMode(value: string): PermissionMode {
  if (!isPermissionMode(value)) {
    throw new Error(`ccctl: invalid permission mode "${value}" — expected one of ${PERMISSION_MODES.join(", ")}`);
  }
  return value;
}

/**
 * Render a session's derived {@link SessionActivity} as a one-line phrase for the `attach`
 * on-ramp list. Exhaustive over the union so a new activity kind is a compile error here rather
 * than a silently-dropped state.
 */
function describeActivity(activity: SessionActivity): string {
  switch (activity.kind) {
    case "running":
      return "running";
    case "requires_action":
      return `requires action — ${activity.detail}`;
    case "idle":
      return "idle";
  }
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

  // --- launch: drive a UC2 "New session" launch on a running daemon -----------------
  program
    .command("launch")
    .description("Launch a new session (UC2) on a running ccctl daemon and report how to attach it")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .option("--cwd <path>", "working directory to root the session at", process.cwd())
    .option("-m, --permission-mode <mode>", `permission mode (${PERMISSION_MODES.join(" | ")})`, "default")
    .option("--project <name>", "logical project label carried to the session surface")
    .option("--initial-prompt <text>", "seed the session with a first prompt")
    .action(
      async (options: {
        port: string;
        host: string;
        cwd: string;
        permissionMode: string;
        project?: string;
        initialPrompt?: string;
      }) => {
        // Validate every input up front — a bad host/port/mode fails fast with no network round-trip,
        // the same fail-closed-before-side-effects discipline `serve` applies before binding. The
        // optionals are OMITTED (not set to `undefined`) when absent, matching the daemon's launch
        // body under `exactOptionalPropertyTypes`.
        const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };
        const launchOptions: SessionLaunchOptions = {
          cwd: options.cwd,
          permissionMode: requirePermissionMode(options.permissionMode),
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
        };

        const accepted = await deps.sessionClient.launch(target, launchOptions);
        console.log(`ccctl: launched a new session on ${serverUrl(target.host, target.port)}`);
        // The tmux backend is fully attachable (a concrete `tmux attach` line); the owned-pty
        // fallback surfaces its degradation instead of pretending otherwise — pass the daemon's
        // own hint through either way.
        console.log(
          accepted.attachable
            ? `ccctl: attach it with — ${accepted.hint}`
            : `ccctl: this surface is not fully attachable — ${accepted.hint}`,
        );
        // The launch confirms a terminal came up; the launched worker registers itself over the
        // bridge and then shows up in `ccctl attach` on its own (a later credentialed wave).
        console.log("ccctl: it joins `ccctl attach` once its worker registers.");
      },
    );

  // --- attach: the UC1 attach on-ramp — list a running daemon's sessions ------------
  program
    .command("attach")
    .description("List a running ccctl daemon's sessions to attach to (the UC1 attach on-ramp)")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .action(async (options: { port: string; host: string }) => {
      const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };
      // The list carries EVERY tracked session, whatever launched it — so a phone-driven session
      // and a `ccctl launch` one enumerate side by side here (the shared `/api/sessions` collection).
      const sessions = await deps.sessionClient.list(target);
      const where = serverUrl(target.host, target.port);
      if (sessions.length === 0) {
        console.log(`ccctl: no sessions on ${where} yet — launch one with \`ccctl launch\`.`);
        return;
      }
      console.log(`ccctl: ${sessions.length} session${sessions.length === 1 ? "" : "s"} on ${where}:`);
      for (const session of sessions) {
        console.log(`  ${session.id}  [${session.status}] ${describeActivity(session.activity)}`);
      }
    });

  return program;
}
