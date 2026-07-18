---
type: architecture-decision-record
number: 6
title: "The auto-resolves-permissions marker is launch-time: mid-run mode tracking is deferred, not infeasible"
date: 2026-07-18
status: proposed
decision_makers: [ccctl maintainer]
related_issues: [272, 26, 263, 265, 266, 269, 270, 271]
impact: medium
---

# ADR-006: The auto-resolves-permissions marker is launch-time — mid-run mode tracking is deferred, not infeasible

## Status

**Proposed** — 2026-07-18. Records the decision [#272] asks for: whether ccctl should
TRACK a session's permission mode after birth. Authored autonomously (a `/do-all` batch
item); **the decision is ratification-pending and the PR review is the ratification surface**
— the maintainer either confirms the deferral (this record flips `proposed → approved`) or
redirects to option (a) (this record is superseded by the tracking work). This is a
**judgment call the maintainer should confirm**, because new evidence (below) makes option
(a) feasible and option (a) is the only one that fixes the security-relevant case in
§ Context — see § The maintainer's call.

> **Premise correction (why this record is careful about the word "feasible").** The
> question "can ccctl observe a mid-run mode change?" is an **empirical claim about the stock
> worker's emissions**, and in-tree evidence cannot answer it — a `git grep` of ccctl shows
> only what ccctl _reads_, not what the worker _emits_. Answered by an adversarial **binary
> walk** (canary-verified, § Evidence), the answer is **yes, the worker emits its mode on a
> frame ccctl already ingests** — so mid-run tracking is **feasible**. Any claim that it is
> "infeasible / structurally invisible" is false and must not appear in this record or the
> code it governs.

