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
operator-owned central state the adapter relies on by default and never edits in
place.

Passing a `TailscaleAclProvisioning` opts into **narrowing** that policy through
the Tailscale API, behind an injectable `TailscaleAclClient` seam (parallel to
`CommandRunner`, so it is unit-tested with no live tailnet or token). It is
**additive and non-destructive**: after mandatory-auth passes, `establish` appends
one operator-declared scoped grant and `teardown` removes exactly that grant,
preserving every operator rule verbatim (`If-Match` optimistic concurrency guards
against clobbering a concurrent edit) and reverting cleanly with no orphaned
grant. The API credential rides the seam only, never persisted or logged. It is
**opt-in** — with no provisioning injected the adapter relies on the operator's
ACL exactly as before. See
[ADR-002](../../docs/decisions/adr-002-tailscale-acl-provisioning-model.md) for
the provisioning model. The `CloudflareTunnel` / `HeadscaleTunnel` backends land
in later items and remain typed stubs.
