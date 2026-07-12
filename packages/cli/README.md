# @ccctl/cli

The `ccctl` command-line interface for [ccctl](../../README.md). Provides the
`ccctl` binary with three verbs that orchestrate the local setup:

- **`ccctl patch [args…]`** — prepare the patched Claude Code worker by delegating
  to the external [`ccctl-patch`](../../README.md) binary (which ships in its own
  repository, not this workspace). Arguments are forwarded verbatim; put patcher
  flags after `--`.
- **`ccctl serve`** — start the loopback-bound [`@ccctl/server`](../server) daemon.
  `--tunnel <kind>` additionally exposes it through a tunnel in one step. Enforces
  the baseline startup guards from `@ccctl/server` before binding
  (refuse-start-without-auth + localhost-bind: no configured local-server auth exits
  non-zero, and a `0.0.0.0` bind is refused).
- **`ccctl tunnel <kind>`** — establish a [`@ccctl/tunnel-adapters`](../tunnel-adapters)
  tunnel exposing an already-running loopback server.

Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
and expose it via a `tunnel`. Command parsing uses
[commander](https://github.com/tj/commander.js); `src/cli.ts` is the thin executable
entry (shebang + argv parse), `src/index.ts` builds the command tree, and
`src/dependencies.ts` wires the real daemon / tunnel / patcher seams (injectable so
the verbs are unit-testable without binding a socket or spawning a process). Depends
on [`@ccctl/core`](../core), [`@ccctl/server`](../server), and
[`@ccctl/tunnel-adapters`](../tunnel-adapters).
