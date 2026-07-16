# ccctl

A self-hosted control plane for [Claude Code](https://www.anthropic.com/claude-code).

`ccctl` is a local server that speaks Claude Code's native worker `stream-json`
control channel (over its `--sdk-url` transport), so you can steer Claude Code
sessions from a phone or web UI while you're away from your machine — with **no
claude.ai, no public IP, and no open ports**. Model inference and billing stay
on Anthropic under your own paid subscription; `ccctl` never proxies or sees the
model traffic — it only relays the control channel between the worker and your
UI. That control/inference split is `ccctl`'s load-bearing guarantee; today it is
verified only by a hermetic test skeleton (**partial**) — see
[Security posture](docs/security-posture.md) for its status and the release gate
([#67](https://github.com/alexey-pelykh/ccctl/issues/67)) that must prove it
end-to-end before any real-worker rollout.

A separate patcher, [`ccctl-patch`](../ccctl-patch), re-scopes Claude Code's
`--sdk-url` host-allowlist check so it will accept a localhost or tunnel host.
It ships in its own repository for takedown-isolation and is **not** part of this
workspace.

## Architecture

```
  phone / web UI  ──SSE──▶  @ccctl/server  ──stream-json──▶  patched Claude Code worker
        ▲                        │                                    │
        └────────fetch───────────┘                                    ▼
                                                             api.anthropic.com
                                                          (inference + billing)
```

- **`@ccctl/core`** — the hub: session/state model plus the `stream-json`
  control-channel types (`control_request` / `control_response`, NDJSON
  framing). Every other package depends on this.
- **`@ccctl/server`** — the local server: terminates the patched worker's
  `stream-json` control channel over the environments-bridge flow
  (Bearer-authenticated account legs), and exposes a browser-facing session
  namespace to list, launch (via a tmux launcher), and steer sessions — relaying
  each session's output to the UI over Server-Sent Events (SSE) + `fetch`.
- **`@ccctl/web-ui`** — a zero-build static UI (plain HTML + vanilla ES modules,
  no framework, no bundler): `EventSource` for the downstream, `fetch` for the
  upstream.
- **`@ccctl/tunnel-adapters`** — a pluggable tunnel-adapter interface with
  interchangeable backends: a working Tailscale adapter (tailnet-private
  `tailscale serve` with mandatory tunnel-auth, plus opt-in ACL provisioning),
  while Cloudflare and Headscale remain stubs behind the same interface.
- **`@ccctl/cli`** — the `ccctl` CLI: `patch` the worker, `serve` the local server,
  and expose it through a `tunnel`; plus `launch` / `attach` / `steer` to launch, list,
  and drive sessions on a running daemon.
- **`@ccctl/e2e`** — end-to-end test package. The inference-untouched guarantee
  (above) is asserted by a hermetic skeleton and, since
  [#67](https://github.com/alexey-pelykh/ccctl/issues/67), re-verified **per
  session** inside the full-flow release gate — two concurrent sessions plus one
  launched from the phone, over a real tunnel. That gate's worker and its
  `api.anthropic.com` receiver are still stand-ins (no packaged patched worker
  exists yet), so the guarantee stays **necessary but not sufficient** and must
  still be proven against the real host before any real-worker rollout (see
  [Security posture](docs/security-posture.md)). Target scenario: _patched
  headless worker → local server → SSE → inference still hits
  `api.anthropic.com`._

## Requirements

- Node.js **≥ 22**
- [pnpm](https://pnpm.io/) (repo pins `pnpm@11.2.2` via `packageManager`)

## Maintenance contract

`ccctl` currently tracks **Claude Code 2.1.207** — the version its patch
derivation was developed and verified against. That verification is a
maintainer-local bring-up, **not** the public release gate: the control/inference
split above is still only hermetically verified here, and
[#67](https://github.com/alexey-pelykh/ccctl/issues/67) remains the hard gate
before any real-worker rollout.

Support is **best-effort**. `ccctl-patch` anchors on Claude Code internals, and
Claude Code ships often: every release tracked so far has moved them, and needed
the patch re-derived and re-verified before it worked. Expect no same-day support
for a new release, and no guarantee that any given version can be supported at
all. A version that has not been re-verified is untested, not known-broken.

Two properties bound what best-effort can cost you:

- **Fail-closed, never silently mis-patched.** `ccctl-patch` refuses to touch a
  Claude Code binary it does not recognize, rather than applying a patch derived
  for a different build.
- **No version data is bundled.** The patcher's built-in manifest is an inert
  placeholder — the per-version anchors are derived out-of-band by the maintainer
  and are not committed. Patching any real version means supplying a populated
  manifest yourself (`--manifest <path>`).

This contract covers version tracking only. What `ccctl` does and does not do to
your credentials and your model traffic is a separate, stricter commitment — see
[Security posture](docs/security-posture.md).

## Configuration

The server reads its runtime configuration from the environment — set these
before starting it (`ccctl serve`):

| Variable                  | Default     | Purpose                                                                                                                                                                                          |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CCCTL_CLAUDE_BIN`        | `claude`    | Name or path of the Claude Code binary the server launches for a worker session. Override with an absolute path (or an alternate `PATH` name) when the patched binary is not `claude` on `PATH`. |
| `CCCTL_LOCAL_SERVER_AUTH` | _required*_ | The local server's authentication secret — the server refuses to start without it; there is no unauthenticated mode, even on loopback.                                                           |

\* Or provide the secret in the config file `$XDG_CONFIG_HOME/ccctl/local-server-auth`
(default `~/.config/ccctl/local-server-auth`) — its whole trimmed contents are the secret.
The env var takes precedence; a present-but-empty value on either source counts as no auth.
When neither is configured the refusal names both the env key and the file path it looked for.

## Development

```bash
pnpm install
pnpm build       # turbo run build
pnpm typecheck   # turbo run typecheck
pnpm lint        # prettier --check + turbo run lint
pnpm test        # turbo run test
```

The packages are implemented and covered by unit and end-to-end tests. One
guarantee is still open: the control/inference split is verified today only by a
hermetic skeleton, so `ccctl` is not yet cleared to run against a live worker or
real credentials — see [Security posture](docs/security-posture.md).

## Naming and trademarks

`ccctl` is an **unofficial** project: an independent control plane **for** Claude
Code, built around an independent patch (`ccctl-patch`) **for** Claude Code. It is
**not affiliated with, endorsed by, sponsored by, or supported by Anthropic PBC**.

"Claude" and "Claude Code" are trademarks of Anthropic PBC, used here
**nominatively only** — to identify the software `ccctl` interoperates with, never
as a name for `ccctl` itself. `ccctl` is this project's only name. No Anthropic
logo, brand font, or trade dress is used.

## License

[AGPL-3.0-only](./LICENSE). Copyright (C) 2026 Oleksii PELYKH.
