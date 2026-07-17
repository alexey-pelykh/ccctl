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
  tunnel exposing an already-running loopback server; `--off` takes it back down (releasing
  the mapping and any ACL grant it provisioned).

Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
and expose it via a `tunnel`.

### Tailscale ACL provisioning (opt-in)

Both tunnel paths (`serve --tunnel tailscale` and `tunnel tailscale`) expose the daemon
over the tailnet and refuse unless the node is an authenticated tailnet member. _Which_
authenticated devices may reach it is the tailnet's own ACL policy — operator-owned state
`ccctl` relies on and never edits, by default.

You can opt into having `ccctl` add one scoped grant to that policy while the tunnel is up
(see [ADR-002](../../docs/decisions/adr-002-tailscale-acl-provisioning-model.md)). It is
**additive**: your own rules are carried through untouched, and a concurrent hand-edit is
rejected rather than overwritten. It needs **both** variables below — a credential says `ccctl`
_may_ write policy, a grant says _what_ to write. With either missing, nothing is provisioned
and the Tailscale API is never called.

| Variable                    | Meaning                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CCCTL_TAILSCALE_API_TOKEN` | Tailscale API bearer credential. An OAuth client's short-lived access token with the `acl` scope is recommended (least privilege); a raw API access token works too. Read from the environment, sent only as an `Authorization: Bearer` header to `api.tailscale.com` — never persisted, never logged. |
| `CCCTL_TAILSCALE_ACL_GRANT` | The scoped grant to bracket to the tunnel, as one JSON Tailscale `grants[]` entry.                                                                                                                                                                                                                     |

```bash
export CCCTL_TAILSCALE_API_TOKEN='tskey-api-…'
export CCCTL_TAILSCALE_ACL_GRANT='{"src":["you@example.com"],"dst":["tag:ccctl"],"ip":["tcp:443"]}'
ccctl tunnel tailscale   # the grant is appended as the tunnel comes up
```

**`ccctl` does not choose who may reach your daemon — you do.** There is deliberately no default
grant. A grant's `src` is what authorizes _which peers_ may connect, and Tailscale grants are
allow-only: a policy is the **union** of its grants, so any `src` `ccctl` invented could only ever
_widen_ your policy, never narrow it. Keep `src` as narrow as the job needs (a user, a `group:`, a
tag). Set only one of the two variables and `ccctl` says so on the way up and leaves provisioning
off — rather than half-arming it, or leaving you to infer it from a phone that cannot connect.

Two things to get right about the `dst` tag, or the grant will match nothing and silently do
nothing: your policy needs a [`tagOwners`](https://tailscale.com/kb/1068/acl-tags) entry for it
(that declares _who may apply_ the tag — it does not apply it), **and the node must actually carry
the tag** (`tailscale login --advertise-tags=tag:ccctl`, the admin console, or the API).

> **The token is visible to launched workers.** `ccctl serve` passes its environment to the
> `claude` workers it launches, so anything in it — including this token — is readable by a
> session. That is true of your whole environment, not something `ccctl` adds, but an `acl`-scoped
> tailnet credential is worth the thought: prefer a short-lived OAuth token, and export it only for
> the `ccctl tunnel` invocation if you would rather workers never see it.

#### Taking the grant back down

The grant is bracketed to the tunnel: it goes in as the tunnel comes up, and comes back out when the
tunnel goes down. **Which verb takes it down depends on which one put it up**, because the two have
different lifetimes:

| You brought it up with   | It comes down when                      | Because                                                                                                                                                    |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccctl serve --tunnel …` | you stop the daemon (`Ctrl-C` / `kill`) | The daemon owns the tunnel's lifetime, so its shutdown reverts the grant and releases the mapping — nothing extra to run.                                  |
| `ccctl tunnel …`         | you run `ccctl tunnel … --off`          | `tailscale serve --bg` is a **detached** mapping meant to outlive the command, so this verb stays fire-and-forget: it exits, and the tunnel keeps serving. |

```bash
ccctl tunnel tailscale --off                      # release the mapping + remove the grant
ccctl tunnel tailscale --off --port 9999          # same --host/--port you served it on
```

`--off` takes the **same `--host`/`--port`** you established with — that is what names the mapping to
release, exactly as `tailscale serve … off` does. Repeated establishes are safe: `ccctl` appends its
grant only if an equal one is not already in your policy, so `ccctl tunnel tailscale` twice leaves
**one** copy, not two.

**Treat `CCCTL_TAILSCALE_ACL_GRANT` as ccctl-managed and ephemeral — do not also hand-author that same
grant into your policy as a permanent rule.** Grants are compared by value, so `ccctl` cannot tell its
own copy from an identical one you wrote by hand, and the two verbs resolve that ambiguity in opposite
directions **on purpose**:

