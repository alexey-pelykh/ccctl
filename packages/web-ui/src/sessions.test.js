// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  ACTIVITY_LABELS,
  activityLabel,
  sessionLabel,
  notificationsDegraded,
  diffSessionList,
  nextSelection,
} from "./sessions.js";

/** A `SessionSummaryWire` fixture — the `GET /api/sessions` row shape; a prompting (non-degraded) row. */
function summary(id, status, activity) {
  return { id, status, activity, notificationsDegraded: false };
}

describe("activityLabel", () => {
  it("maps the activity tri-state to the issue's per-session status vocabulary (#25 AC1)", () => {
    expect(activityLabel({ kind: "running" })).toBe("running");
    expect(activityLabel({ kind: "idle" })).toBe("idle");
    // `requires_action` reads as "awaiting-input" per the AC.
    expect(activityLabel({ kind: "requires_action", detail: "Approve the edit?" })).toBe("awaiting input");
    expect(ACTIVITY_LABELS).toEqual({ running: "running", requires_action: "awaiting input", idle: "idle" });
  });

  it("surfaces an unrecognized string kind verbatim rather than hiding it", () => {
    expect(activityLabel({ kind: "paused" })).toBe("paused");
    // An inherited Object property name (`toString`, `constructor`, …) is still surfaced
    // verbatim, not resolved to the inherited member the bare label lookup would return.
    expect(activityLabel({ kind: "toString" })).toBe("toString");
  });

  it("falls back to 'unknown' for a shapeless activity, never throwing", () => {
    expect(activityLabel(undefined)).toBe("unknown");
    expect(activityLabel(null)).toBe("unknown");
    expect(activityLabel("running")).toBe("unknown");
    expect(activityLabel(["running"])).toBe("unknown");
    expect(activityLabel({})).toBe("unknown");
    expect(activityLabel({ kind: 42 })).toBe("unknown");
  });
});

describe("sessionLabel", () => {
  it("reads a row as id, transport status, and human activity", () => {
    expect(sessionLabel(summary("sess-1", "ready", { kind: "running" }))).toBe("sess-1 — ready · running");
    expect(sessionLabel(summary("sess-2", "ready", { kind: "idle" }))).toBe("sess-2 — ready · idle");
    expect(sessionLabel(summary("sess-3", "busy", { kind: "requires_action", detail: "x" }))).toBe(
      "sess-3 — busy · awaiting input",
    );
    expect(sessionLabel(summary("sess-4", "connecting", { kind: "idle" }))).toBe("sess-4 — connecting · idle");
  });

  it("defends a missing status so a partial row still labels", () => {
    expect(sessionLabel({ id: "sess-5", activity: { kind: "running" } })).toBe("sess-5 — unknown · running");
  });
});

describe("notificationsDegraded", () => {
  it("degrades only on a literal true — the #26 life-long marker the badge (#27) surfaces", () => {
    expect(notificationsDegraded({ id: "s", notificationsDegraded: true })).toBe(true);
    expect(notificationsDegraded({ id: "s", notificationsDegraded: false })).toBe(false);
  });

  it("reads a missing / non-boolean marker as not-degraded, so a partial or pre-#26 row shows no badge", () => {
    // A row that predates #26 (or any partial projection) omits the field entirely.
    expect(notificationsDegraded({ id: "s" })).toBe(false);
    // Strictly boolean: a truthy non-boolean must not light the badge.
    expect(notificationsDegraded({ id: "s", notificationsDegraded: "true" })).toBe(false);
    expect(notificationsDegraded({ id: "s", notificationsDegraded: 1 })).toBe(false);
  });

  it("never throws on a shapeless value", () => {
    expect(notificationsDegraded(undefined)).toBe(false);
    expect(notificationsDegraded(null)).toBe(false);
    expect(notificationsDegraded("nope")).toBe(false);
    expect(notificationsDegraded(["notificationsDegraded"])).toBe(false);
  });
});

describe("diffSessionList", () => {
  it("reports every next session as added when nothing was rendered before", () => {
    const next = [summary("a", "ready", { kind: "idle" }), summary("b", "ready", { kind: "running" })];
    const diff = diffSessionList([], next);
    expect(diff.order).toEqual(["a", "b"]);
    expect(diff.added).toEqual([
      { id: "a", label: "a — ready · idle" },
      { id: "b", label: "b — ready · running" },
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
  });

  it("yields no edits when nothing changed between polls", () => {
    const list = [summary("a", "ready", { kind: "idle" }), summary("b", "busy", { kind: "running" })];
    const diff = diffSessionList(list, [
      summary("a", "ready", { kind: "idle" }),
      summary("b", "busy", { kind: "running" }),
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.order).toEqual(["a", "b"]);
  });

  it("updates only the rows whose status or activity moved — the live-status case (#25 AC3)", () => {
    const previous = [summary("a", "ready", { kind: "idle" }), summary("b", "ready", { kind: "idle" })];
    // b's worker starts running; a is unchanged.
    const next = [summary("a", "ready", { kind: "idle" }), summary("b", "busy", { kind: "running" })];
    const diff = diffSessionList(previous, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([{ id: "b", label: "b — busy · running" }]);
  });

  it("reports a vanished session as removed and a fresh one as added", () => {
    const previous = [summary("a", "ready", { kind: "idle" }), summary("b", "ready", { kind: "idle" })];
    const next = [summary("a", "ready", { kind: "idle" }), summary("c", "connecting", { kind: "idle" })];
    const diff = diffSessionList(previous, next);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.added).toEqual([{ id: "c", label: "c — connecting · idle" }]);
    expect(diff.updated).toEqual([]);
    expect(diff.order).toEqual(["a", "c"]);
  });

  it("carries the full next order so the shell can place and reorder rows", () => {
    const previous = [summary("a", "ready", { kind: "idle" })];
    const next = [
      summary("b", "ready", { kind: "idle" }),
      summary("a", "ready", { kind: "idle" }),
      summary("c", "ready", { kind: "idle" }),
    ];
    expect(diffSessionList(previous, next).order).toEqual(["b", "a", "c"]);
  });
});

describe("nextSelection", () => {
  const sessions = [summary("a", "ready", { kind: "idle" }), summary("b", "ready", { kind: "idle" })];

  it("selects the first session when nothing is selected yet and sessions exist", () => {
    expect(nextSelection(null, sessions)).toEqual({ kind: "select", id: "a" });
    expect(nextSelection(undefined, sessions)).toEqual({ kind: "select", id: "a" });
  });

  it("keeps a still-present selection so a live poll never churns the open stream", () => {
    expect(nextSelection("a", sessions)).toEqual({ kind: "keep" });
    expect(nextSelection("b", sessions)).toEqual({ kind: "keep" });
  });

  it("clears the selection when the viewed session has left the list", () => {
    expect(nextSelection("gone", sessions)).toEqual({ kind: "clear" });
  });

  it("keeps (does not select) when the list is empty", () => {
    expect(nextSelection(null, [])).toEqual({ kind: "keep" });
    expect(nextSelection("a", [])).toEqual({ kind: "clear" });
  });
});
