# Security posture

> **Status: stub.** This page records `ccctl`'s baseline security _posture_ — the
> guarantees it is designed to hold, not an as-built description. The worker↔server
> channel's certificate pinning is now specified below (its live TLS handshake lands
> with the real worker — [#67]); the rest of the baseline — the remaining transport
> security, the credential boundary, and the audit trail — is specified in later
> items; see [Deferred to a later item](#deferred-to-a-later-item).

`ccctl` runs entirely on your own machine and relays only Claude Code's
`stream-json` control channel between the worker and your UI. Model inference
and billing stay on Anthropic under your own subscription — `ccctl` never proxies
or sees the model traffic. The sections below record that inference/control
split — with its current verification status — and the posture governing how the
local server is reached.

## The inference/control split — PARTIAL

Redirecting the session **control** channel to the local server must move _only_
the worker/session traffic. Model **inference and billing stay on
`api.anthropic.com`** under your own subscription; the control plane never
proxies or reroutes model traffic. This is the load-bearing correctness claim of
`ccctl` — acceptance criterion **AC-5**.

**Verification status: PARTIAL / skeleton — designed and asserted, not yet proven
end-to-end.** A hermetic end-to-end skeleton ([#18], landed in [PR #104])
exercises the guarantee today: the real `@ccctl/server` takes a real session
register, while a loopback stand-in for `api.anthropic.com` takes a real outbound
inference leg carrying `Host: api.anthropic.com`. That validates the _assertion
mechanism_ and the server's control/inference routing — but it runs with **no
patched Claude Code worker, no real credentials, and no real egress**. It is a
_necessary but not sufficient_ gate: it cannot catch the real, not-yet-built,
separate-codebase worker doing something the stand-in never anticipated. A
passing skeleton is **not** a proven inference-untouched guarantee.

**Hard gate before any real-worker rollout — [#67].** The guarantee is only
proven once the inference-untouched assertion runs inside the release-blocking
full-flow gate: multiple concurrent sessions plus a launched session, over a real
tunnel, against the real host ([#67]). **#67 is a hard gate — it MUST pass before
`ccctl` is enabled against a live worker or real credentials.** The hermetic
skeleton passing does **not**, on its own, authorize a real-credential /
real-worker rollout.

**Oracle-independence — receiver-of-record attribution (do not weaken in a
refactor).** What makes the hermetic gate meaningful is _who_ decides where a
connection went. Every "reached X" verdict is read from the **receiver's own
record** — the `ccctl` server's own session map for the control leg, the
stand-in's own request log for the inference leg — and **never** from the
sender's self-reported destination. A mock that merely claims "I would have
reached `api.anthropic.com`" proves nothing; only the endpoint that actually took
the connection is trusted (the "real outbound connection, not a mock's
self-reported destination" criterion). Preserve this receiver-grounded
attribution across any future refactor of the harness or the assertion:
collapsing it back to sender self-report silently hollows out the guarantee while
the tests stay green.

## Baseline posture

### Localhost-bind by default

The server binds to loopback (`127.0.0.1`) by default. Nothing it serves is
reachable off-box until a tunnel is explicitly attached — there is no implicit
LAN or `0.0.0.0` binding.

### Mandatory local-server auth

Authentication is required for the local server, and the server refuses to
start when no auth is configured. There is no unauthenticated mode — not even
on loopback. The secret is read from either the `CCCTL_LOCAL_SERVER_AUTH`
environment variable or a config file at `$XDG_CONFIG_HOME/ccctl/local-server-auth`
(default `~/.config/ccctl/local-server-auth`); a present-but-empty value on either
source counts as no auth, and when neither is configured the refusal names the env
key, the file path it looked for, and how to configure either. How the secret is
generated, scoped, stored (its at-rest format and permissions), and rotated is the
credential-boundary spec deferred below; this page fixes the refuse-start-without-auth
guarantee and where the secret is read from, not its lifecycle.

### Worker↔server certificate pinning

The worker reaches the local server over TLS and **pins the server's public key**:
it trusts only the expected server certificate, and a substituted certificate —
even an otherwise-valid one — is rejected, so the worker channel never establishes.

The pin is on the **SPKI** (the certificate's public key), the RFC 7469
`pin-sha256` construction: the base64 SHA-256 of the certificate's DER
`SubjectPublicKeyInfo`. `@ccctl/core` owns the `SpkiPin` brand and the pure
"trusted iff pinned" decision (`certificatePinMatches`); `@ccctl/server` owns the
`node:crypto` pin computation (`computeSpkiPin`, the sibling of the device-token
hash) and the guard the worker runs (`assertPinnedServerKey`). No certificate is
generated or served by `ccctl` in order to pin it — the guard operates on the
certificate a server presents.

**Rotation / re-pin.** Because the pin is over the KEY, not the whole certificate:

- **A leaf reissue keeps the pin.** Reissuing (renewing) the leaf certificate with
  the SAME key leaves its `SubjectPublicKeyInfo` — and therefore the pin —
  unchanged; there is nothing to re-pin.
- **A key rotation re-pairs.** Rotating the server KEY changes the SPKI, and thus
  the pin; the worker must be given the new pin. To rotate without downtime, pin
  BOTH keys for an overlap window (the pinned set holds more than one `SpkiPin`),
  roll the server to the new key, then retire the old pin. A pinned set is therefore
  always non-empty and MAY hold several keys.

**Scope — mechanism now, live handshake at [#67].** This page specifies, and
`@ccctl/server` ships and unit-tests, the pinning **mechanism**: computing a pin,
accepting the expected key, and rejecting a substituted one. Exercising it over a
REAL loopback TLS socket — a worker that actually speaks TLS and runs the guard, and
the rejection of a plaintext endpoint — lands with the real patched worker in [#67],
the same hard gate every prior security slice defers real-worker proof to. Until
then the encrypted transport itself is not asserted end-to-end.

### Tunnel-only exposure

Off-box access is only ever through an outbound tunnel — the
`@ccctl/tunnel-adapters` backends (Tailscale, Cloudflare, or Headscale). `ccctl`
never needs a public IP, never opens an inbound port, and never registers with
claude.ai. The tunnel is the single path from outside the machine to the
loopback-bound server.

The Tailscale backend makes that tunnel's auth **mandatory**: it exposes the
server with `tailscale serve` (tailnet-private — never the public `tailscale
funnel`) and refuses to establish unless the node is an authenticated, connected
tailnet member, so an unauthorized device can never reach the daemon. _Which_
authenticated devices may reach it is then governed by the tailnet's own ACL
policy — operator-owned central state the adapter relies on **by default** and
never edits in place.

The adapter can **optionally** narrow that policy through the Tailscale API, when
an API credential is supplied through its injectable seam (see
[ADR-002](decisions/adr-002-tailscale-acl-provisioning-model.md)). Provisioning
is **additive and non-destructive**: it appends a single operator-declared scoped
grant on establish and removes exactly that grant on teardown, preserving every
operator-authored rule verbatim (a write outside the adapter's own managed grant
never happens) and rejecting a concurrent operator edit via `If-Match` rather than
overwriting it. The API credential is **non-persisting** — supplied through the
seam, sent only as a bearer `Authorization` header, and never stored on the
tunnel, placed on its outputs, written to session state or a snapshot, or logged.
Provisioning is off unless explicitly wired, so the default posture above is
unchanged.

## Deferred to a later item

This stub deliberately stops at the posture above. The complete security
baseline is specified in a later item and will cover, at minimum:

- **Transport security** — TLS for the tunnel and UI channels. (The worker↔server
  channel's certificate pinning is specified above — #59; its live TLS handshake
  lands with the real worker — #67.)
- **Credential boundary** — how the local-server auth secret is generated,
  scoped, stored (at-rest format and permissions), and rotated (the fuller
  mechanism behind the mandatory-auth guarantee above; reading a provided secret
  from the env var or config file, and the refusal, are done — #57).
- **Audit trail** — what control-channel activity is recorded and how it is
  retained.

[#18]: https://github.com/alexey-pelykh/ccctl/issues/18
[#67]: https://github.com/alexey-pelykh/ccctl/issues/67
[pr #104]: https://github.com/alexey-pelykh/ccctl/pull/104
