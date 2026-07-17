---
type: architecture-decision-record
number: 5
title: "Bypass mode blocks on AskUserQuestion and on a PreToolUse `ask`: the hook is native-block + enrich-only, and the worker emits the enrichment"
date: 2026-07-17
status: approved
decision_makers: [ccctl maintainer]
related_issues: [263, 78, 261, 262, 264, 265, 266]
impact: medium
---

# ADR-005: Bypass mode blocks on AskUserQuestion and on a PreToolUse `ask` — the hook is native-block + enrich-only, and the worker emits the enrichment

## Status

**Approved** — 2026-07-17. Records the finding of the [#263] spike — the priority-1,
falsifier-convergent unknown that all five panelists of the [#78] `/council`
reconciliation named — and the two decisions that finding settles: the role of the
`PreToolUse` hook, and the SD-1 security fork. The [#78] reconciliation chose **Option A
(hybrid)** and the operator ratified it _conditional_ on this falsifier; the spike
resolves it **favorably**, so Option A stands on evidence rather than on an assumption.

Scope discipline: this record decides the **hook's role** and **who emits the enriched
frame**. It does **not** implement them — the CORE contract is [#261], the HOOK +
installer is [#262], the transport is [#264], and the end-to-end proof against a real
patched worker is the [#266] live-worker gate ([#78]'s AC4, deliberately deferred). What
this spike could **not** observe locally is stated plainly in § What remains open.

## Decision Makers

- ccctl maintainer.

## Context

[#78] wants the interactive "needs-you" moment to reach the operator's phone **even when
Claude Code runs in a non-prompting permission mode** — `--dangerously-skip-permissions`
(`bypassPermissions`). The worry the council converged on: bypass mode might silently
auto-approve everything and **never surface** the block, so the operator is never asked.

The mechanism under test is a `PreToolUse` hook on `AskUserQuestion` that returns
`permissionDecision: "ask"`. Claude Code's docs confirm a **static** `permissions.ask`
rule forces a prompt even in bypass, but are **silent** on whether a **hook-injected**
`ask` is honored there. [#78] also flagged a favorable sub-case worth testing first:
`AskUserQuestion` may **already** block in bypass, because it is a tool call, not a
permission decision.

Two facts about ccctl's architecture make this answerable **without** a patched worker or
credentials, and constrain the answer:

- **The permission engine under test is stock.** ccctl spawns a **patched**
  `claude remote-control` worker, but [`ccctl-patch`](https://github.com/alexey-pelykh/ccctl-patch)
  **only re-scopes the `--sdk-url` host-allowlist predicate** (`src/predicate.ts`) — it
  "re-scopes the allowlist check; it never removes it… There is no 'allow all' path." It
  ships **no Anthropic bytes** and touches **nothing** in the permission subsystem.
  Therefore the stock binary's `bypassPermissions` behavior **is** the patched worker's
  `bypassPermissions` behavior. Local `claude` 2.1.212 (which has no patch manifest yet,
  so it is verbatim stock) is a sound oracle for the permission semantics under test.

- **The block must stay worker-sourced ([#40]).** `isInputAwaited` is single-sourced:
  a session needs you when, and **only** when, its activity is `requires_action`, derived
  through `sessionActivityFromStatus` — the choke point both the §4 `PUT …/worker` gate
  and the §5 `worker/events` leg fold through — "from the `worker_status` feed and nothing
  else, so this predicate **structurally CANNOT fire from any other source**"
  (`packages/core/src/index.ts`). `session-model.test.ts` ratifies the negative half: a
  hook / non-`worker_status` event is a **structural no-op** —
  `applyWorkerStatusFrame(idle, hook)` returns the **same object** (`expect(afterHook).toBe(idle)`).
  Hooks may feed only the **separate** informational class (idle > X, [#41]); they never
  feed the blocking one. Any design in which the hook _itself_ moves `isInputAwaited`
  is forbidden by construction.

## Evidence

A control plus four conditions, against stock `claude` 2.1.212,
`--permission-mode bypassPermissions`. The runs were local and transient, so this record
is the artifact: what they showed is below, and the one payload shape a build item needs
is reproduced verbatim in § What remains open rather than left as a pointer.

| #                 | Setup                                                       | Observation                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control**       | bypass · no hook · `-p`                                     | `Bash` auto-approved and ran — bypass does what it says.                                                                                                                                                                                                             |
| **b-headless**    | bypass · `PreToolUse:Bash` returns `ask` · `-p`             | Hook **fires** (`permission_mode: bypassPermissions` is passed to it); the `ask` **is honored** — but with no prompt surface in `-p` it collapses to a **deny** (`is_error: true`, command never ran).                                                               |
| **b-interactive** | bypass · `PreToolUse:Bash` returns `ask` · TUI              | Hook **fires**; the `ask` becomes a **genuine blocking prompt** — _"Hook PreToolUse:Bash requires confirmation… Do you want to proceed? 1. Yes 2. No"_ — the session sits awaiting the operator.                                                                     |
| **a-native**      | bypass · native `AskUserQuestion` · TUI                     | `AskUserQuestion` **blocks awaiting input** (_"Enter to select"_); answering released it and the turn resumed. bypass does **not** suppress it. In `-p` the tool is **not even offered** (absent from the init tool list) — it needs an interactive surface.         |
| **enrich**        | bypass · `PreToolUse:AskUserQuestion` returns _allow_ · TUI | Hook **fires** and receives the **full** payload — `tool_input.questions[]` with `question`, `header`, `options[].label`, `options[].description`, `multiSelect` — and, returning no decision, **leaves the native block intact**. Enrich-only is mechanically real. |

**The falsifier resolves favorably, twice over.** A hook-injected `ask` **is honored in
bypass mode** (the doc gap is now closed by observation), and — the favorable sub-case —
`AskUserQuestion` **blocks in bypass natively**, with no hook needed to force it.

## Decision

### 1. The block is native; the hook is enrich-only (for `AskUserQuestion`)

`AskUserQuestion` is an **interaction tool, not a permission decision**, so
`bypassPermissions` — which suppresses permission _prompts_ — does not touch it. In the
`remote-control` worker (which, unlike `-p`, has an interactive surface) the agent's
`AskUserQuestion` call therefore produces a **real awaiting-input block**. That block is
exactly the state the worker reports as `worker_status: requires_action` (the sole [#40]
source). **No hook is required to create the needs-you block.**

The `PreToolUse` hook's role narrows to **enrichment**: it fires on the same
`AskUserQuestion` call and reads the structured question + options payload (proven
available above); that payload then rides the **separate §5 informational channel** —
which `foldWorkerStatus` classifies as non-`worker_status` and therefore **cannot** move
`isInputAwaited`. This is precisely [#78] Option A's structure: the block is honored
**structurally** (worker-sourced), the question/options are **informational**, and [#40]
is preserved by construction, not by prose.

> A [#78]-Option-A subtlety this spike sharpens: because the block is **native**, the hook
> must **not** return `ask` on `AskUserQuestion` — doing so would stack a redundant
> permission prompt in front of the native question (a double prompt). The enrich hook
> returns _allow_ (no decision) and only captures the payload. Whether the enrichment
> payload is even sourced from the hook, versus from the worker's own native surfacing of
> the `AskUserQuestion` control request, is left to [#261]/[#262] — this spike proves the
> hook **can** supply it; it does not mandate that it **must**.

### 2. Reject the static `permissions.ask` variant

A static `permissions.ask` rule also forces a block in bypass, but it is strictly worse
for this goal: a permission prompt is a **yes/no over a tool call**, carrying **no**
structured question or option set, and it offers **no** enrichment hook. It cannot
deliver the "question + tappable options" [#78] exists to surface. The hook path captures
the rich payload; native `AskUserQuestion` supplies the block. `permissions.ask` gives
neither advantage and loses the payload.

### 3. SD-1 — the worker emits the enriched frame, not the hook

The hook demonstrably **holds** the enrichment payload — but the enriched frame must be
emitted by the **worker**, over its authenticated §5 `worker/events` channel, for three
reasons that compound:

- **[#40]**: the blocking signal must stay worker-sourced. A hook that presented a token
  and POSTed a frame **directly** would be a **second source** of the needs-you signal —
  forbidden structurally (§ Context). The worker's §5 emission folds through
  `sessionActivityFromStatus` like every other status; a hook's direct POST would not.
- **Auth**: the worker already holds the per-session `session_ingress_token` (minted in
  `environments-bridge.ts`) and is the channel's intended authorized client. The hook
  would have to acquire and present a credential **independently** — a new secret-bearing
  client, larger attack surface, for a payload the worker can already carry.
- **[#59] pinning**: the worker is the leg that pins the server's SPKI cert. A separate
  hook-originated client would either bypass that pin or re-implement it.

So the hook's contribution is **capture-and-hand-off** (payload → the worker's emission
path), never **emit**. This inherits auth + [#59] pinning for free and keeps the [#40]
single-source invariant intact.

## What remains open (deferred to [#266], [#78]'s AC4)

This spike proves the **block** — natively and via the hook — against the stock permission
engine. It does **not**, and by design cannot, observe the **last hop**: that the block
actually surfaces as a `worker_status: requires_action` frame over the §4/§5 channel
**end-to-end against the real patched worker**. That requires a patched binary + a
credentialed server — the [#266] live-worker gate, where every prior security/interop
slice defers its real-worker proof (the [#67] hard gate). The inference is strong (the
worker's contract defines `requires_action` as "awaiting steer input", which is the
observed state), but it is an inference until [#266] is green — [#78]'s AC4 stays
**PENDING** until then, exactly as the reconciliation framed it.

Two facts to carry forward for the build items:

- The `bypassPermissions` mode string **is** passed to the hook (`permission_mode` field),
  so a hook can condition on it if ever needed.
- The `AskUserQuestion` payload shape observed is
  `{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }`
  — the concrete shape [#261]'s enrichment contract must model.

## Consequences

- [#262] (HOOK + installer): the `PreToolUse` hook on `AskUserQuestion` is **enrich-only**
  (returns _allow_, captures the payload) — **not** a block-forcing `ask`. It is the
  repo's first hook and first settings installer.
- [#261] (CORE contract): the enrichment type models the payload shape above and rides an
  **informational** class that `foldWorkerStatus` no-ops on — never `worker_status`.
- [#264] (transport): the enriched frame is a **worker** emission on the authenticated §5
  channel (SD-1), inheriting the `session_ingress_token` + [#59] pin.
- [#265] (`notificationsDegraded`): unaffected by the block finding, but see the [#78]
  thread — the native-block result means bypass is **not** a degraded path for the
  needs-you moment.
- [#266] (live-worker e2e): owns the [#78]-AC4 end-to-end `requires_action` proof this
  spike defers.

[#263]: https://github.com/alexey-pelykh/ccctl/issues/263
[#78]: https://github.com/alexey-pelykh/ccctl/issues/78
[#261]: https://github.com/alexey-pelykh/ccctl/issues/261
[#262]: https://github.com/alexey-pelykh/ccctl/issues/262
[#264]: https://github.com/alexey-pelykh/ccctl/issues/264
[#265]: https://github.com/alexey-pelykh/ccctl/issues/265
[#266]: https://github.com/alexey-pelykh/ccctl/issues/266
[#59]: https://github.com/alexey-pelykh/ccctl/issues/59
[#67]: https://github.com/alexey-pelykh/ccctl/issues/67
[#40]: https://github.com/alexey-pelykh/ccctl/issues/40
[#41]: https://github.com/alexey-pelykh/ccctl/issues/41
