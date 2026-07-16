# @ccctl/cli

The `ccctl` command-line interface for [ccctl](../../README.md). Provides the
`ccctl` binary.

## Local setup

Three verbs stand up the local setup:

- **`ccctl patch [args…]`** — prepare the patched Claude Code worker by delegating
  to the external [`ccctl-patch`](../../README.md) binary (which ships in its own
  repository, not this workspace). Arguments are forwarded verbatim; put patcher
  flags after `--`.
- **`ccctl serve`** — start the loopback-bound [`@ccctl/server`](../server) daemon.
  `--tunnel <kind>` additionally exposes it through a tunnel in one step. Enforces
  the baseline startup guards from `@ccctl/server` before binding
  (refuse-start-without-auth + localhost-bind: with no local-server auth configured — via
  `CCCTL_LOCAL_SERVER_AUTH` or the `~/.config/ccctl/local-server-auth` config file — it
  exits non-zero naming both sources, and a `0.0.0.0` bind is refused). Wires the session launcher a `ccctl launch`
  runs, so a "New session" spawns the **patched** `claude` worker; the binary defaults to
  `claude` on `PATH` and is pinned to an absolute path via `CCCTL_CLAUDE_BIN`.
- **`ccctl tunnel <kind>`** — establish a [`@ccctl/tunnel-adapters`](../tunnel-adapters)
  tunnel exposing an already-running loopback server.

Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
and expose it via a `tunnel`.

## Session launch/attach

Three verbs drive a **running** daemon's browser-facing session namespace (`/api/sessions`)
from the command line — the same collection the phone drives, so a CLI-launched session lands
in the list alongside phone-driven ones and is steerable the same way:

- **`ccctl launch`** — launch a new session (UC2) on the daemon (`POST /api/sessions`)
  and report how to attach the surface it brought up. Options target the daemon
  (`--host`, `--port`, default loopback `127.0.0.1:4321`) and shape the session
  (`--cwd`, `--permission-mode`, `--project`, `--initial-prompt`). The daemon spawns the
  configured patched `claude` as `claude remote-control --name <name> --permission-mode
<mode> --spawn=same-dir`, so the worker registers against the local server rather than
  the real bridge. A daemon configured without a launcher surfaces its own `501` as a
  clear message.
- **`ccctl attach [session-id]`** — the UC1 attach flow. With no id it **lists** the daemon's
  running sessions (`GET /api/sessions`) with their status and activity (the on-ramp). With a
  session id it **selects** that one — resolved from the same shared list — and reports how to
  steer it.
- **`ccctl steer <session-id>`** — take over a session and drive it (`POST /api/sessions/{id}/command`),
  the very control path the phone uses. Exactly one steer verb per invocation:
  `--prompt <text>` (send input), `--approve` (clear a pending action, optionally `--tool-use-id`),
  or `--interrupt <reason>` (redirect the current turn). Reports the daemon's minted correlation id.

A launch reports the session it started, and that session is in `ccctl attach` immediately — as
`registering`: its terminal is up, but its worker has not checked in over the bridge yet (that
registration ships in `ccctl-patch`, a later credentialed wave). It goes live once the worker
registers; if the worker never does, the daemon evicts it rather than leaving a ghost session
behind. A launch that cannot start at all fails with a typed reason — a directory that does not
exist, a missing terminal backend — so the message names what to fix.

## Panic control

One verb revokes **every** paired device at once — the panic kill:

- **`ccctl revoke-all`** — revoke all paired devices in one action and force re-pairing. It empties
  the server-side paired-device registry (the `0600` device-store snapshot from
  [`@ccctl/server`](../server)), which drops every device's at-rest token hash — the token's only
  stored projection — so every existing device token is refused on next use and every device must
  re-pair (scan a fresh QR from `ccctl serve --tunnel` / `ccctl tunnel`). It reports how many devices
  were revoked, or that nothing was paired.

    Deliberately **adapter-agnostic and daemon-independent**: it is a direct device-store operation,
    touching no tunnel adapter and needing no running daemon or network round-trip — so it works even
    when the daemon or its tunnel is down, which is exactly when a panic control is reached. This is
    the whole-registry counterpart to per-device revoke: `revoke-all` wipes them all, not one.

## Layout

Command parsing uses [commander](https://github.com/tj/commander.js); `src/cli.ts` is the
thin executable entry (shebang + argv parse), `src/index.ts` builds the command tree,
`src/dependencies.ts` wires the real daemon / tunnel / patcher / session-client / launcher /
device-store seams (injectable so the verbs are unit-testable without binding a socket or spawning a
process), `src/worker-command.ts` builds the patched worker's `remote-control` argv and
binds the patched-binary path (`CCCTL_CLAUDE_BIN`), and `src/session-client.ts` is the real
`fetch`-based `/api/sessions` client the launch/attach verbs drive. Depends on [`@ccctl/core`](../core),
[`@ccctl/server`](../server), and [`@ccctl/tunnel-adapters`](../tunnel-adapters).
