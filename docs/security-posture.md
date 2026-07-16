# Security posture

> **Status: posture, not fully as-built.** This page records `ccctl`'s baseline
> security _posture_ — the guarantees it is designed to hold. The complete baseline,
> the credential boundary, and the diagnostic/audit surfaces are all specified below.
> Two guarantees are specified but **not yet proven end-to-end against a real worker**
> — the worker↔server channel's live TLS handshake and the release-blocking full-flow
> inference gate both land with the real worker ([#67]); each is flagged inline, and
> the remaining forward-looking work is listed under [What remains](#what-remains).

`ccctl` runs entirely on your own machine and relays only Claude Code's
`stream-json` control channel between the worker and your UI. Model inference
and billing stay on Anthropic under your own subscription — `ccctl` never proxies
or sees the model traffic. The sections below record that inference/control
split (with its current verification status), the baseline posture governing how
the local server is reached, the credential boundary that keeps the account
credential out of everything `ccctl` retains, and the diagnostic/audit surfaces the
daemon exposes.

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

The baseline is four guarantees, each detailed below:

1. **Localhost-bind by default** — the server binds loopback; nothing is reachable
   off-box until a tunnel is explicitly attached.
2. **Mandatory local-server auth** — authentication is required and the server
   **refuses to start** when none is configured; there is no unauthenticated mode.
3. **TLS + certificate pinning on the worker↔server channel** — the worker reaches
   the server over TLS and pins the server's public key, rejecting a substituted
   certificate (mechanism now; live TLS handshake at [#67]).
4. **Mandatory tunnel auth** — off-box access is only ever through an outbound
   tunnel whose auth is mandatory; an unauthorized device can never reach the daemon.

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
key, the file path it looked for, and how to configure either. Where the secret
lives in `ccctl`'s credential map — an operator-owned boot-gate secret, distinct
from the account Bearer — is covered under [Credential boundary](#credential-boundary)
below.

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

## Credential boundary

`ccctl` handles several distinct credentials, and keeping them separate is
load-bearing — the account credential in particular is held to a strict boundary.
The four are:

- the **account Bearer** — the worker's own Anthropic account credential, the
  focus of this section;
- the **local-server auth secret** — the operator-provided boot-gate secret from
  the [mandatory-auth guarantee](#mandatory-local-server-auth) above
  (`CCCTL_LOCAL_SERVER_AUTH` or the XDG config file). It is operator-owned:
  `ccctl` reads it and refuses to start without it, but neither generates nor
  rotates it. It gates startup today; using it as a per-request credential is
  deferred (#57/#58);
- the **session-ingress token** — a secret the server **mints locally** (not the
  account Bearer) to authorize the per-session worker channel. A JSON-safe string
  that may travel the worker wire, it is kept out of logs and snapshots by
  omission (no log or persisted shape carries a field for it) plus a runtime
  redaction test and the end-to-end canary;
- the **tunnel API credential** — the optional Tailscale API token, non-persisting
  and sent only to `api.tailscale.com`, covered under
  [Tunnel-only exposure](#tunnel-only-exposure) above and
  [ADR-002](decisions/adr-002-tailscale-acl-provisioning-model.md).

### The account Bearer — a strict non-persisting pass-through

The account Bearer reaches `ccctl` on exactly two control-plane requests — the
environment register (`POST /v1/environments/bridge`) and the session create
(`POST /v1/sessions`) — and **nowhere else**: the work-poll is uncredentialed, and
the per-session channel is authorized by the locally-minted session-ingress token,
not the account Bearer. On those two requests `ccctl` validates the Bearer **for
presence only** — a missing or malformed `Authorization: Bearer` is refused with
`401` — and then **drops it**. It is never written into a stored environment or
session record, a response body, or a log. This is the "non-persisting
pass-through" the code contracts by name: the credential passes the ingress check
without being retained.

**`ccctl` forwards the Bearer nowhere.** `@ccctl/server` opens no outbound HTTP
connection — it is a pure inbound relay for the control channel. Model inference,
and the account credential that authorizes it, remain the **worker's own direct
leg to `api.anthropic.com`**, which `ccctl` deliberately does not proxy or observe
(the [inference/control split](#the-inferencecontrol-split--partial) above). So the
account credential only ever serves its one legitimate purpose — authorizing the
worker's own inference — and `ccctl` neither relays nor retains it.

- **Never logged.** The account Bearer is modelled as a non-JSON type, and every
  structured-log event shape is **proven JSON-safe at compile time**, so a
  Bearer-carrying log field is a compile error, not a review catch — redaction is
  a property of the log **shape**, not a scrubbing pass (#61). Runtime `toJSON` /
  `toString` redaction and an end-to-end leak canary that greps the real log
  output are defense-in-depth.
- **Never persisted.** The persisted environment and session shapes are likewise
  proven JSON-safe — the non-JSON Bearer cannot be a field — and the file stores
  are written `0600`; the same canary greps the persisted snapshot. **One
  qualification:** an operator-triggered heap snapshot (`SIGUSR2`, see
  [below](#on-demand-heap-snapshot--sigusr2-62)) is a raw copy of process memory
  and can therefore contain a Bearer **in flight** at that instant — the single
  place a credential can reach disk, mitigated by the snapshot's `0600` mode and
  its local-only trigger.
- **Never replayed.** With no stored copy and no outbound client, the Bearer is a
  single-use per-request presence check — there is no retained value, and no leg
  on which one could be replayed.

## Diagnostic and audit surfaces

The daemon exposes one always-on structured trail plus two on-demand
deep-diagnosis pokes. Every trigger is **operator-local** — the daemon's own
lifecycle, or a POSIX signal deliverable only by a same-uid (or root) process on
the same host — and **none is network-reachable**: no diagnostic adds an HTTP
route, and the account-Bearer / session-ingress machinery is untouched by all
three.

### Structured log trail — #61

The trail records six event categories: **session** lifecycle
(created / status / closed / evicted), **registration**
(environment-registered / session-created / work-delivered), **detection**
(activity / worker-registered / stale), **notification** (awaiting-input / idle),
**error** (bind-refused / boot-rejected / listen-failed / launch-failed /
stop-failed), and the on-demand **diagnostic** category (the #62 / #63 surfaces
below). Each event is one JSON line, routed by level — `error` / `warn` to stderr,
everything else to stdout — so the trail is machine-parseable (`… | jq`). It is
**off by default** in the library (a no-op logger) and turned on by the CLI daemon.

**Redaction by construction.** Because the account Bearer is a non-JSON type and
every log-event shape is proven JSON-safe at compile time, **no log line can carry
the account credential** — the type _is_ the redaction boundary, and the writer
needs no scrubbing pass. The locally-minted session-ingress token is a JSON-safe
string, so it is not excluded by that compile proof; it stays out because no event
shape carries a field for it (omission by construction), backed by a server
redaction test and the end-to-end canary. The free-form `detail` field is built from
ids / enums / reasons at every emission site; the one place it carries
worker-supplied text is the `awaiting-input` notification (the worker's
`requires_action` label, bounded to ≤ 200 code points) — session semantic content,
never a credential.

**Retention.** None built in — the trail is a console stream. Persistence,
redirection to a file or a log collector, and any retention or rotation policy are
the operator's (or embedder's) responsibility via the injected writer seam.

### On-demand heap snapshot — SIGUSR2 (#62)

A live heap dump for chasing a memory-growth vector, produced **without
restarting** the daemon. It is triggered by **`SIGUSR2`** — deliverable only by a
same-uid (or root) process on the same host, never over a network or tunnel
("local auth" in its strongest form) — and adds no HTTP route. The file is written
to the OS temp dir by default (or an absolute `CCCTL_HEAP_SNAPSHOT_DIR`),
**owner-only `0600`**: pre-created owner-only so it is never even briefly
world-readable, then re-asserted after V8 writes. The trail records only the
file's path.

**A heap snapshot is a copy of process memory**, so it holds every in-flight
account Bearer and session-ingress token — this is the credential-boundary
qualification noted above, and the whole reason the file is `0600` and signal-gated
to a local operator. There is **no built-in retention**: snapshot files persist
(`0600`) until the OS temp reaper or the operator removes them, and the
absolute-dir override exists precisely so an operator can direct these
secrets-bearing dumps to a controlled (e.g. `0700`, encrypted) location.

### Inspector attach + FD/handle diagnostics — SIGUSR1 (#63)

A handle-count sample plus a Node inspector attach, for chasing a
file-descriptor / handle leak, again **without restarting**. It is triggered by
**`SIGUSR1`** — the same OS-local authorization as the heap snapshot — and one poke
does both actions: it samples the handle counts, then ensures the inspector is
attached. No HTTP route is added.

- **FD/handle report.** `process.getActiveResourcesInfo()` tallied by libuv
  resource type (a climbing `TCPServerWrap` / `PipeWrap` / `Timeout` count across
  samples is a leak), recorded as `diagnostic`/`handle-report` — **counts only,
  never a credential** — and sampled **before** the inspector opens, so it reflects
  the daemon's state before the diagnostic itself perturbs it.
- **Inspector.** Opened **bound to loopback (`127.0.0.1`)** on an ephemeral port,
  never a wildcard / LAN address (mirroring the localhost-bind guarantee, #58), and
  guarded against the non-idempotent double-open; its `ws://` URL rides the trail.
  The inspector is a full debugger — arbitrary code evaluation inside the daemon
  that holds every in-memory secret — so its trigger is the tightest available: a
  same-uid signal, tighter than any loopback HTTP endpoint (which any local uid
  could reach). An authenticated HTTP trigger would instead need the
  local-server-auth secret as a _request_ credential, whose boundary is deferred
  (#57/#58).

Two honesty notes on the inspector's as-built reach. The same-uid authorization
covers **triggering** it; once open, the inspector listens on loopback for the
daemon's lifetime (there is no auto-close) and is attachable by **any local uid**
who discovers the ephemeral port — the ephemeral port is obscurity, not
authorization. And the inspector's `ws://` URL embeds Node's debugger UUID (a weak
attach capability) and lands on stdout — worth noting if stdout is shipped to a log
collector while the inspector stays open. Neither is an account credential, so the
trail's no-credential guarantee holds in the Bearer / ingress-token sense.

## What remains

The posture above is complete for the baseline, the credential boundary, and the
diagnostic/audit surfaces. What is specified but **not yet proven end-to-end**, or
still forward-looking:

- **Live worker↔server proof — [#67].** The worker↔server TLS handshake (the
  certificate-pinning **mechanism** is shipped and unit-tested above) and the
  release-blocking full-flow inference gate both land with the real patched worker.
  **#67 is a hard gate** — it MUST pass before `ccctl` is enabled against a live
  worker or real credentials.
- **Per-request local-server auth — #57/#58.** The local-server-auth secret is a
  boot gate today; using it as a request credential (so a remote-but-authenticated
  diagnostic or UI request becomes possible) is deferred.
- **UI-channel transport** — transport security for the browser↔local-server
  channel beyond the mandatory-auth gate.

[#18]: https://github.com/alexey-pelykh/ccctl/issues/18
[#67]: https://github.com/alexey-pelykh/ccctl/issues/67
[pr #104]: https://github.com/alexey-pelykh/ccctl/pull/104
