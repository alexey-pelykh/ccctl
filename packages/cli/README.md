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
  (refuse-start-without-auth + localhost-bind: no configured local-server auth exits
  non-zero, and a `0.0.0.0` bind is refused).
- **`ccctl tunnel <kind>`** — establish a [`@ccctl/tunnel-adapters`](../tunnel-adapters)
  tunnel exposing an already-running loopback server.

Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
and expose it via a `tunnel`.

## Session launch/attach

Two verbs begin the launch/attach UX by driving a **running** daemon's browser-facing
session namespace (`/api/sessions`) from the command line — the same collection the
phone drives, so a CLI-launched session lands in the list alongside phone-driven ones:

- **`ccctl launch`** — launch a new session (UC2) on the daemon (`POST /api/sessions`)
  and report how to attach the surface it brought up. Options target the daemon
  (`--host`, `--port`, default loopback `127.0.0.1:4321`) and shape the session
  (`--cwd`, `--permission-mode`, `--project`, `--initial-prompt`). Against a daemon with
  no launcher wired yet it surfaces the daemon's own `501` as a clear message.
- **`ccctl attach`** — the UC1 attach on-ramp: list the daemon's running sessions
  (`GET /api/sessions`) with their status and activity, so you can see what to attach to.

This is the on-ramp only — completing the attach (selecting a session and taking over
its terminal) and the full "New session" UX are a later item (#72).

## Layout

Command parsing uses [commander](https://github.com/tj/commander.js); `src/cli.ts` is the
thin executable entry (shebang + argv parse), `src/index.ts` builds the command tree,
`src/dependencies.ts` wires the real daemon / tunnel / patcher / session-client seams
(injectable so the verbs are unit-testable without binding a socket or spawning a
process), and `src/session-client.ts` is the real `fetch`-based `/api/sessions` client the
launch/attach verbs drive. Depends on [`@ccctl/core`](../core),
[`@ccctl/server`](../server), and [`@ccctl/tunnel-adapters`](../tunnel-adapters).
