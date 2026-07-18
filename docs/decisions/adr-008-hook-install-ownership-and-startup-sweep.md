---
type: architecture-decision-record
number: 8
title: "Hook-install GC: own each install by its daemon's PID, sweep the unowned at startup"
date: 2026-07-18
status: proposed
decision_makers: [ccctl maintainer]
related_issues: [275, 262, 78, 34, 253]
impact: low
---

# ADR-008: Hook-install GC — own each install by its daemon's PID, sweep the unowned at startup

## Status

**Proposed** — 2026-07-18. Records the design [#275] explicitly deferred: its acceptance criteria
are marked _"draft — needs its own scoping before implementation"_, and AC2 states outright that the
race-safety mechanism _"needs explicit design, not a naive 'delete everything on start.'"_ This
record is that design. Authored autonomously (a `/do-all` batch item); **the decision is
ratification-pending and the PR review is the ratification surface** — the maintainer either
confirms the PID-ownership mechanism (this record flips `proposed → approved`) or redirects to one
of the recorded alternatives (§ Considered and rejected), in which case this record is superseded.
Mirrors the pattern [ADR-006] and [ADR-007] set for their own deferred decisions.

## Decision Makers

- ccctl maintainer (ratifies at PR review, or redirects to a recorded alternative).

## Context

[#262] installs a per-launch `AskUserQuestion` hook by writing two files into
`$XDG_STATE_HOME/ccctl/hooks/`: a settings file (passed to the launched worker as `--settings`) and
the handoff path its hook will later write a capture to. Two paths clean them up — a graceful
session close (`session-close.ts`) and a failed launch (`ui-session-launch.ts` § `launchSession`'s
catch).

**Both read `ServerState.hookInstalls`, which is in-memory only.** A daemon `SIGKILL`, an OOM kill,
or a plain restart erases that map entirely. Every file written by a launch that was still live at
that moment becomes permanently unreachable to any future cleanup path: nothing on a fresh daemon
start knows those files exist, let alone that they are safe to delete. This is the first per-launch
artifact class in the repo that can accumulate this way — the session and device stores are keyed
and reconciled against real state on load; these were not.

Two constraints shape any fix:

1. **The directory is shared.** It is derived from `$XDG_STATE_HOME`, which is per-**user**, not
   per-process. Every daemon this user runs on this host writes into the same directory, so a sweep
   cannot assume it is the only writer.
2. **There is no durable ownership record.** The settings file's _contents_ belong to the Claude
   Code CLI's schema and the handoff file is written by the hook, not the daemon — so neither can be
   relied on to carry provenance. Whatever ownership signal exists has to be one the installer fully
   controls.

## Decision

**Stamp each install with its installing daemon's PID in the filename, and sweep at startup every
install whose owner is not alive.**

- The installer writes `{ownerPid}_{token}.{settings,handoff}.json`
  (`hook-settings-installer.ts` § `hookInstallFileName`).
- `startServer` runs `sweepOrphanedHookInstalls()` synchronously in its prologue, beside the [#34]
  orphan-reaper and ahead of `createServer`/`listen`.
- **The directory is INJECTED (`ServerConfig.hookStateDir`), never resolved by the server itself**, and
  absent it the sweep does not run at all. `ccctl serve` passes `resolveHookStateDir()`, so the shipped
  daemon sweeps for real — this is a wired seam, not a [#34]-style "correct seam awaiting its feed".
  The reason it is a seam is specific to this operation: it **deletes**. Resolving the real
  `$XDG_STATE_HOME` internally would make every bare `startServer()` sweep it — including the ~20 unit
  tests that construct a server to exercise something unrelated. That was not hypothetical: an
  adversarial validation pass planted a canary in the developer's real `~/.local/state/ccctl/hooks`
  and watched `ui-sessions.test.ts` — a suite with nothing to do with hooks — delete it, with 129
  genuine orphans sitting in that same directory (independent confirmation the leak is real).
- The sweep reaps exactly three populations, and retains everything else:
    1. installs whose owner PID is **not alive** — the orphan class [#275] reports;
    2. installs owned by the sweeping daemon's **own PID** — necessarily a previous daemon that held
       that PID, since this one has not served a request yet;
    3. **unowned** files older than 24h — pre-this-change installs, plus the **hook's own**
       interrupted atomic writes (`.{16-hex}.tmp`). There are two writers into this directory, and
       the hook's cannot carry an owner stamp: it runs inside the _worker_ process, which knows only
       the handoff path it was handed. Modelling only the daemon's temp form would strand the
       likelier of the two — the worker is the process an operator actually `Ctrl-C`s.

The separator is `_` rather than `-` deliberately: a `randomUUID()` token is `[0-9a-f-]` only, so
`_` cannot occur inside one. Under a `-` separator a legacy UUID whose first group happens to be all
digits (`12345678-…`) would parse as owner PID `12345678`, and the sweep would probe a PID that
never wrote the file. With `_`, "owned" and "legacy" are decidable from the name alone.

### Why this is race-safe (AC2), on both legs

Neither leg depends on a window being "narrow enough"; both are closed by construction:

- **A concurrent daemon mid-launch.** Its just-written files carry _its_ PID, and it is alive for as
  long as it is launching. It is never a candidate. This is precisely the case AC2 names — "avoid
  deleting a file a _just-launched_ session is about to install".
- **This daemon racing itself.** The sweep is sequenced before the listener opens, so the sweeping
  server cannot yet have installed anything of its own — which is what makes reaping its own PID's
  files unconditionally safe.

    Stated precisely, because an earlier draft of this record overclaimed it as "impossible by
    construction" and adversarial validation falsified that: the guarantee is per **`startServer`
    call**, not per **process**. An embedder that starts server A, lets it launch a session, then
    starts server B in the same process would have B reap A's live install — both share a PID. This is
    unreachable through the shipped `ccctl serve` (one server per process) so it is not a shipped
    defect, but it is reachable for an embedder. The precondition is documented where it can actually
    be read before it is violated (`sweepOrphanedHookInstalls`' docstring: _the caller must hold no
    installs of its own_), and the function stays package-internal partly for this reason.

### Fail closed, always

Every uncertainty resolves to RETAIN: a PID that cannot be proven dead (including `EPERM` — a live
process owned by another user), an unreadable directory, a failed `stat`, an unrecognized name, a
`realpath` that escapes the state directory. Retaining a file that could have been deleted costs a
few inert KB — exactly the pre-#275 status quo. Deleting a file still in use costs a live session's
enrichment. The asymmetry is the whole disposition.

## The PID question

`session-reconcile.ts` states a rule this decision appears to break, so it is met directly rather
than worked around:

> **Match by a launch-marker, never a raw PID (AC5).** … A raw PID is exactly the wrong key: the OS
> recycles PIDs, so a dead session's PID may name an unrelated live process on the next start, and
> probing by it would retain a ghost (or, if anything ever acted on it, endanger a stranger).

That rule's own stated rationale names two harms. **Neither reaches this sweep**, and the failure
direction is _inverted_:

- **"Retain a ghost."** In [#34] a false-alive PID **resurrects** a phantom session row into the
  operator's registry — an immortal entry nothing can claim or evict. Here, a false-alive PID merely
  **declines to delete a file**, which is the status quo this issue is improving on. It cannot
  create anything; it can only fail to remove something inert.
- **"Endanger a stranger."** [#34] warns about a reaper that might _act_ on the probed process. This
  module has no signal, kill, or teardown handle anywhere in its types — a `ProcessAlivenessProbe`
  is its only process-shaped capability — and it never touches a path outside the hook state
  directory. The harm is unreachable, not merely avoided.

So the rule holds where it was written (probing a **launched surface**, where a wrong answer
fabricates state and could reach a live process) and does not bind here (probing a **daemon**, where
a wrong answer preserves the current behavior). Per the constraint's own rationale, this is the
distinction that matters — not the word "PID".

The residual is honest and bounded: if a dead daemon's PID is recycled by an unrelated process, its
files are never reaped. That is a leak of a few KB, indistinguishable from today, and the next
restart re-probes.

## Considered and rejected

Recorded verbatim so a maintainer redirect has somewhere to land.

| Alternative                                      | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delete everything on start** (the naive sweep) | Explicitly refused by AC2. A second daemon starting while a first serves would delete the first's live installs and silently break its enrichment.                                                                                                                                                                                                                                                                           |
| **mtime age threshold alone**                    | Does not correlate with orphanhood. A settings file is written once at launch and stays live for the whole session — which may run for days — so any threshold short enough to clear orphans also deletes live installs. (Age is used **only** for legacy unstamped files, where no ownership signal exists at all and the file cannot be a fresh install.)                                                                  |
| **`flock` / advisory lock on each install**      | The **most correct** mechanism: the OS releases it on `SIGKILL`, so there is no PID-recycling hazard at all, and concurrency is handled by the kernel. Rejected as disproportionate — Node has no built-in `flock`, so this needs a **native dependency** for a Low-severity disk-hygiene issue, in a package whose only native dep today is an optional one (`node-pty`). Worth revisiting if this class of artifact grows. |
| **Per-daemon subdirectory** (`hooks/{pid}/…`)    | Identical ownership semantics to the filename stamp, but changes `resolveHookStateDir`'s contract — which the [#266] credentialed e2e gate consumes — for no gain. The flat directory keeps the blast radius to the installer plus one new module.                                                                                                                                                                           |
| **Persist `hookInstalls` to the session store**  | Would make ownership durable "properly", but requires a `@ccctl/core` schema change plus a `SESSION_STORE_SNAPSHOT_VERSION` bump, to durably track state whose entire purpose is to be deleted. Disproportionate, and it still would not answer "is the daemon that wrote this still running?" — which is the actual question.                                                                                               |

## Consequences

**Positive**

- The orphan class [#275] reports is bounded: every restart clears the previous daemon's leftovers.
- Concurrent daemons are safe by construction, not by timing.
- The blast-radius bound is achieved twice over (AC3): the iteration admits only regular files
  (`Dirent.isFile()`, so a planted symlink never reaches the delete) and `unlink(2)` removes a link
  rather than following it; `worker-channel.ts`'s `realpathSync.native` guard is retained on top as a
  second layer. Stated precisely because it is easy to over-credit: the guard's refusal branch is in
  fact **unreachable** from the sweep's own iteration — a regular direct child always resolves back
  into its directory — so it protects a future caller that iterates differently, and the tests credit
  each layer to the one that genuinely performs the work.
- The sweep is **off by default**, so no embedder or test deletes anything it did not ask to.

**Negative / accepted**

- A recycled PID can leave a file unreaped (§ The PID question). Bounded, fail-closed, and
  indistinguishable from today's behavior.
- Legacy unstamped files are reaped on age alone. Worst case — a still-running pre-this-change
  daemon whose install has sat unmodified for over a day — costs an `AskUserQuestion` **decoration**,
  never the native block, since the hook is enrich-only ([ADR-005]).
- **The sweep is unlogged**, and that is a deliberate deferral rather than an oversight. None of the
  six [#61] categories fits: it is not a `session` event (writing one would inject a row with no
  session behind it into the trail whose job is to answer "was this session leaked?"), and it is not
  an `error` either, since the ordinary outcome is success. The honest home is a `diagnostic` event
  name — but those are pinned by `DIAGNOSTIC_LOG_EVENTS` in `@ccctl/core` ([#253]), so adding one is
  a core change with its own round-trip coverage, correctly out of scope here. The sweep returns
  counts instead, which its tests assert against.

[#34]: https://github.com/alexey-pelykh/ccctl/issues/34
[#61]: https://github.com/alexey-pelykh/ccctl/issues/61
[#78]: https://github.com/alexey-pelykh/ccctl/issues/78
[#253]: https://github.com/alexey-pelykh/ccctl/issues/253
[#262]: https://github.com/alexey-pelykh/ccctl/issues/262
[#266]: https://github.com/alexey-pelykh/ccctl/issues/266
[#275]: https://github.com/alexey-pelykh/ccctl/issues/275
[ADR-005]: adr-005-askuserquestion-bypass-block-and-hook-role.md
[ADR-006]: adr-006-auto-resolves-marker-is-launch-time-not-live.md
[ADR-007]: adr-007-remove-non-prompting-launch-refusal.md
