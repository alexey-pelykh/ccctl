# @ccctl/cli

The `ccctl` command-line interface for [ccctl](../../README.md). Provides the
`ccctl` binary (`ccctl serve`) that starts the loopback-bound
[`@ccctl/server`](../server) and, optionally, exposes it through a tunnel from
[`@ccctl/tunnel-adapters`](../tunnel-adapters). Command parsing uses
[commander](https://github.com/tj/commander.js); `src/cli.ts` is the thin
executable entry (shebang + argv parse) and `src/index.ts` builds the command
tree. Depends on [`@ccctl/core`](../core), [`@ccctl/server`](../server), and
[`@ccctl/tunnel-adapters`](../tunnel-adapters). This package is a skeleton — the
`serve` action enforces the baseline startup guards from `@ccctl/server`
(refuse-start-without-auth + localhost-bind: no configured local-server auth exits
non-zero, and a `0.0.0.0` bind is refused) and otherwise stubs the server + tunnel
orchestration.
