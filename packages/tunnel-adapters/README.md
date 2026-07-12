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
open inbound port**, in deliberate contrast to `tailscale funnel` — then reads
`tailscale status` once to both **enforce mandatory tunnel-auth** (it refuses
unless the node is an authenticated, connected tailnet member, so an
unauthorized device can never reach the daemon) and resolve the node's tailnet
host; `status()` reports whether the tunnel is up and the host it is reachable
at; and `teardown()` turns that same serve mapping back off, releasing it
cleanly. The instance tracks what it served, so `status` / `teardown` act on
exactly the mapping `establish` brought up. Which authenticated devices may
reach the endpoint is governed by the tailnet's own **ACL policy** —
operator-owned central state the adapter relies on and deliberately never
provisions or overwrites. The `CloudflareTunnel` / `HeadscaleTunnel` backends
land in later items and remain typed stubs.