- **`establish` is conservative** — it is an implicit side effect of bringing a tunnel up, so finding an
  equal grant already present, it leaves it alone and does **not** claim it for revert.
- **`--off` is literal** — you typed a verb whose entire job is "remove the declared grant", so it
  removes one copy of `CCCTL_TAILSCALE_ACL_GRANT` **whether or not `ccctl` is the one that added it**.

The consequence to know: if that grant is also a permanent hand-authored rule, `--off` deletes it, and
`ccctl tunnel … && ccctl tunnel … --off` is then a **net removal** rather than a clean round-trip. It
only ever removes access (never widens), and only the one grant you declared — but it is a policy edit
you did not separately ask for. Keep the declared grant ephemeral and this cannot arise.

Two more boundaries. **One grant, many daemons**: if several `ccctl serve --tunnel` daemons share one
env config, only the one that **established** first actually appends the grant — and so only _its_ shutdown
removes it, while the others are still serving (the others appended nothing, so their shutdowns remove
nothing). Staggering shutdowns does not help; give each daemon its own grant. And **a failed revert
changes nothing rather than pretending**: if the API is down or your token expired, `ccctl` leaves the
tunnel up and the grant in place, says so, and exits non-zero — re-running `--off` completes it. A daemon
shutdown gives the revert a few seconds and no more (it will not hold your shutdown open on an
unreachable API); if it times out, the grant is still there and `--off` is how you clear it.

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

## Local control floor

The operator at the machine can **always** kill sessions, revoke every device, and stop the server —
even with a lost phone and every device token revoked. Device-auth gates _remote_ control (over the
tunnel); it never gates the local control path (see [Security posture](../../docs/security-posture.md)
§ "Local control floor"). Two **out-of-band** controls carry the floor — neither touches the daemon's
device-auth-gated HTTP surface, so neither can be gated on a device token:

- **`ccctl revoke-all`** — revoke all paired devices in one action and force re-pairing (the panic
  kill). It empties the server-side paired-device registry (the `0600` device-store snapshot from
  [`@ccctl/server`](../server)), which drops every device's at-rest token hash — the token's only
  stored projection — so every existing device token is refused on next use and every device must
  re-pair (scan a fresh QR from `ccctl serve --tunnel` / `ccctl tunnel`). It reports how many devices
  were revoked, or that nothing was paired.

    Deliberately **adapter-agnostic and daemon-independent**: it is a direct device-store operation,
    touching no tunnel adapter and needing no running daemon or network round-trip — so it works even
    when the daemon or its tunnel is down, which is exactly when a panic control is reached. This is
    the whole-registry counterpart to per-device revoke: `revoke-all` wipes them all, not one.

- **Stop the daemon — `Ctrl-C` / `SIGTERM`.** `ccctl serve` arms `SIGTERM` and `SIGINT` (`Ctrl-C`, or
  `kill <pid>`) for a **graceful** local shutdown: the daemon closes down — releasing every session it
  launched (a taken-over one is left running for you) — and exits. A POSIX signal is deliverable only
  by a same-uid (or root) process on the **same host**, so it is unreachable over the tunnel and needs
  no device token — "local auth" in its strongest form, the same trigger the `SIGUSR1`/`SIGUSR2`
  diagnostics use. A second signal while the close is still running force-exits, so a wedged teardown
  can't trap you. Stopping the daemon is the ultimate local kill: every session it owns goes down with
  it.

## Layout

Command parsing uses [commander](https://github.com/tj/commander.js); `src/cli.ts` is the
thin executable entry (shebang + argv parse), `src/index.ts` builds the command tree,
`src/dependencies.ts` wires the real daemon / tunnel / patcher / session-client / launcher /
device-store seams (injectable so the verbs are unit-testable without binding a socket or spawning a
process), `src/worker-command.ts` builds the patched worker's `remote-control` argv and
binds the patched-binary path (`CCCTL_CLAUDE_BIN`), `src/tailscale-acl.ts` reads the opt-in Tailscale
API credential (`CCCTL_TAILSCALE_API_TOKEN`) and the operator-declared scoped grant
(`CCCTL_TAILSCALE_ACL_GRANT`) and composes the ACL-aware Tailscale tunnel `dependencies.ts`
installs, and `src/session-client.ts` is the
real `fetch`-based `/api/sessions` client the launch/attach verbs drive. Depends on [`@ccctl/core`](../core),
[`@ccctl/server`](../server), and [`@ccctl/tunnel-adapters`](../tunnel-adapters).
