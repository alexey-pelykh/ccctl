# @ccctl/tunnel-adapters

Pluggable tunnel adapters for [ccctl](../../README.md). Defines one
`TunnelAdapter` interface with interchangeable stub implementations —
`tailscaleAdapter`, `cloudflareAdapter`, `headscaleAdapter` — so
[`@ccctl/cli`](../cli) can expose the loopback-bound
[`@ccctl/server`](../server) through whichever backend the user prefers without
the rest of the system knowing which. An adapter opens a local `HostEndpoint`
and reports the public host clients will reach — the same host the patched
worker's `--sdk-url` allowlist must be told to permit. Depends on
[`@ccctl/core`](../core) for `HostEndpoint`. This package is a skeleton — every
adapter's `open` is a typed stub.
