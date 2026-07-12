# @ccctl/tunnel-adapters

Pluggable tunnel adapters for [ccctl](../../README.md). Defines one `Tunnel`
lifecycle contract with interchangeable implementations, so
[`@ccctl/cli`](../cli) can expose the loopback-bound
[`@ccctl/server`](../server) through whichever backend the user prefers without
the rest of the system knowing which. A tunnel's `establish(local)` brings a
local `HostEndpoint` up and reports the public host clients will reach — the
same host the patched worker's `--sdk-url` allowlist must be told to permit.
Depends on [`@ccctl/core`](../core) for `HostEndpoint`.

`TailscaleTunnel` implements the full `Tunnel` lifecycle, driving the
`tailscale` CLI behind an injectable `CommandRunner` seam (so it is unit-tested
with no real tailnet): `establish(local)` runs `serve` to bring the endpoint up
over the tailnet — reachable only inside the tailnet, so **no public IP and no
open inbound port**, in deliberate contrast to `tailscale funnel` — then
resolves the node's tailnet host; `status()` reports whether the tunnel is up
and the host it is reachable at; and `teardown()` turns that same serve mapping
back off, releasing it cleanly. The instance tracks what it served, so
`status` / `teardown` act on exactly the mapping `establish` brought up.
Tailscale ACL provisioning and mandatory tunnel-auth, and the `CloudflareTunnel`
/ `HeadscaleTunnel` backends, land in later items and remain typed stubs.
