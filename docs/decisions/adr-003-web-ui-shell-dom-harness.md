---
type: architecture-decision-record
number: 3
title: "Pinning the zero-build web-ui shell: a jsdom behaviour harness plus a DOM-engine-free id contract"
date: 2026-07-16
status: approved
decision_makers: [ccctl maintainer]
related_issues: [199, 77]
impact: medium
---

# ADR-003: Pinning the zero-build web-ui shell — a jsdom behaviour harness plus a DOM-engine-free id contract

## Status

**Approved** — 2026-07-16. Implemented by [#199] (`packages/web-ui/src/app.test.js`,
`packages/web-ui/src/app.contract.test.js`, and the `jsdom` dev dependency).

## Decision Makers

- ccctl maintainer.

## Context

`@ccctl/web-ui` is a **zero-build** UI: plain HTML plus vanilla ES modules, no framework and no
bundler. Its design deliberately concentrates every decision into pure, DOM-free modules — `stop.js`,
`launch.js`, `sessions.js`, `command.js`, `connection.js`, `transcript.js`, … — each unit-tested,
leaving `packages/web-ui/src/app.js` as thin glue that wires DOM controls to those builders. **That
design is sound and this record does not challenge it.**

What [#199] established is that "thin glue" was an **aspiration the toolchain did not enforce**. The
shell was covered by no test at all: no `app.test.js` existed, and nothing imported `app.js`.
`@ccctl/web-ui`'s `typecheck` is `node --check src/*.js` — **syntax only, never semantics** — and
`@ccctl/e2e` imports the pure modules but never the shell. [#199]'s round-2 adversarial validate
_demonstrated_ (rather than asserted) four mutations to the shell, each of which left `pnpm run test`
fully green:

| Mutation                                                      | Result   |
| ------------------------------------------------------------- | -------- |
| Delete the whole `stopButtonEl.addEventListener("click", …)`  | SURVIVED |
| Drop the `data-stop === "failed"` clear in the `clear` branch | SURVIVED |
| Drop `activityEl.hidden = true` in the `clear` branch         | SURVIVED |
| Rename `id="stop-button"` in `index.html`                     | SURVIVED |

The last is the sharpest. `app.js` binds all **25** of its controls with
`document.getElementById("literal")` at module scope and dereferences them **unconditionally**, so a
renamed id leaves the binding `null` and throws a `TypeError` on the first poll — taking the **whole
UI** down, not one control.

This is **pre-existing and architectural**, not a regression: [#37]'s launch shell has identical
exposure. It is also not hypothetical — [#77]'s round-1 validate found three real defects living in
`app.js`, all by inspection alone, which is the evidence that "correct by inspection" had already
failed there once. [#77] resolved its own share by hoisting the one genuine state _rule_ out of the
shell into `stop.js` as a pinned pure predicate (`keepStopControlDisabled`), leaving only glue behind.
This record settles how the glue itself is pinned — which [#199] explicitly framed as a design
decision, not settled there.

## Decision

**Adopt BOTH [#199]'s option 2 (an id contract) and its option 1 (a jsdom harness).** They are not
redundant: each catches exactly the class the other **structurally cannot**, and that complementarity
was verified by mutation rather than argued (see § Evidence).

**(1) `src/app.contract.test.js` — the id contract. Complete, shallow, DOM-engine-free.**

It extracts every `getElementById("…")` (and `querySelector("#…")`) literal from `app.js`'s **source**
and asserts each id exists in `index.html`, whose comments are stripped first so a commented-out
mention cannot stand in for a real attribute. It runs in the default **node** environment in ~150ms.

Its coverage of the id set is **complete**: it checks all 25 bindings, including the ones dereferenced
only on paths no behavioural test drives. It is not a tautology w.r.t. the drift it names — the two
artifacts are authored independently, and "they disagree" is precisely the failure it reads both to
catch. Two guards keep it from passing **vacuously**, which is the one failure mode it could not
afford because it looks exactly like success: an anti-vacuity assertion (the extracted set is
non-empty and contains canaries), and a self-check that every `getElementById` call site resolves to a
literal — so a computed binding fails loudly rather than silently shrinking the checked set.

**(2) `src/app.test.js` — the behaviour harness. Deep, narrow, jsdom.**

It loads the **real** `index.html` into the document, imports `app.js` (which binds and wires at module
scope), and drives **real events** against the real controls. It pins all **9** module-scope wirings,
the `clear` branch's two mutations, and the deliberate refusal/success asymmetry in the stop status.

Eight of those nine are DOM controls. The ninth is the service-worker `message` listener ([#52]'s tap
that lands on an already-open app), and it is the awkward one: jsdom has no service worker, so
`"serviceWorker" in navigator` is false and that branch is **dead** unless a test asks for it. It is
therefore pinned through an **opt-in** double rather than a default one — a worker present on every load
would silently re-route the push flow off the can't-here branch that is the honest jsdom reading.

Loading the real markup rather than a fixture is load-bearing: a fixture would be a copy of the page
that drifts from it, and **the drift is the bug** — the harness would then agree with itself while the
real page was down.

Each outbound body is asserted against the **real builder's own output** (`inputCommand(…)`,
`stopRequest()`, `launchRequest({…})`) rather than a hand-written copy of the wire shape. The shell's
job is to route a control to the right builder and send what it returns intact, which is exactly what
that comparison tests — and it keeps the wire **vocabulary** out of the harness, since `command.js`
owns that a redirect goes out as `interrupt` and `command.test.js` / `@ccctl/e2e` pin it there.

**(3) jsdom is dev-only, and scoped per-file.**

`jsdom` is a `devDependency` of `@ccctl/web-ui` alone. The **runtime** stays zero-build, no-bundler and
dependency-free ([#199] AC4): the package declares no runtime `dependencies`, `build` already strips
`*.test.js` from `dist`, and every import in the shipped bundle is relative. The
`@vitest-environment jsdom` docblock is **per-file**, so only the harness pays the jsdom cost and the
other 12 web-ui suites keep running in the fast node environment — **no `vitest.config` was added**,
so there is no environment configuration to drift.

## Evidence

Adopted because it was demonstrated, not because it was plausible. Every mutation was applied, run,
and reverted, with `app.js` / `index.html` verified byte-identical to `origin/main` afterwards.

**The detector fails the corpse** — all four mutations [#199] documented as surviving now fail;
mutation runs confirm **25/25** id renames caught (0 survived) and **9/9** module-scope wiring deletions
caught, each by its own named test. `node --check` passed on every single mutation, confirming the gates
are the only thing looking.

That denominator is itself a **corrected** claim, and worth recording as the second falsification this
record carries. Two earlier passes both counted **eight** wirings and reported 8/8 — the count a reader
gets from the eight `addEventListener` calls at column 0. The ninth sits indented inside a top-level
`if ("serviceWorker" in navigator)` block, and deleting it passed `node --check` and **both gates**. A
coverage claim is only as honest as its denominator: 8/8 read as complete while a real, deletable,
whole-feature wiring ([#52]'s warm tap) was pinned by nothing. It is now pinned, and the lesson
generalises — _enumerate the set from the source, not from the shape you expect it to have_.

**The two gates are complementary** — the claim that the contract is additive was tested rather than
asserted, and one form of it was **falsified and corrected**: `launch-status` was assumed to be
harness-invisible, but the harness catches it (the launch test drives that path). The honest case is
an id no test drives:

| Mutation                                                   | jsdom harness | id contract |
| ---------------------------------------------------------- | ------------- | ----------- |
| rename `id="steer-queue"` (dereferenced only when offline) | **misses**    | **catches** |
| rename `id="steer-queue-section"` (same)                   | **misses**    | **catches** |
| delete the approve-button wiring                           | **catches**   | **misses**  |
| cross the wires (prompt form sends the redirect verb)      | **catches**   | n/a         |

A renamed `steer-queue` is a **real** whole-UI-down bug — the shell dereferences `steerQueueEl` the
moment the operator steers while offline — and no behavioural harness catches it without driving every
branch. That is the contract's whole justification, and it is why option 2 is kept alongside option 1
rather than subsumed by it.

## Alternatives Considered

**Option 3 — Playwright in `@ccctl/e2e`, against the real served UI.**

- **Pros**: highest fidelity; the only option that pins the shell against a **real browser**, and the
  only one that could reach layout / paint — which jsdom cannot (it has no layout engine), leaving
  [#83]'s responsive and tap-target criteria out of scope here by construction.
- **Cons**: highest cost — a browser binary in CI, a served UI, and a slow, flake-prone tier — for a
  marginal gain that is **orthogonal to what [#199] is about**. Every mutation [#199] documented is a
  DOM-semantics failure (a null binding, a missing listener, an unclear branch), and jsdom catches all
  of them. `@ccctl/e2e` already pins the pure modules against the **real** ingress, so the
  contract-drift risk a browser would cover is largely covered.
- **Why rejected**: cost is real and immediate; the gain is real but addresses a different failure
  class. **Not foreclosed** — if layout / paint regressions ([#83]) or real-browser-only behaviour ever
  need a gate, Playwright remains the right tool, and it composes with (rather than replaces) both
  gates adopted here.

**Option 4 — accept and document: record that `app.js` is verified by inspection only, and hold the
line that no rule may live there.**

- **Pros**: zero cost; the "no rule in the shell" discipline is genuinely right and [#77] already
  applied it by hoisting `keepStopControlDisabled` into `stop.js`.
- **Cons**: [#199]'s AC2 and AC3 require that the two mutations **fail a gate**, and documentation
  gates nothing. Worse, the premise is already falsified: [#77]'s round-1 defects all lived in this
  file, so "correct by inspection" has an observed failure rate here, not a theoretical one. Even
  granting the discipline, the **id contract** is what would enforce it — which is option 2.
- **Why rejected**: it satisfies no AC and rests on a premise the issue's own history disproves. Its
  sound half — no rule lives in the shell — survives as a standing convention, now **enforced** by the
  gates above rather than merely asserted.

**A source-text assertion for AC3 — grep `app.js` for each `addEventListener` call.**

- **Pros**: cheapest possible; needs no DOM engine at all; kills the literal "delete the wiring"
  mutation.
- **Cons**: it asserts the **source** rather than the behaviour. It passes an **emptied handler**
  (verified: gutting the stop handler while keeping the listener fails 3 harness tests, while a
  source-text scan still sees all 17 `addEventListener` sites and passes), and it cannot see a
  crossed wire. It is also the exact tautology `src/stop.test.js` already refuses on its own contract:
  _"Asserting this list against a module-level copy of itself would be a tautology w.r.t. the drift it
  names."_
- **Why rejected**: it would be a gate that reports on the code's spelling rather than its behaviour —
  the appearance of AC3 without its substance.

**A hand-written HTML fixture instead of the real `index.html`.**

- **Pros**: a smaller, more focused document; no coupling to the page's evolving markup.
- **Cons**: the fixture would be a **copy of the contract under test**, so it would drift from
  `index.html` exactly as `app.js` can — and the harness would then agree with its own copy while the
  real page was down. That is the [#199] bug wearing a test's clothes.
- **Why rejected**: it would defeat the purpose; reading the real markup is what makes the gate real.

## Consequences

### Positive

- The four mutations [#199] demonstrated surviving now **fail**, along with all 25 id renames and all
  9 module-scope wiring deletions — verified, not assumed.
- The **runtime is untouched**: `app.js` and `index.html` are byte-identical to before, the change is
  purely additive, and the zero-build / no-bundler / dependency-free properties are intact.
- The other 12 web-ui suites are unaffected and keep their node-environment speed; no `vitest.config`
  exists to drift.
- The shell now has a place to grow tests, so the next glue-level defect is a test failure rather than
  a silent regression — the concrete gap [#77] surfaced.
- "No rule may live in `app.js`" is now **enforceable**: the id contract fails loudly if a binding
  becomes computed, forcing the choice into the open rather than letting coverage shrink quietly.

### Negative

- `@ccctl/web-ui` — a package that is deliberately dependency-free at runtime — now carries a **dev**
  dependency, and jsdom is a large one. The runtime property is preserved, but the dev surface grows.
- jsdom is **not a browser**. It approximates DOM semantics; a real-browser-only behaviour could still
  regress unseen. The harness is honest about its own ceiling rather than implying browser fidelity.
- The harness must stub what jsdom does not implement (`EventSource`, `localStorage`, and — opt-in per
  load — `navigator.serviceWorker`) and what the shell touches at module scope (`fetch`), so it carries
  a small amount of setup that must stay in step with the shell's module-init surface.

### Risks

- **Layout and paint remain unpinned.** jsdom has no layout engine, so [#83]'s responsive and
  tap-target criteria are **out of scope by construction**, not by omission. _Mitigation_: this is the
  known boundary Playwright (option 3) would cross if it is ever needed; the harness's header says so
  explicitly rather than leaving a reader to assume coverage it does not have.
- **The harness's depth is bounded by the paths it drives.** An id dereferenced only on an undriven
  branch is invisible to it. _Mitigation_: this is exactly why the id contract is adopted alongside it,
  and why its coverage of the id set is complete rather than sampled.
- **A branch gated on a capability jsdom lacks is worse than merely undriven — it is unreachable**, so
  it reads as covered while no test can enter it at all, and the id contract does not help (it sees ids,
  not listeners). The service-worker wiring was exactly this, and it is why the count was wrong for two
  passes. _Mitigation_: each such branch needs a deliberate opt-in double, and the honest tell is
  `grep`ping the shell for `in navigator` / `in registration` capability guards rather than trusting a
  green suite to have visited them.

## Confidence and provisionality

- **The adoption — HIGH / grounded.** Both gates are implemented and each was verified by mutation
  against the real corpse, independently re-verified in fresh context across the full 25-id and
  9-wiring surface.
- **The rejection of option 3 — MEDIUM / revisitable by design.** Playwright is rejected **for this
  failure class**, not in principle. The falsifier is explicit: a layout/paint regression, or a
  real-browser-only behaviour, that these gates cannot see. Should that arrive, this record is
  superseded rather than stretched.

## Related Documents

- Issue [#199] — this decision + implementation (the shell's gates).
- Issue [#77] / PR [#244] — the emergency-stop item whose adversarial validate demonstrated the gap and
  filed it under Scope Lock; it hoisted `keepStopControlDisabled` into `stop.js`, leaving glue behind.
- Issue [#37] — the launch shell, which carries the identical exposure this record's gates now cover.
- Issue [#52] — the tapped-push navigate whose module-scope wiring is the ninth, and the one a
  capability-gated branch hid from both gates until an opt-in worker double reached it.
- Issue [#83] — the responsive / tap-target criteria that live beyond jsdom's ceiling.
- `packages/web-ui/src/app.test.js` — the jsdom harness (option 1).
- `packages/web-ui/src/app.contract.test.js` — the id contract (option 2).

[#37]: https://github.com/alexey-pelykh/ccctl/issues/37
[#52]: https://github.com/alexey-pelykh/ccctl/issues/52
[#77]: https://github.com/alexey-pelykh/ccctl/issues/77
[#83]: https://github.com/alexey-pelykh/ccctl/issues/83
[#199]: https://github.com/alexey-pelykh/ccctl/issues/199
[#244]: https://github.com/alexey-pelykh/ccctl/pull/244
