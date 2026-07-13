// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  classifyIdleHold,
  IDLE_HOLD_MS,
  LIVENESS_FRAME_INTERVAL_MS,
  WORKER_LIVENESS_TIMEOUT_MS,
  type IdleHoldObservation,
} from "./worker-idle-hold.js";

// The pure heart of the #167 idle-hold regression, unit-tested credential-free (no server, no
// stand-in): `classifyIdleHold` maps a receiver-grounded observation to a held / not-held
// verdict. The e2e drive (`worker-idle-hold.e2e.test.ts`) produces real observations against
// the live server; here we pin the decision itself against synthetic ones — a held case and
// each acceptance-criterion breach, including the exact pre-#166 shape (no frame → the deadline
// fires) that must classify as not-held.

/** A canonical HELD observation — idle held past the timeout with a frame in the window and no drop. */
function heldObservation(overrides: Partial<IdleHoldObservation> = {}): IdleHoldObservation {
  return {
    clientEventFrames: 24,
    livenessFrames: 24,
    firstLivenessElapsedMs: LIVENESS_FRAME_INTERVAL_MS + 5,
    drops: 0,
    streamOpenAtEnd: true,
    holdDurationMs: IDLE_HOLD_MS,
    livenessTimeoutMs: WORKER_LIVENESS_TIMEOUT_MS,
    ...overrides,
  };
}

describe("classifyIdleHold — the #167 idle-hold verdict (pure)", () => {
  describe("Rule: held requires idle to survive past the timeout with a frame in the window and no drop", () => {
    it("classifies a clean idle-hold as HELD with no violations", () => {
      const verdict = classifyIdleHold(heldObservation());
      expect(verdict.held).toBe(true);
      expect(verdict.violations).toEqual([]);
      expect(verdict.reason).toMatch(/idle held/);
    });
  });

  describe("Rule: the pre-#166 behavior classifies as NOT held (the regression fails closed)", () => {
    it("a liveness-timeout drop is not held — a real worker would reconnect / re-register (AC1/AC3)", () => {
      const verdict = classifyIdleHold(heldObservation({ drops: 2 }));
      expect(verdict.held).toBe(false);
      expect(verdict.violations.join(" ")).toMatch(/deadline fired 2 time/);
      expect(verdict.violations.join(" ")).toMatch(/reconnected \/ re-registered/);
    });

    it("no liveness frame at all is not held (AC2)", () => {
      const verdict = classifyIdleHold(heldObservation({ livenessFrames: 0, firstLivenessElapsedMs: null }));
      expect(verdict.held).toBe(false);
      expect(verdict.violations.join(" ")).toMatch(/no `client_event` liveness frame/);
    });

    it("the exact pre-#166 shape — silent downstream: no frame AND the deadline fires — names BOTH breaches", () => {
      // Pre-#166 an idle downstream emits zero `client_event` frames, so the reader's deadline
      // lapses with nothing in the window. Both the drop and the missing frame must be named, so
      // the regression's failure is legible (not a single generic "not held").
      const verdict = classifyIdleHold(
        heldObservation({ clientEventFrames: 0, livenessFrames: 0, firstLivenessElapsedMs: null, drops: 3 }),
      );
      expect(verdict.held).toBe(false);
      expect(verdict.violations.length).toBeGreaterThanOrEqual(2);
      expect(verdict.violations.join(" ")).toMatch(/deadline fired 3 time/);
      expect(verdict.violations.join(" ")).toMatch(/no `client_event` liveness frame/);
    });
  });

  describe("Rule: a frame that lands past the window does not count toward the deadline in time (AC2)", () => {
    it("a first frame later than the timeout is not held", () => {
      const verdict = classifyIdleHold(heldObservation({ firstLivenessElapsedMs: WORKER_LIVENESS_TIMEOUT_MS + 50 }));
      expect(verdict.held).toBe(false);
      expect(verdict.violations.join(" ")).toMatch(/past the .* liveness window/);
    });

    it("a first frame exactly at the window boundary still holds (≤ timeout is in-window)", () => {
      const verdict = classifyIdleHold(heldObservation({ firstLivenessElapsedMs: WORKER_LIVENESS_TIMEOUT_MS }));
      expect(verdict.held).toBe(true);
    });
  });

  describe("Rule: the server must still hold the downstream at the end (AC3)", () => {
    it("a reaped server-side downstream is not held", () => {
      const verdict = classifyIdleHold(heldObservation({ streamOpenAtEnd: false }));
      expect(verdict.held).toBe(false);
      expect(verdict.violations.join(" ")).toMatch(/no longer held the worker downstream open/);
    });
  });

  describe("Rule: a hold that never crossed the deadline proves nothing (degenerate-window guard)", () => {
    it("a hold shorter than the timeout is not held even with frames and no drop", () => {
      // The subject being evaluated is degenerate: the drive never reached the deadline, so a
      // "held" verdict would be vacuous. Guard it exactly like a cardinality-zero gate.
      const verdict = classifyIdleHold(heldObservation({ holdDurationMs: WORKER_LIVENESS_TIMEOUT_MS - 1 }));
      expect(verdict.held).toBe(false);
      expect(verdict.violations.join(" ")).toMatch(/did not exceed the liveness timeout/);
    });

    it("a hold exactly equal to the timeout is not held (must strictly exceed it)", () => {
      const verdict = classifyIdleHold(heldObservation({ holdDurationMs: WORKER_LIVENESS_TIMEOUT_MS }));
      expect(verdict.held).toBe(false);
    });
  });

  describe("scaled-time constants keep the essential contract (interval < timeout < hold)", () => {
    it("the server emit interval sits below the modeled worker deadline, and the hold exceeds it", () => {
      expect(LIVENESS_FRAME_INTERVAL_MS).toBeLessThan(WORKER_LIVENESS_TIMEOUT_MS);
      expect(IDLE_HOLD_MS).toBeGreaterThan(WORKER_LIVENESS_TIMEOUT_MS);
    });
  });
});
