# ccctl — ClaudeCodeControl

A self-hosted control plane for [Claude Code](https://www.anthropic.com/claude-code).

`ccctl` is a local server that speaks Claude Code's native worker `stream-json`
control channel (over its `--sdk-url` transport), so you can steer Claude Code
sessions from a phone or web UI while you're away from your machine — with **no
claude.ai, no public IP, and no open ports**. Model inference and billing stay
on Anthropic under your own paid subscription; `ccctl` never proxies or sees the
model traffic — it only relays the control channel between the worker and your
UI.

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
- **`@ccctl/server`** — the local server: accepts the patched worker's
  `stream-json` control channel and relays it to the UI over Server-Sent Events
  (SSE) + `fetch`.
- **`@ccctl/web-ui`** — a zero-build static UI (plain HTML + vanilla ES modules,
  no framework, no bundler): `EventSource` for the downstream, `fetch` for the
  upstream.
- **`@ccctl/tunnel-adapters`** — a pluggable tunnel-adapter interface with stub
  adapters for Tailscale, Cloudflare, and Headscale behind one interface.
- **`@ccctl/cli`** — the `ccctl` CLI: start the server and pick a tunnel.
- **`@ccctl/e2e`** — end-to-end test package (placeholder). Target scenario:
  _patched headless worker → local server → SSE → inference still hits
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

This is an early skeleton: packages ship minimal typed stubs, not a working
implementation.

## License

[AGPL-3.0-only](./LICENSE). Copyright (C) 2026 Oleksii PELYKH.
