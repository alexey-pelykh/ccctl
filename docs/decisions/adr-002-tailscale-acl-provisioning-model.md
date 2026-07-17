---
type: architecture-decision-record
number: 2
title: "Tailscale ACL provisioning: opt-in, additive, non-destructive grants behind an injected API seam"
date: 2026-07-13
status: superseded
superseded_by: 4
decision_makers: [ccctl maintainer]
related_issues: [148, 56]
impact: medium
---

# ADR-002: Tailscale ACL provisioning — opt-in, additive, non-destructive grants behind an injected API seam

## Status

**Superseded** — 2026-07-17, by
[ADR-004](adr-004-tailscale-acl-grant-lifecycle-from-the-cli.md), which drives this
model's lifecycle from the CLI (the wiring that § Risks below deferred) and, in doing so,
amends two clauses of it. **Read ADR-004 for the current model**; most of this record
carries forward there unchanged, but two statements below are no longer accurate:

- § (1) "on `establish` it appends that one grant" — provisioning is now idempotent:
  it appends only if no equal grant is already present (ADR-004 § (5)).
- § (1) "a duplicate operator grant of the same shape is **never** collaterally
  dropped" — still true of `establish`/`teardown`, but the `ccctl tunnel <kind> --off`
  down-verb asserts ownership it cannot verify, so it CAN remove an identical grant
  `ccctl` did not add (ADR-004 § (6)).

Originally **approved** — 2026-07-13, implemented by [#148] (the `TailscaleAclClient`
seam, non-destructive provisioning in `TailscaleTunnel`, and the credential-hygiene
tests).

## Decision Makers

- ccctl maintainer.

## Context