Scope discipline: this record decides the **marker's temporal contract** (launch-time,
deferring live tracking) and the **badge copy** that contract requires. It does **not**
re-decide the sibling **launch refusal** ([#269], still open) — it only records how this
finding bears on that decision (§ Consequences). It preserves [#265]'s invariant
unconditionally: the marker stays advisory and never gates a notification.

## Decision Makers

- ccctl maintainer (ratifies at PR review, or redirects to option (a)).

## Context

`Session.autoResolvesPermissions` (introduced as `notificationsDegraded` in [#26], renamed
in [#270]) is a **birth-only** boolean: `createSession` derives it ONCE from the permission
mode the session was launched under (`isNonPromptingPermissionMode(permissionMode)`,
`packages/core/src/index.ts:586`) and no ccctl path re-derives it. It drives a standing amber
badge in the web UI and is **advisory** — [#265]'s invariant — never an input to
`reconcileNeedsInput`.

[#272] surfaces that this birth-only marker goes **stale**, and the staleness is
security-relevant. Stock `claude` exposes two ways to change a session's permission mode
**mid-run**:

- a live `set_permission_mode` control request (in the worker's allowlist), and
- the interactive **Shift+Tab** mode cycle (`{acceptEdits, auto, bypassPermissions}`) at the
  worker's own terminal.

ccctl spawns exactly the surface that exposes these:
`claude remote-control --name <name> --permission-mode <mode> --spawn=same-dir`
(`packages/cli/src/worker-command.ts`), which has an interactive surface (ADR-005).

**The security-relevant failure.** The web UI pins launches to `default`
(`packages/web-ui/src/launch.js`), so a launched session's marker is `false` and no badge
renders. The operator presses **Shift+Tab twice** at that terminal and lands in
`bypassPermissions`. The session now auto-approves every tool call — but ccctl's list still
shows **no badge**, because the mode was collapsed to a boolean at birth and never retained.
The UI now implies by omission "this session prompts you" about a session that does not — the
exact inverse of the falsehood [#265] exists to remove, and a security-relevant one (the
operator under-monitors an auto-approving session). The symmetric stale-amber case holds too
(launch under `bypassPermissions`, Shift+Tab back to `default`).

## Evidence

The question [#272] poses reduces to: **can ccctl observe a mid-run mode change against the
stock worker it spawns?** The answer is **yes** — established by a binary walk, because
in-tree evidence answers only the different question "what does ccctl currently read?"

**Finding A — the worker EMITS its mode on every change, on a leg ccctl already ingests
(binary-verified).** Stock binary `~/.local/share/claude/versions/2.1.214` (247 MB;
canary-verified — `remote-control` 107×, `set_permission_mode` 25×, so absence would be
real):

```js
onPermissionModeChanged = (dt) => {
  if (dt==="default"||dt==="acceptEdits"||dt==="bypassPermissions"||dt==="plan"||dt==="auto"||dt==="dontAsk")
    G.enqueue({ type:"system", subtype:"status", status:null, permissionMode:dt, uuid:…, session_id:… });
};
notifyPermissionModeChanged(e) { this.onPermissionModeChanged?.(e); } // ← the Shift+Tab path calls this
```

All six modes enqueue a `{type:"system",subtype:"status",permissionMode}` frame onto the
remote-output stream, and **Shift+Tab reaches it** (`notifyPermissionModeChanged` →
`onPermissionModeChanged`). That stream drains to the §5 `POST …/worker/events` leg, which
ccctl **already reads and relays**: `handleWorkerEvents`
(`packages/server/src/worker-channel.ts:1007-1042`) extracts each `entry.payload`, folds
`worker_status` payloads into the session model (`foldWorkerStatus` **no-ops** on this
`system/status` payload — it is not a `worker_status`), and `broadcastEvent`-relays it
verbatim to the UI. **So ccctl receives the mode-change frame today; it simply does not FOLD
it into the marker.** (A second latent source: the worker's restore-state carries
`type:"permission-mode", permissionMode`, which ccctl's GET `/worker` restore currently
discards.)

**Finding B — the §4 `worker_status` frame carries no mode (true, but does not bound the
answer).** `WorkerStatusEvent` payload is `{ status, detail?, sequence_num? }`
(`packages/core/src/index.ts:1216-1218`), and `InputRequestEvent` carries no mode either. An
in-tree enumeration of what ccctl _consumes_ therefore finds no mode — which is why a
grep-only analysis (and a fresh-context reviewer that reasoned the same way) concluded
"infeasible." The mode does not ride _those_ frames; it rides the `system/status` frame in
Finding A. Read together: mode-tracking is **feasible**, just not yet **wired**.

**Finding C — option (b), the proxied `set_permission_mode`, is the weak path.** ccctl's UI
generates only `input` / `answer` / `approve` / `interrupt`
(`packages/web-ui/src/command.js`; `packages/server/src/ui-command.ts`). Its `relayCommand`
(`ui-command.ts:274-278`) IS a generic `control_request` passthrough — a `set_permission_mode`
POSTed to `/api/sessions/{id}/command` **would reach the worker** — but ccctl forwards it
**without observing** (no code reads the subtype/payload to update the marker), and, decisively,
the **primary [#272] vector is a LOCAL Shift+Tab that never originates a UI command at all**.
So (b) could at most catch phone-originated changes and misses the case that matters. Finding
A's `system/status` emission is the correct signal; (b) is at best complementary.

## Decision

**Option (c): keep the marker LAUNCH-TIME for now — defer mid-run tracking — and make the
badge copy say "at launch", not present-tense current state. Tracking is FEASIBLE (Finding A)
but deferred; it is NOT adopted in this change.**

1. **Contract.** `autoResolvesPermissions` means "this session was **launched** under a
   non-prompting mode." Its birth-only derivation is unchanged; no persisted shape changes,
   so `SESSION_STORE_SNAPSHOT_VERSION` is **not** bumped (it stays `4`, [#270]'s value).

2. **Badge copy** (`packages/web-ui/src/app.js`) stops implying current state. Label and
   title say the session was **launched** under a non-prompting mode and that a mid-run
   Shift+Tab / `set_permission_mode` change is not reflected. The mirrored README is aligned.

3. **[#265] preserved.** The marker stays advisory; `reconcileNeedsInput` is untouched and
   never reads it. (This holds for option (a) too — folding `system/status` would touch the
   marker, not the notification gates — so [#265] is **not** a reason (a) is harder.)

4. **Docstrings** in core/server change their forward-reference to "ccctl does not track this
   **by decision** (ADR-006), the marker is launch-time" — a recorded deferral, not an open
   gap and not an infeasibility.

### Accepted residual (stated, not buried)

Option (c) makes rendered badges and the **stale-amber** case honest, but it does **NOT** fix
the security-relevant case in § Context: a session launched under `default` and Shift+Tab'd
into `bypassPermissions` still shows **no badge** (presence is gated on the birth marker,
`app.js:757`), and the "mid-run change not reflected" caveat only renders on sessions that
_already_ have a badge — so the operator who escalates never sees it. **Only option (a)
surfaces that direction.** Choosing (c) is choosing to accept this residual for now; it is a
deliberate, ratification-pending trade, not an oversight.

### Why (c) now, not (a)

(a) is **feasible but a deliberate PR of its own**, and its value **couples to [#269]** (still
open): drop `readonly` on the marker (`index.ts:558`) so it becomes a moving dimension, revise
the "ONE static birth-property, not a fourth dimension that moves" model (`index.ts:515-519`),
fold `system/status` on ingest, decide whether to retain `permissionMode` (which **would**
bump `SESSION_STORE_SNAPSHOT_VERSION`, right after [#270]'s `3→4`) or re-derive the boolean
live, handle the restore-state re-derivation, re-validate the [#265] advisory-invariant tests
against a now-moving marker, and prove the frame lands end-to-end on Shift+Tab with a
[#266]-style live-worker oracle (real-worker proof is deferred across every ccctl slice — the
[#67] hard gate). [#272] itself lists (c) as the "cheapest" option, and the item is sized `M`.
So (c) is the cheapest **honest** interim; (a) is the right **follow-up**.

## The maintainer's call

Because Finding A flips (a) from "open question" to "feasible", and (a) is the only option
that fixes the § Context security case, the (c)-vs-(a) choice is a judgment the maintainer
should confirm:

- **Confirm (c)** (this record): accept the `default→bypass` residual for now; land the honest
  launch-time framing; open a follow-up for (a) coupled to [#269]. Cheapest; defers real cost.
- **Redirect to (a)**: fold the `system/status` emission into a live marker now (with the cost
  above). Fixes the security case; larger, needs a [#266]-style live oracle; couples to [#269].

## Consequences

- **[#272]** (this record): badge copy in `packages/web-ui/src/app.js` becomes launch-time;
  core/server docstrings align to "by decision (ADR-006)"; no snapshot bump.
- **[#265]** (advisory invariant): unaffected — the marker never gated notifications and still
  does not.
- **[#270]** (rename → `autoResolvesPermissions`, at snapshot `4`): coordinated — (c) retains
  no new field, so `4` stands.
- **[#269]** (re-decide the non-prompting **launch refusal**, still open): this finding
  **strengthens the "remove the refusal" side**. The refusal ("a bypass session could never ask
  for you") rests on the premise ADR-005 already falsified — and it is **trivially
  circumvented**: the operator can Shift+Tab into `bypassPermissions` one second after launching
  under `default` (Finding A shows the worker even _announces_ this over §5). A refusal that is
  both false-premised and one-keystroke-evadable protects nothing. [#269] owns that decision;
  this record only supplies the evidence.
- **Future work (ranked)** — if (c) is confirmed, open a follow-up to adopt (a):
    1. **Primary:** fold the worker's `system/status` `permissionMode` §5 emission (Finding A)
       — and the `permission-mode` restore-state — into the marker as a LIVE dimension; prove it
       with a [#266]-style live-worker oracle. Deferral cost is real and legitimate (§ Why (c)
       now), coupling to [#269]; being _unable_ to do it is not the reason.
    2. **Secondary:** the (b) remote `set_permission_mode` verb (the worker's inbound allowlist
       accepts it, and ccctl's relay already passes it through) — catches phone-originated
       changes only, **misses local Shift+Tab**; complementary to (1), never a substitute.

[#272]: https://github.com/alexey-pelykh/ccctl/issues/272
[#26]: https://github.com/alexey-pelykh/ccctl/issues/26
[#263]: https://github.com/alexey-pelykh/ccctl/issues/263
[#265]: https://github.com/alexey-pelykh/ccctl/issues/265
[#266]: https://github.com/alexey-pelykh/ccctl/issues/266
[#269]: https://github.com/alexey-pelykh/ccctl/issues/269
[#270]: https://github.com/alexey-pelykh/ccctl/issues/270
[#271]: https://github.com/alexey-pelykh/ccctl/issues/271
[#67]: https://github.com/alexey-pelykh/ccctl/issues/67
