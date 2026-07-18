---
type: architecture-decision-record
number: 7
title: "Remove the non-prompting LAUNCH refusal: inform via the marker, do not refuse"
date: 2026-07-18
status: proposed
decision_makers: [ccctl maintainer]
related_issues: [269, 32, 263, 265, 270, 271, 272]
impact: medium
---

# ADR-007: Remove the non-prompting LAUNCH refusal — inform via the marker, do not refuse

## Status

**Proposed** — 2026-07-18. Records the decision [#269] asks for: whether `launchSession`
should keep refusing a launch under a non-prompting permission mode. Authored autonomously
(a `/do-all` batch item); **the decision is ratification-pending and the PR review is the
ratification surface** — the maintainer either confirms the removal (this record flips
`proposed → approved`) or redirects to the considered-and-rejected security-keep option
(§ Considered and rejected), in which case this record is superseded. This mirrors ADR-006's
pattern for its sibling decision.

Scope discipline: this record decides the **launch refusal** only. It does **not** change the
`autoResolvesPermissions` marker, its derivation, or its advisory contract — [#265]'s invariant
holds unconditionally: the marker stays advisory and never gates a notification. It does not
change `NON_PROMPTING_PERMISSION_MODES` membership (that set still derives the marker for all six
modes, unchanged); it only **decouples the launch path** from that predicate.

## Decision Makers

- ccctl maintainer (ratifies at PR review, or redirects to the considered-and-rejected
  security-keep option — § Considered and rejected).

## Context

`launchSession` (`packages/server/src/ui-session-launch.ts`) refused any launch under a
non-prompting permission mode, throwing a typed `non-prompting-mode` failure justified by:

> "a launched session must run under a prompting permission-mode … so it can block on decisions
> and raise the 'awaiting input' signal — `acceptEdits` / `bypassPermissions` never block, so a
> session launched under them could never ask for you"

The refusal traces to **SRV-C-003 / [#32]** (its origin). Its premise is now **falsified**, on
two independent counts:

1. **"could never ask for you" is false (ADR-005 / [#263]).** `AskUserQuestion` is an
   _interaction_ tool, not a permission decision, so a non-prompting mode does not suppress it —
   it **blocks awaiting input natively**, even under `bypassPermissions`. Core states it directly
   (`packages/core/src/index.ts` § `NON_PROMPTING_PERMISSION_MODES`, [#271], binary-verified):
   "Either way a session created under one of these modes CAN block awaiting input (observed)."
   The premise is false for **every** member of the set, not just bypass.

2. **The modes are not equivalent ([#269] comment).** Only `bypassPermissions` "approves EVERY
   tool call without asking." `acceptEdits` auto-accepts _file edits only_ and still prompts on
   non-edit tools; `auto` is a classifier that escalates the uncertain; `dontAsk` auto-**denies**.
   A refusal that lumps all four together as "never blocks" is over-broad for any rationale.

Two further facts frame the decision:

- **The attach path already carries every non-prompting mode.** An attached (UC1) session under
  `bypassPermissions` is listed and steered normally (`ui-sessions.test.ts` § "attaches a
  non-prompting session and carries the persistent auto-resolves-permissions marker"). Launch
  (UC2) refusing the identical mode is the inconsistency [#269] flags — the two paths disagree.
- **ADR-006 supplies converging evidence.** Its § Consequences records that the [#272] finding
  "strengthens the 'remove the refusal' side": the refusal is false-premised and, where the
  operator has local access, one-keystroke-evadable (Shift+Tab into `bypassPermissions`, which the
  worker even announces over §5). [#269] owns the decision; ADR-006 only supplied the evidence.

## Decision

**Remove the launch refusal.** A launch is carried under any permission mode the operator names,
exactly as the attach path already carries it. Concretely:

1. Delete the `isNonPromptingPermissionMode` guard in `launchSession`, the `NON_PROMPTING_MODE_REFUSED`
   reason, and the now-unthrowable `non-prompting-mode` `LaunchFailureCode` (removed from the union,
   the pinned `LAUNCH_FAILURE_CODES`, the status map, and `CALLER_FAULT_CODES`) — a pinned failure
   code nothing can raise would be exactly the dead, false-taxonomy entry [#265] fought.
2. **Reconcile the `web-ui/src/launch.js` pin.** `LAUNCH_PERMISSION_MODE` stays `default`, but as a
   **UI choice, not a server constraint**: `default` is the sensible prompting default for a fresh
   session driven from a phone (it blocks per decision and raises the awaiting-input signal the
   operator steers by), and this control simply surfaces no mode picker — a separate item, not #37's
   scope. The old rationale ("so the server refuses the non-prompting modes") is removed.
3. **Reconcile all six now-falsified-rationale sites** ([#269] comment) plus the taxonomy sites the
   code removal touches, and invert the two refusal tests (HTTP + programmatic) to assert every
   non-prompting mode now launches (201) — the reachable state this change introduces.
4. **Inform via the marker, do not refuse.** The advisory `autoResolvesPermissions` badge
   ([#265]/[#270], made honest by [#272]/ADR-006) is the designed surface that tells the operator a
   session auto-resolves permissions. The design arc [#265]→[#272] is "inform via advisory marker,
   don't gate"; a launch refusal contradicts it. Removal makes launch consistent with that arc and
   with the attach path.

### The security-posture question ([#269] asks it explicitly)

[#269] invites keeping the refusal on a _different, true_ rationale: `bypassPermissions` auto-approves
every tool call, so a remotely-triggerable launch of one is a security-posture concern. Examined, this
does not justify the refusal **as a control**:

- **It is not an authorization boundary.** A remotely-steered `default` session already lets the
  remote party approve every tool call by answering its `requires_action` prompts. `bypassPermissions`
  vs `default` is a visibility/convenience difference for that party, not a new capability — so
  refusing bypass at launch does not raise the authorization bar.
- **It is over-broad for the rationale.** The security concern is `bypassPermissions`-specific;
  `acceptEdits`/`auto` still prompt and `dontAsk` denies. The current refusal blocks all four.
- **It is inconsistent and (locally) evadable.** The attach path carries bypass; a local operator
  can Shift+Tab into it post-launch (ADR-006 Finding A).
- **The honest residual is visibility, and the marker owns it.** The one true difference — a launched
  `bypassPermissions` session runs tools without surfacing each as `requires_action` — is precisely
  what the amber `autoResolvesPermissions` badge exists to flag. Inform, don't refuse.

## Considered and rejected

- **(A) Keep, restated on the security rationale.** Rejected: the _original_ rationale is false, and
  the _security_ rationale does not hold as a control (above). It also could not stand as-is — it is
  over-broad (only bypass approves-all), so "keep" would still require narrowing.
- **(B) Narrow to `bypassPermissions` only, on a security rationale, via a new predicate decoupled
  from `isNonPromptingPermissionMode`.** The strongest alternative — it preserves the one honest
  property (a remote POST cannot _directly_ spawn an auto-runner). Rejected because it (i) fights the
  "inform via the marker, don't gate" arc [#265]→[#272] just built, (ii) reintroduces a launch-time
  guard whose value is weak (not an authorization boundary; locally evadable; the operator explicitly
  opted in — the web UI never sends bypass), and (iii) is inconsistent with the attach path, which
  carries bypass. **This is the option the maintainer should redirect to if they weight the "a remote
  POST must not directly originate an auto-approving session" property higher than the consistency and
  simplicity of removal.** Recorded here so that redirect is a one-line call at PR review.

## Consequences

- **[#269]** (this record): the launch refusal is removed; `non-prompting-mode` leaves the failure
  taxonomy; the six rationale sites + the `launch.js` pin comment + the two refusal tests are
  reconciled; every mode now launches.
- **[#265]** (advisory invariant): unaffected — the marker never gated notifications and still does
  not; its derivation and `NON_PROMPTING_PERMISSION_MODES` membership are unchanged.
- **[#32] / SRV-C-003 (launch half)**: retired. The requirement rested on the falsified premise; its
  attach half (mark a non-prompting session via the marker) stands.
- **ADR-005 / ADR-006**: consistent — ADR-005 falsified the premise; ADR-006 flagged this as the
  "remove" direction and deferred the decision here.
- **Follow-up (optional, not required by this record)**: a launch-time **mode picker** in the web UI
  (out of #37 scope) would let the operator deliberately launch a non-prompting session; when it lands
  it should light the `autoResolvesPermissions` badge for a non-prompting choice.

[#269]: https://github.com/alexey-pelykh/ccctl/issues/269
[#32]: https://github.com/alexey-pelykh/ccctl/issues/32
[#263]: https://github.com/alexey-pelykh/ccctl/issues/263
[#265]: https://github.com/alexey-pelykh/ccctl/issues/265
[#270]: https://github.com/alexey-pelykh/ccctl/issues/270
[#271]: https://github.com/alexey-pelykh/ccctl/issues/271
[#272]: https://github.com/alexey-pelykh/ccctl/issues/272
