// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/cli` — the `ccctl` command-line entry point.
 *
 * Wires the pieces together: start {@link https://ccctl | @ccctl/server} on a
 * loopback port and, optionally, expose it through a tunnel from
 * {@link https://ccctl | @ccctl/tunnel-adapters}. This module builds the
 * command tree; `cli.ts` is the executable that runs it.
 *
 * This is a skeleton: actions describe intent and delegate to stubs.
 */

import { Command } from "commander";
import { DEFAULT_HOST } from "@ccctl/server";
import { ADAPTERS, type TunnelKind } from "@ccctl/tunnel-adapters";

/** Build the `ccctl` command tree. Exposed for testing and `cli.ts`. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ccctl")
    .description("Self-hosted control plane for Claude Code")
    .version("0.0.0");

  program
    .command("serve")
    .description("Start the local control-plane server")
    .option("-p, --port <port>", "loopback port to bind", "4321")
    .option("--host <host>", "bind host", DEFAULT_HOST)
    .option(
      "-t, --tunnel <kind>",
      `expose via a tunnel (${Object.keys(ADAPTERS).join(" | ")})`,
    )
    .action((options: { port: string; host: string; tunnel?: string }) => {
      const tunnel = options.tunnel as TunnelKind | undefined;
      if (tunnel !== undefined && !(tunnel in ADAPTERS)) {
        throw new Error(`ccctl: unknown tunnel "${tunnel}"`);
      }
      // TODO: startServer(...) then, if `tunnel`, ADAPTERS[tunnel].open(...)
      throw new Error("ccctl: serve is not implemented yet (skeleton)");
    });

  return program;
}
