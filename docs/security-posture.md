# Security posture

> **Status: stub.** This page records `ccctl`'s baseline security _posture_ — the
> guarantees it is designed to hold, not an as-built description. The full
> baseline (transport security / certificate pinning, the credential boundary,
> and the audit trail) is specified in a later item; see
> [Deferred to a later item](#deferred-to-a-later-item).

`ccctl` runs entirely on your own machine and relays only Claude Code's
`stream-json` control channel between the worker and your UI. Model inference
and billing stay on Anthropic under your own subscription — `ccctl` never proxies
or sees the model traffic. The posture below governs how the local server is
reached.

## Baseline posture

### Localhost-bind by default

The server binds to loopback (`127.0.0.1`) by default. Nothing it serves is
reachable off-box until a tunnel is explicitly attached — there is no implicit
LAN or `0.0.0.0` binding.

### Mandatory local-server auth

Authentication is required for the local server, and the server refuses to
start when no auth is configured. There is no unauthenticated mode — not even
on loopback. How the auth secret is provisioned, scoped, stored, and rotated
is the credential-boundary spec deferred below; this page only fixes the
refuse-start-without-auth guarantee.

### Tunnel-only exposure

Off-box access is only ever through an outbound tunnel — the
`@ccctl/tunnel-adapters` backends (Tailscale, Cloudflare, or Headscale). `ccctl`
never needs a public IP, never opens an inbound port, and never registers with
claude.ai. The tunnel is the single path from outside the machine to the
loopback-bound server.

## Deferred to a later item

This stub deliberately stops at the posture above. The complete security
baseline is specified in a later item and will cover, at minimum:

- **Transport security & certificate pinning** — TLS and certificate pinning
  for the tunnel and UI channels.
- **Credential boundary** — how the local-server auth secret is provisioned,
  scoped, stored, and rotated (the mechanism behind the mandatory-auth
  guarantee above).
- **Audit trail** — what control-channel activity is recorded and how it is
  retained.
