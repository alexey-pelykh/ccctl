// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The ID CONTRACT between the shell and the markup it binds against (#199).
//
// `app.js` reads its controls by id at module scope and dereferences them UNCONDITIONALLY, so an id
// renamed in `index.html` leaves the binding `null` and throws a TypeError on first use — taking the
// WHOLE page down, not just the one control. Nothing else in the repo notices: `typecheck` is
// `node --check` (syntax, never semantics) and `@ccctl/e2e` imports the pure modules, never the shell.
//
// This is the CHEAP half of #199 (its option 2), and it is deliberately DOM-ENGINE-FREE: it reads two
// source artifacts and asserts a relation between them, so it costs milliseconds and keeps holding
// even if the jsdom harness beside it (`app.test.js`, option 1) breaks or is retired. Its coverage is
// COMPLETE where the harness's is DEEP: every id the shell binds is checked here — including the ones
// dereferenced only on paths no test drives, which a behavioural harness would have to drive every
// branch to reach. Today that set is exactly `steer-queue` and `steer-queue-section`, touched only
// when the operator steers while OFFLINE: rename either and the harness stays green while the real
// page dies on the next offline steer (`renderSteerQueue` dereferences `steerQueueEl` unconditionally).
// That pair is measured, not assumed — every OTHER id is currently caught by both gates, so this
// file's value rests on the two the harness cannot see, plus every id a future branch stops driving.
// What it cannot see in turn is whether a binding is USED correctly; that is the harness's half.
//
// It is not a tautology w.r.t. the drift it names: the two artifacts are authored independently of
// each other, and "they disagree" is precisely the failure it reads them both to catch.

const SRC_DIR = import.meta.dirname;
const APP_JS = readFileSync(join(SRC_DIR, "app.js"), "utf8");
const INDEX_HTML = readFileSync(join(SRC_DIR, "..", "index.html"), "utf8");

/** Every `getElementById("…")` id literal in the shell — the way it binds every one of its controls. */
function getElementByIdLiterals(source) {
  return [...source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
}

/**
 * Every id the shell READS, however it reaches for it: the `getElementById` bindings above plus the
 * `querySelector("#…")` form. The shell uses none of the latter today — it is covered so that reaching
 * for a control the other way does not quietly escape this contract.
 */
function idsReadByShell(source) {
  const ids = new Set(getElementByIdLiterals(source));
  for (const match of source.matchAll(/querySelector(?:All)?\(\s*"#([A-Za-z0-9_\-:.]+)"\s*\)/g)) {
    ids.add(match[1]);
  }
  return ids;
}

/**
 * Every id the markup DEFINES. Comments are stripped first: `index.html` documents its own controls
 * heavily, and a commented-out mention of `id="stop-button"` must not stand in for the real attribute
 * — that would make this contract pass across exactly the rename it exists to fail.
 */
function idsDefinedByMarkup(html) {
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  return new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

describe("the shell's id contract with index.html (#199)", () => {
  it("reads every control it binds out of the markup that defines it", () => {
    const defined = idsDefinedByMarkup(INDEX_HTML);
    const missing = [...idsReadByShell(APP_JS)].filter((id) => !defined.has(id));

    // Named rather than counted: a failure here should say WHICH control the page will die on.
    expect(
      missing,
      `app.js binds ${missing.join(", ")} but index.html defines no such id — the shell dereferences ` +
        `its bindings unconditionally, so this is the whole UI down on first poll, not one dead control.`,
    ).toEqual([]);
  });

  it("actually sees the bindings — a contract over nothing would pass over anything", () => {
    const ids = idsReadByShell(APP_JS);

    // The anti-vacuity guard. Every assertion above is over the extracted set, so an extractor that
    // silently matched nothing (a refactor away from these call shapes, a regex rotted by a reformat)
    // would report a clean contract over an empty set — the one failure this file cannot afford,
    // because it looks exactly like success.
    expect(ids.size).toBeGreaterThan(0);
    // Canaries: the control whose rename #199 was filed over, and one the jsdom harness demonstrably
    // does NOT reach (`steer-queue` is touched only on an offline steer) — the class this contract
    // exists to cover, so the canary names a member of it rather than an id both gates already catch.
    expect(ids).toContain("stop-button");
    expect(ids).toContain("steer-queue");
  });

  it("can still see EVERY binding — a dynamic id would narrow the contract silently", () => {
    const literals = getElementByIdLiterals(APP_JS);
    const callSites = APP_JS.match(/getElementById\(/g) ?? [];

    // Not a magic count — a self-check. The contract's coverage claim is "every id the shell binds",
    // and it can only honour that while every binding is a literal it can read. A
    // `getElementById(someVariable)` would leave a call site this scan cannot resolve, quietly
    // shrinking the checked set while the suite stayed green. Failing here forces the choice into the
    // open: keep the binding literal, or state on purpose that it is exempt from this contract.
    expect(
      literals.length,
      `${callSites.length} getElementById call sites in app.js but only ${literals.length} resolve to a ` +
        `literal id — a computed binding cannot be checked against index.html, so this contract no ` +
        `longer covers every control it claims to.`,
    ).toBe(callSites.length);
  });
});
