// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/cli` — the `ccctl` command-line entry point.
 *
 * Wires the pieces together: start {@link https://ccctl | @ccctl/server} on a
 * loopback port and, optionally, expose it through a tunnel from
 * {@link https://ccctl | @ccctl/tunnel-adapters}. This module builds the
 * command tree; `cli.ts` is the executable that runs it.
 *
 * This is a skeleton: the `serve` action enforces the baseline startup guards
 * (refuse-start-without-auth + localhost-bind, #14) and otherwise delegates to
 * stubs — the full server + tunnel orchestration is #71.
 */

import { Command } from "commander";
import { DEFAULT_HOST, requireLocalServerAuth, resolveBindHost } from "@ccctl/server";
import { ADAPTERS, type TunnelKind } from "@ccctl/tunnel-adapters";

/** Build the `ccctl` command tree. Exposed for testing and `cli.ts`. */
export function buildProgram(): Command {
  const program = new Command();

  program.name("ccctl").description("Self-hosted control plane for Claude Code").version("0.0.0");

  program
    .command("serve")
    .description("Start the local control-plane server")
    .option("-p, --port <port>", "loopback port to bind", "4321")
    .option("--host <host>", "bind host", DEFAULT_HOST)
    .option("-t, --tunnel <kind>", `expose via a tunnel (${Object.keys(ADAPTERS).join(" | ")})`)
    .action((options: { port: string; host: string; tunnel?: string }) => {
      // Baseline security guards ride along on the skeleton, BEFORE anything binds
      // (#14). Refuse-start-without-auth: with no configured local-server auth the
      // daemon exits non-zero — this throw propagates to `cli.ts`, which sets a
      // non-zero exit code — with a clear message. Localhost-bind: refuse the
      // `0.0.0.0` wildcard so nothing is exposed off-box. Both are the server's own
      // invariants (@ccctl/server); the daemon only applies them. Completing each to
      // spec is tracked separately — the auth credential boundary is #57, the full
      // localhost-bind guarantee is #58.
      requireLocalServerAuth();
      resolveBindHost(options.host);

      const tunnel = options.tunnel as TunnelKind | undefined;
      if (tunnel !== undefined && !(tunnel in ADAPTERS)) {
        throw new Error(`ccctl: unknown tunnel "${tunnel}"`);
      }
      // TODO(#71): startServer({ host: resolveBindHost(options.host), port: Number(options.port) })
      // then, if `tunnel`, ADAPTERS[tunnel]().establish(...)
      throw new Error("ccctl: serve is not implemented yet (skeleton)");
    });

  return program;
}