`@ccctl/tunnel-adapters`' `TailscaleTunnel` ([#56], merged via [#139]) exposes the
loopback-bound daemon over the tailnet with `tailscale serve` and enforces
**mandatory tunnel-auth**: it reads `tailscale status --json` and refuses unless
the node is a `Running`, authenticated tailnet member. It drives **only** `serve`
and `status` behind an injectable `CommandRunner` seam — there is no Tailscale-API
channel and no ACL-provisioning method. _Which_ authenticated devices may reach
the endpoint stays the **operator-owned** tailnet ACL policy; the adapter relies
on it and deliberately never writes it. [#139] flagged the remainder explicitly:

> Full ACL-API provisioning would be a distinct, larger item with its own
> credential wiring — noted here as an explicit boundary, not silently dropped.

This record answers [#148]'s **AC-0**: decide and record the provisioning model —
ownership scope, credential model, lifecycle — **before** implementing, because
the tailnet ACL policy is **global, operator-owned central state** and mutating
it carelessly would clobber hand-authored policy (the blunt-instrument reach
[#139] avoided by not running `serve reset`).

The Tailscale API offers exactly one policy-mutation shape: `GET` the whole
policy (returning an `ETag`) and `POST` the whole policy back (guarded by
`If-Match`). There is **no per-rule endpoint** — every write is a whole-document
write. So "provision a grant" is unavoidably a read-modify-write of the entire
operator policy, and the non-destructive guarantee has to live in _how_ that
read-modify-write is done, not in a narrower API we could have reached for.

## Decision

**(1) Ownership scope — additive / scoped grant; never whole-policy ownership,
never in-place edits of operator rules.**

The adapter's **managed scope** is exactly **one** operator-declared, scoped
grant (a Tailscale `grants[]` entry — typically destined for a ccctl-owned tag
the operator has `tagOwners` for). On `establish` it appends that one grant; on
`teardown` it removes the one grant equal to it. The read-modify-write:

- shallow-clones the fetched policy and gives `grants` a fresh array, so every
  other operator section (`acls`, `groups`, `tagOwners`, `ssh`, `hosts`, …) is
  carried through **verbatim**;
- appends the scoped grant (creating the `grants` key only if it was absent);
- writes back under the fetched `ETag` as `If-Match`, so a concurrent operator
  hand-edit is **rejected, never silently overwritten** (optimistic concurrency).

On revert it removes the **first** grant structurally equal to the one it added
(a single match, so a duplicate operator grant of the same shape is never
collaterally dropped), and — if it created the `grants` key and the array is now
empty — deletes the key so the operator's policy is left **exactly as it was
found**, its own managed grant removed. The `#139` "no policy write" invariant
thus becomes "**no write outside the adapter's managed scope**", pinned by a test
that seeds an operator policy and asserts every
operator rule survives a provision→revert round-trip unchanged.

**(2) Credential model — a bearer credential supplied through an injectable API
seam; non-persisting.**

Provisioning speaks the Tailscale HTTP API behind a new injectable
`TailscaleAclClient` seam, **parallel to `CommandRunner`**: `fetchPolicy()` /
`savePolicy(policy, etag)`. The real implementation, `defaultTailscaleAclClient`,
takes the credential at construction and captures it in its closure; it is sent
**only** as an `Authorization: Bearer <token>` request header and appears nowhere
else. The recommended credential is an **OAuth client with the `acl` scope**
(short-lived access tokens, least privilege); a raw Tailscale API access token
works through the identical Bearer seam.

**Non-persisting posture** (consistent with the account-Bearer boundary in
[`docs/security-posture.md`](../security-posture.md) and the register handshake):
the credential is never stored on a `TailscaleTunnel`, never placed on an
`EstablishedTunnel` / `TunnelStatus` (which carry only `kind` and `publicHost`),
never written into the policy document, and never logged. It is not written to
session state or any persisted snapshot — the adapter has no persistence surface,
and the outward-facing tunnel shapes are unchanged by this item. Tests assert the
token rides the `Authorization` header, is echoed by no `console` sink, and never
surfaces on the tunnel's outputs.

**(3) Lifecycle — provision on establish (after auth), revert on teardown;
fail-closed, idempotent, opt-in.**

- **Opt-in.** Provisioning is absent by default. A `TailscaleTunnel` constructed
  with no provisioning (the `ADAPTERS` registry default, and every Cloudflare /
  Headscale stub) behaves **exactly as [#139]**: it drives only `serve` and
  `status`, relying on the operator's ACL. Provisioning is a second, optional
  constructor argument, so the default and the stubs are untouched.
- **Provision after auth.** The grant is appended **only after** `serve` is up
  **and** mandatory tunnel-auth has passed — never granting access to a node that
  is not a verified, authenticated tailnet member. If the write fails, `establish`
  rejects with the serve still cleanly releasable and **nothing recorded to
  revert** (no orphaned grant).
- **Revert first on teardown, idempotently.** `teardown` reverts the grant
  **before** turning the serve off (withdraw authorization first — fail-closed).
  Each step clears its own state only on success, so a failed revert leaves the
  tunnel **established and retryable** and never orphans the grant; a retry
  completes the revert and then the serve-off. The grant is recorded only after
  its write succeeds, so the revert targets exactly what was provisioned.

## Alternatives Considered

**Full policy ownership — the adapter authors the entire policy.**

- **Pros**: simplest write path (no merge; just `POST` a computed policy).
- **Cons**: obliterates every operator-authored rule on the first `establish` —
  the exact clobber [#139] called out. Irreconcilable with a tailnet whose policy
  is human-owned central state.
- **Why rejected**: destroys operator policy; the opposite of the AC's hard
  non-destructive constraint.

**In-place narrowing — edit existing operator grants to tighten reach.**

- **Pros**: could tighten an over-broad operator rule without adding a new one.
- **Cons**: mutating rules the adapter did not author is inherently clobber-prone
  (no stable identity to target; a re-serialized policy defeats reference
  matching; an operator edit between fetch and write is lost). "Narrowing" the
  effective reachability is achieved additively instead — the scoped grant admits
  a narrow `src`, without touching operator rules.
- **Why rejected**: editing operator-authored rules is the blast radius AC-0
  forbids; additive scoping delivers the same narrowing safely.

**A separate adapter-managed policy document / section.**

- **Pros**: cleanest ownership boundary if the API supported it.
- **Cons**: Tailscale exposes a **single** policy document with a fixed schema;
  there is no second file and no arbitrary-key section to carve out. This option
  is not available on the platform.
- **Why rejected**: not offered by the Tailscale API.

**High-level `provision` / `revert` seam (merge behind the seam).**

- **Pros**: the adapter would not need to understand policy structure.
- **Cons**: the non-destructive merge would live in the real implementation, and
  the fake used in tests would bypass it — so the load-bearing "never overwrites
  operator rules" AC could not be meaningfully asserted in the adapter's unit
  tests. The low-level `fetchPolicy` / `savePolicy` seam keeps the merge in tested
  adapter code, driven against an in-memory policy seeded with operator rules.
- **Why rejected**: it would move the invariant out of the tested surface.

## Consequences

### Positive

- The non-destructive guarantee is **in tested adapter code**, proven by a
  verbatim round-trip against a seeded operator policy — not assumed of an
  untested real client.
- Default behavior and the Cloudflare / Headscale stubs are **untouched**:
  provisioning is opt-in via a second constructor argument, so [#139]'s posture
  remains the default.
- The credential rides one injectable seam and is **non-persisting** by
  construction — off the tunnel, off the outward shapes, out of logs — matching
  the account-Bearer boundary the rest of `ccctl` already holds.
- `If-Match` optimistic concurrency means a concurrent operator hand-edit is
  rejected, not silently clobbered.

### Negative

- A whole-policy read-modify-write is heavier than a hypothetical per-rule call —
  an inherent cost of the Tailscale API shape, mitigated by `If-Match`.
- The credential's ultimate source (an env var read by `@ccctl/cli`) is **not
  wired in this item** — see Risks.

### Risks

- **CLI wiring is deferred.** This item lands the capability behind the seam and
  ships `defaultTailscaleAclClient`, but `@ccctl/cli` does not yet read a token
  (e.g. `CCCTL_TAILSCALE_API_TOKEN`) and construct the provisioning — so
  provisioning is not yet reachable from the `ccctl tunnel` / `serve --tunnel`
  verbs. This is a deliberate, recorded boundary (mirroring how [#139] deferred
  _this_ item): the adapter is complete and unit-tested; wiring the credential
  source + a `--provision-acl`-style opt-in through the CLI is the next item.
  _Mitigation_: the seam and default client are ready, so wiring is additive and
  does not move the adapter.
- **Grant shape is operator-declared.** The adapter brackets whatever scoped grant
  it is given to the session lifecycle; a mis-scoped grant is an operator error,
  not something the adapter can validate. _Mitigation_: recommend a ccctl-owned
  tag destination the operator governs via `tagOwners`; document at the seam.

## Confidence and provisionality

- **Provisioning model — HIGH / grounded.** Additive-scoped + non-destructive +
  opt-in is directly implemented and pinned by tests (round-trip preservation,
  auth-gated provision, retryable revert, credential hygiene).
- **Credential source & CLI opt-in — deferred to the next item.** The _seam_ is
  fixed here; _where the token comes from_ is finalized when the CLI wiring lands,
  cheaply, without moving the adapter — which is why this record is `approved`
  (the model is decided) rather than provisional.

## Related Documents

- Issue [#148] — this decision + implementation (the Tailscale-API channel).
- Issue [#56] / PR [#139] — the mandatory-auth item that deferred this one.
- `packages/tunnel-adapters/src/index.ts` — `TailscaleAclClient`,
  `TailscaleAclProvisioning`, `defaultTailscaleAclClient`, and the provisioning /
  revert logic in `TailscaleTunnel`.
- [`docs/security-posture.md`](../security-posture.md) — § Tunnel-only exposure,
  updated to record the opt-in additive provisioning alongside the default posture.

[#56]: https://github.com/alexey-pelykh/ccctl/issues/56
[#139]: https://github.com/alexey-pelykh/ccctl/pull/139
[#148]: https://github.com/alexey-pelykh/ccctl/issues/148
