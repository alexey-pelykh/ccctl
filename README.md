# ccctl — ClaudeCodeControl

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
  (above) is verified today only by a hermetic skeleton — **necessary but not
  sufficient**; the full-flow release gate
  ([#67](https://github.com/alexey-pelykh/ccctl/issues/67)) must prove it
  end-to-end before any real-worker rollout (see
  [Security posture](docs/security-posture.md)). Target scenario: _patched
  headless worker → local server → SSE → inference still hits
  `api.anthropic.com`._

## Requirements

- Node.js **≥ 22**
- [pnpm](https://pnpm.io/) (repo pins `pnpm@11.2.2` via `packageManager`)

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

## License

[AGPL-3.0-only](./LICENSE). Copyright (C) 2026 Oleksii PELYKH.
