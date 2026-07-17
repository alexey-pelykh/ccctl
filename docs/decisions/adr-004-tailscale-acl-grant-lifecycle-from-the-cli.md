---
type: architecture-decision-record
number: 4
title: "Tailscale ACL grants, driven from the CLI: idempotent provisioning, an asserted out-of-process release, and a shutdown that does not wait on the API"
date: 2026-07-17
status: approved
decision_makers: [ccctl maintainer]
related_issues: [242, 153, 148]
supersedes: 2
impact: medium
---

# ADR-004: Tailscale ACL grants, driven from the CLI — idempotent provisioning, an asserted out-of-process release, and a shutdown that does not wait on the API

## Status

**Approved** — 2026-07-17. Supersedes [ADR-002], which decided the provisioning
_model_ but explicitly deferred the CLI wiring that would drive it. Implemented by
[#242].

Most of ADR-002 carries forward unchanged and is restated here so this record stands
alone — ADR-002 remains readable as the historical artifact of the original model, but
two of its clauses are no longer accurate, which is why it is superseded rather than
left standing (see § What changed).

## Decision Makers

- ccctl maintainer.

## Context

[ADR-002] decided how `TailscaleTunnel` may narrow a tailnet's ACL policy: an opt-in,
additive, non-destructive scoped grant, appended on `establish` and reverted on
`teardown`, behind an injected API seam. [#148] implemented it; [#153] supplied the
credential + grant the CLI reads, making provisioning reachable from `ccctl tunnel` /
`ccctl serve --tunnel`.

**But nothing ever called `teardown`.** `establishAndReport` constructed the tunnel
inline and never retained it, so the instance — which holds the only record of what to
revert — was unreachable the moment the call returned. ADR-002's bracket was real in
the adapter and fictional from the CLI: with a token and a grant configured, `establish`
wrote a grant that `ccctl` never removed. Consequences ([#242]): repeated establishes
appended a copy per run, and a grant outlived a tunnel stopped by hand.

Answering "how does the CLI drive the revert" is not a free choice, because the two
verbs have genuinely different lifetimes and neither is negotiable:

- `ccctl serve --tunnel` holds a **listening socket**. It has a lifetime, an owner, and
  an existing shutdown path ([#82]'s local-control floor).
- `ccctl tunnel` has **no socket** and exits immediately. Its `tailscale serve --bg`
  mapping is **detached by design** — it is _meant_ to outlive the command.

And a fire-and-forget establish creates a problem ADR-002 never had to face: the state
`teardown` needs is **in-process**, but the thing it must release is **not**. A later
process starts with nothing.

## Decision

### Carried forward from ADR-002, unchanged

**(1) Ownership scope** — the managed scope is exactly one operator-declared scoped
grant. The read-modify-write shallow-clones the fetched policy, gives `grants` a fresh
array, and writes back under the fetched `ETag` as `If-Match`, so every other operator
section survives verbatim and a concurrent hand-edit is rejected, never clobbered.
`ccctl` never authors a grant and never edits an operator rule in place.

**(2) Credential model** — a bearer credential through the injectable
`TailscaleAclClient` seam, non-persisting: never stored on a tunnel, never on an
`EstablishedTunnel` / `TunnelStatus`, never in the policy document, never logged.

**(3) Opt-in, provision-after-auth, revert-first-on-teardown** — provisioning is absent
by default; the grant is appended only after `serve` is up and mandatory tunnel-auth has
passed; `teardown` reverts the grant **before** turning the serve off, each step
clearing state only on success, so a failed revert leaves the tunnel established and
retryable. (This intra-adapter order is unaffected by (7) below, which is about a
different boundary.)

### New in this record

**(4) `ccctl tunnel` stays fire-and-forget; the revert is `ccctl tunnel <kind> --off`.**

The verb establishes a detached mapping and exits, exactly as before. Its revert is a
second, explicit invocation of the same verb with the same `--host`/`--port`.

The alternative — bracket its own lifetime — was rejected: it would force the verb to
**block** until interrupted, turning "establish a detached mapping" into "hold a tunnel
open". That is a different verb with different semantics, it discards the `--bg`
detachment the adapter deliberately uses, and `serve --tunnel` already _is_ the verb
that holds a tunnel for as long as something is being served. `--off` (rather than a
separate `tunnel down` sub-command) because the off-target must name the mapping the
establish made: sharing one option surface is what keeps the two ends symmetrical.

**(5) Provisioning is idempotent: append only if no equal grant is present, and record
only what was actually appended.**

Because the establishes that write grants are fire-and-forget, an unconditional append
accumulates one copy per run, forever. So an establish that finds an equal grant already
in the policy appends nothing.

It also **records** nothing — so its `teardown` reverts nothing. An equal grant is
value-indistinguishable from one the operator hand-authored, and an establish is an
_implicit_ side effect of bringing a tunnel up; it must not remove a rule it did not
itself write. This narrows ADR-002 § (1)'s "removes the one grant equal to it" to the
more precise **"removes the one grant equal to the one it appended, and only if it
appended one."**

**(6) A later process releases what an earlier one established, by ASSERTING ownership
(`Tunnel.adopt`) — and only ever on an explicit operator instruction.**

`adopt(local)` rebuilds the two release handles a fresh process lacks, from the same
operator-supplied inputs the establish used: the endpoint (the same `--host`/`--port`)
and the declared grant (the same `CCCTL_TAILSCALE_ACL_GRANT`). `teardown` then acts on
them.

Ownership is **asserted, not verified** — out-of-process there is nothing to verify
against. So this is deliberately asymmetric with (5), and the asymmetry is the decision:

|                           | `establish`                                  | `--off` (via `adopt`)         |
| ------------------------- | -------------------------------------------- | ----------------------------- |
| Nature                    | implicit side effect of bringing a tunnel up | explicit operator instruction |
| On finding an equal grant | leaves it, claims nothing                    | removes one copy              |

**Accepted consequence**: if the operator has _also_ hand-authored their declared grant
as a permanent rule, `--off` deletes it, and `establish → --off` is a net removal rather
than a clean round-trip. This is bounded — it only ever removes access (grants are
allow-only, so this cannot widen), and only the one grant the operator declared. We
accept it because the mitigation is a documented usage rule ("keep
`CCCTL_TAILSCALE_ACL_GRANT` ccctl-managed and ephemeral; do not also hand-author it")
and the alternatives are worse: a provenance marker would mutate the operator's grant
verbatim-preservation guarantee, and making `--off` conservative too would leave the
grant unrevertible — the whole defect. It follows that `adopt` must be wired **only** to
an explicit operator verb, never to an inferred or automatic release.

**(7) The daemon's shutdown closes the server FIRST, then reverts the tunnel
best-effort within a timeout.**

`serve --tunnel` retains its tunnel and hands it to [#82]'s shutdown handler as a thunk
(resolved at signal time, because shutdown is armed before the establish so a `Ctrl-C`
mid-establish still lands).

Two constraints fix the order, and they agree:

- **Safety**: closing the server is what actually ends reach. Nothing is listening
  afterwards, so a still-live mapping to a dead port authorizes nobody; reverting the
  grant first buys nothing while the socket is open. (This does **not** contradict (3):
  _inside_ the adapter the serve mapping IS the reach, so revert-then-serve-off is still
  right. Different boundary, different answer.)
- **Liveness**: [#82] promises a graceful close that always lands. The close is fast and
  local; a Tailscale revert is a round-trip to `api.tailscale.com` plus a spawn. Gating
  the floor on a third-party API would break the promise exactly when it matters most —
  a laptop shutting down or a partitioned network is precisely when `SIGTERM` fires
  _and_ when that API is unreachable.

So the revert is best-effort within `DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS` (5s) rather
than unbounded, since a hung API would otherwise hold the process open forever and the
daemon would never exit at all. Failing or outrunning the budget is **not** silent: it
is recorded as `tunnel-teardown-failed` on the [#61] trail, names `--off` as the remedy,
and exits non-zero. A close that fails does not skip the revert — the grant is in the
policy either way.

## What changed from ADR-002

| ADR-002 said                                                                                                               | Now                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| § (1) "on `establish` it appends that one grant"                                                                           | appends **only if no equal grant is present**                                       | (5) — fire-and-forget establishes would otherwise accumulate a copy per run                                                                                                                                                                                                                                                                                                                                         |
| § (1) "removes the one grant equal to it … a duplicate operator grant of the same shape is **never collaterally dropped**" | true for `establish`/`teardown`; **`--off` can remove a grant `ccctl` did not add** | (6) — the guarantee assumed ccctl had added a copy to remove; out-of-process it has not, and ownership can only be asserted                                                                                                                                                                                                                                                                                         |
| § (3) lifecycle is `establish` → `teardown`                                                                                | a third verb, `adopt`, releases across processes                                    | (6) — the detached `--bg` mapping outlives the process that made it                                                                                                                                                                                                                                                                                                                                                 |
| § (1) a revert that empties `grants` deletes the key, leaving the policy "exactly as it was found"                         | holds for `establish`→`teardown`; **`--off` leaves `grants: []`**                   | (6) — the clause is conditional ("if it created the `grants` key"), so it is not violated: an adopting process cannot know whether the establish created the key, and deleting one it may not have created would edit the operator's policy beyond ccctl's managed scope. Not a contradiction — but the two paths genuinely differ in residue, so this record names it rather than let the difference sit unstated. |
| § Risks: "CLI wiring is deferred … provisioning is not yet reachable"                                                      | wiring landed ([#153]); the **revert** now lands too ([#242])                       | the deferred boundary is closed                                                                                                                                                                                                                                                                                                                                                                                     |

## Alternatives Considered

**Bracket `ccctl tunnel`'s own lifetime (no down-verb).** Rejected — see (4): it makes a
detaching verb blocking, which is a different verb, and duplicates `serve --tunnel`.

**Let `--off` remove ALL equal copies.** Rejected: collaterally drops operator duplicates,
which ADR-002 § (1) forbids for good reason. One establish appended at most one copy.

**A provenance marker on the grant** (so ownership is verified, not asserted). Rejected:
it mutates the operator's declared grant, breaking the verbatim-preservation guarantee
that (1) rests on, and Tailscale offers no rule-identity field to carry it. It would also
have to survive the operator re-serializing their policy.

**A local ownership ledger** — record "ccctl appended this grant" on ccctl's OWN side
rather than inside the policy, so `--off` could answer the question (6) can only assert.
This sidesteps both objections above (it neither mutates the operator's grant nor needs a
vendor rule-identity field), and the repo already has the store shape: `device-store-file.ts`
and `session-store-file.ts` do atomic temp-write + `chmod 0600` + `rename` under the user's
home. Because (5) guarantees ccctl appends at most one copy, the ledger only needs a
boolean. Rejected **for now**, not on principle — it trades (6)'s accepted consequence for a
worse failure: a lost or stale ledger (a `$HOME` change, a wiped cache, an operator on a second
machine) makes `--off` refuse and leaves the grant unrevertible, which is exactly the defect
[#242] exists to fix. An assert-anyway fallback would restore the revert but reintroduce the
accepted consequence it was meant to close, and now silently — the operator could no longer
tell which mode they were in. Worth building only alongside a ledger-miss story better than
either horn.

**Revert the tunnel before closing the server.** Rejected — see (7): it buys no security
(the close ends reach anyway) and gates [#82]'s floor on a third-party API.

**Unbounded revert.** Rejected: a hung API would mean the daemon never exits, breaking
the other half of [#82]'s promise.

## Consequences

### Positive

- ADR-002's bracket is **real from the CLI**, on both paths, for the first time.
- Duplicate accumulation is structurally impossible, not merely cleaned up afterwards.
- [#82]'s floor is preserved, and now pinned: the revert is added without gating the close
  on it — the close runs first and the revert is time-boxed, so the process still always
  exits. A test drives a teardown that never settles and asserts the close lands anyway.
- Both revert paths assert against the operator's actual policy in tests, not spies.

### Negative

- `--off` on a hand-authored duplicate deletes it (6). Documented; mitigated by usage.
- **One grant, many daemons**: several `serve --tunnel` daemons sharing one env config
  share one grant — appended by whichever established FIRST, and by (5) recorded only
  there. That daemon's shutdown revokes it while the others still serve; the others
  recorded nothing, so their shutdowns revoke nothing. It is fail-closed (access is
  removed, never widened) and the pre-change duplicate copies were accidentally acting as
  a refcount that (5) removes. Documented in the [`@ccctl/cli` README]; a per-daemon grant
  is the operator-side remedy.
- A shutdown on an unreachable API leaves the grant in the policy after 5s. Reported,
  and `--off` clears it — but it is a real residue.
- A tunnel stopped **outside** `ccctl` (a bare `tailscale serve … off`, or a `SIGKILL`,
  which runs no handler) still leaves the grant. `--off` remains the remedy. This is
  inherent: no in-process handler can run when the process is not asked to stop.

### Risks

- **Ownership is asserted, not verified** (6). The blast radius is bounded to the single
  operator-declared grant and is removal-only, but it is the sharpest edge here and the
  reason `adopt` is contractually restricted to explicit operator verbs.
- **The 5s budget is a judgement, not a measurement.** Too short on a slow link means an
  avoidable residue; too long delays exit. It is injectable, and the failure is reported
  rather than silent, so the cost of a wrong guess is visible and low.

## Confidence and provisionality

- **Fire-and-forget + down-verb (4) — HIGH / grounded.** Forced by `--bg` detachment;
  the alternative changes the verb's meaning.
- **Idempotent append (5) — HIGH / grounded.** Directly pinned by tests, incl. mutation
  checks against the built package.
- **Asserted ownership (6) — MEDIUM / provisional.** The right call given no rule
  identity exists in the Tailscale policy shape, but it rests on a documented usage rule
  rather than a mechanism. Revisit on EITHER trigger: Tailscale exposing per-rule identity
  (the vendor-side fix), or a local ownership ledger acquiring a miss-story that beats both
  horns of its trade-off (the ccctl-side one — see § Alternatives Considered). The second is
  reachable without waiting on a third party, so this is not a decision parked on a vendor.
- **Order + timeout (7) — HIGH on the order** (the close ends reach; the floor must not
  depend on a third party), **MEDIUM on the 5s value** (a judgement, injectable).

## Related Documents

- [ADR-002] — the superseded provisioning model this record carries forward and amends.
- Issue [#242] — this decision and its implementation (the revert path, both ends).
- Issue [#153] — the CLI wiring that made provisioning reachable; [#148] — the adapter model.
- Issue [#82] — the local-control floor whose shutdown path (7) extends.
- `packages/tunnel-adapters/src/index.ts` — `Tunnel.adopt`, the idempotent `#provisionAcl`,
  and `#revertAcl`.
- `packages/server/src/shutdown-signal.ts` — the close-then-revert order and
  `DEFAULT_TUNNEL_TEARDOWN_TIMEOUT_MS`.
- `packages/cli/src/index.ts` — the `tunnel <kind> --off` down-verb and the `serve --tunnel` thunk.
- [`@ccctl/cli` README] — the operator-facing usage rule (6) rests on.

[ADR-002]: adr-002-tailscale-acl-provisioning-model.md
[`@ccctl/cli` README]: ../../packages/cli/README.md
[#61]: https://github.com/alexey-pelykh/ccctl/issues/61
[#82]: https://github.com/alexey-pelykh/ccctl/issues/82
[#148]: https://github.com/alexey-pelykh/ccctl/issues/148
[#153]: https://github.com/alexey-pelykh/ccctl/issues/153
[#242]: https://github.com/alexey-pelykh/ccctl/issues/242
