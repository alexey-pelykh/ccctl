// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  TAKEN_OVER_CODE,
  UNKNOWN_STOP_FAILURE_CODE,
  describeStopAccepted,
  isForceable,
  keepStopControlDisabled,
  sessionStopPath,
  stopFailure,
  stopFailureCode,
  stopRequest,
} from "./stop.js";

/**
 * The server's `StopFailureCode` set — a local FIXTURE for the loops below, deliberately not
 * exported by `stop.js`: the module reads a code rather than validating one, so a copy there would
 * gate nothing while still going stale. Asserting this list against a module-level copy of itself
 * would be a tautology w.r.t. the drift it names, so the READING of these codes is pinned against
 * the REAL ingress by `@ccctl/e2e`'s `web-ui-stop-flow.test.ts` instead. Here the list only
 * enumerates inputs. (`TAKEN_OVER_CODE` is the one code `stop.js` DOES name — not to validate the
 * set, but because it is the only refusal this UI can act on.)
 */
const SERVER_FAILURE_CODES = [
  "unknown-session",
  "no-surface",
  "ambiguous-surface",
  "taken-over",
  "liveness-unknown",
  "malformed-request",
  "stop-failed",
];

describe("sessionStopPath", () => {
  it("addresses the ONE named session's stop leg (#20)", () => {
    expect(sessionStopPath("abc-123")).toBe("/api/sessions/abc-123/stop");
  });

  it("is a sibling of the session namespace's other legs, not a subtype of the steer path", () => {
    // A stop is not a steer: it kills the surface the worker runs on rather than asking the worker
    // anything, which is why the server refuses to file it under `/command` at all.
    expect(sessionStopPath("abc-123")).not.toContain("/command");
  });
});

describe("stopRequest", () => {
  it("builds a BARE body by default — the plain stop never mentions force", () => {
    // The server reads an absent `force` as false, so the default body cannot be misread as forcing.
    expect(stopRequest()).toEqual({});
    expect(stopRequest({})).toEqual({});
  });

  it("forces on a literal `true` — the escalation's body", () => {
    expect(stopRequest({ force: true })).toEqual({ force: true });
  });

  it("does NOT force on `false`, and omits the key rather than sending it", () => {
    // Omission (not `{ force: false }`) matches the module's "a blank optional is absent, not empty"
    // reflex, and keeps the non-forcing body the one that mentions nothing.
    expect(stopRequest({ force: false })).toEqual({});
    expect(Object.hasOwn(stopRequest({ force: false }), "force")).toBe(false);
  });

  it("does NOT force on a TRUTHY non-boolean — a UI bug can only ever under-force", () => {
    // Every one of these is truthy in JavaScript and none is an operator saying yes. The server's
    // own parse would refuse them as `malformed-request`; this never sends them in the first place,
    // and — the load-bearing half — the failure direction is the NON-destructive one.
    for (const force of ["true", 1, "yes", "force", {}, [], () => true]) {
      expect(stopRequest({ force })).toEqual({});
    }
  });

  it("never throws on a shapeless argument", () => {
    for (const options of [null, undefined, "force", 7, []]) {
      expect(stopRequest(options)).toEqual({});
    }
  });
});

describe("stopFailureCode", () => {
  it("carries the server's code verbatim for every code the server can answer", () => {
    for (const code of SERVER_FAILURE_CODES) {
      expect(stopFailureCode({ error: "…", code })).toBe(code);
    }
  });

  it("passes an UNRECOGNIZED code through rather than hiding it behind a local set", () => {
    // The UI is a reader of this set, not an enforcer of it: a code this build predates should reach
    // the operator as the server's word for what happened. Visible drift is a bug report; hidden
    // drift is a mystery.
    expect(stopFailureCode({ error: "…", code: "some-future-code" })).toBe("some-future-code");
  });

  it("degrades to `unknown` when there is no usable code — the reachable 405 branch", () => {
    // The ingress's 405 answers `{ error }` with no code (no stop was attempted, so there is no stop
    // failure to type), and a proxy can interpose a body of its own.
    expect(stopFailureCode({ error: "ccctl: GET not allowed on the session stop path" })).toBe(
      UNKNOWN_STOP_FAILURE_CODE,
    );
    expect(stopFailureCode({ code: "   " })).toBe(UNKNOWN_STOP_FAILURE_CODE);
  });

  it("never throws on a shapeless payload", () => {
    for (const payload of [null, undefined, "nope", 7, [], { code: 42 }, { code: null }]) {
      expect(stopFailureCode(payload)).toBe(UNKNOWN_STOP_FAILURE_CODE);
    }
  });
});

describe("keepStopControlDisabled", () => {
  it("keeps the control disabled after a stop the server ACCEPTED, while that session is still selected", () => {
    // The row is already gone — `session-close.ts` drops it — so the control would be offering to
    // stop something that no longer exists. This is the double-tap window: the picker's refresh is
    // still in flight, so the selection still names the session we just killed.
    expect(keepStopControlDisabled({ stopped: true, currentSessionId: "s-1", sessionId: "s-1" })).toBe(true);
  });

  it("re-enables after a REFUSAL — the session is still there, and a retry is safe", () => {
    // What makes refusals retryable at all: a refusal touches no state. Disabling here would strand
    // the operator on a live session they are entitled to stop.
    expect(keepStopControlDisabled({ stopped: false, currentSessionId: "s-1", sessionId: "s-1" })).toBe(false);
  });

  it("re-enables when a DIFFERENT session was selected mid-flight — that one is live, and stoppable", () => {
    // Keyed on the session the attempt was FOR, not on the live selection: conflating them is how a
    // control gets disabled against a session that is perfectly alive.
    expect(keepStopControlDisabled({ stopped: true, currentSessionId: "s-2", sessionId: "s-1" })).toBe(false);
  });

  it("re-enables once the selection is cleared — nothing to key against", () => {
    // The `clear` branch re-renders from the (now null) selection, which disables on its own terms.
    expect(keepStopControlDisabled({ stopped: true, currentSessionId: null, sessionId: "s-1" })).toBe(false);
  });

  it("does not treat a truthy non-`true` outcome as an accepted stop", () => {
    // The caller's `stopped` is a real boolean; this is the module's never-throws posture applied to
    // its own inputs — only a literal accepted stop may disable the one control that stops a runaway.
    expect(keepStopControlDisabled({ stopped: "yes", currentSessionId: "s-1", sessionId: "s-1" })).toBe(false);
  });
});

describe("isForceable", () => {
  it("is true for `taken-over` — the ONE refusal the operator can override", () => {
    // The server refuses because it cannot know whether a human is at that terminal; the operator
    // hitting stop IS that human. That is the whole of what force means.
    expect(isForceable(TAKEN_OVER_CODE)).toBe(true);
    expect(TAKEN_OVER_CODE).toBe("taken-over");
  });

  it("is false for every OTHER code the server can answer — force reaches exactly one", () => {
    for (const code of SERVER_FAILURE_CODES.filter((c) => c !== TAKEN_OVER_CODE)) {
      expect(isForceable(code)).toBe(false);
    }
  });

  it("is false for the two refusals force must never overrule, specifically", () => {
    // `ambiguous-surface`: the terminal may hold a DIFFERENT session's live worker, and nobody can
    // consent to destroying a session they did not name (#20). `liveness-unknown`: forcing on a
    // reading nobody could take is how a stop reports a kill that did not happen. Offering an
    // override here would promise something the server will refuse.
    expect(isForceable("ambiguous-surface")).toBe(false);
    expect(isForceable("liveness-unknown")).toBe(false);
  });

  it("is false for an unrecognized or shapeless code — an unknown refusal earns no destructive offer", () => {
    for (const code of ["some-future-code", UNKNOWN_STOP_FAILURE_CODE, "", null, undefined, 7, {}]) {
      expect(isForceable(code)).toBe(false);
    }
  });
});

describe("stopFailure", () => {
  it("carries the server's own sentence verbatim, never a re-derived one", () => {
    // The server's prose is better than anything this module could write: it echoes the session's
    // own attach hint, which only the server knows.
    const message =
      "ccctl: session s-1 has been taken over — it is being driven at a terminal, and this server will not " +
      "kill a session someone is working in. Reach it with `tmux attach -t ccctl:3`, or re-send this stop " +
      "with `{ force: true }` if you are sure.";
    expect(stopFailure(409, { error: message, code: "taken-over" })).toEqual({
      code: "taken-over",
      message,
      forceable: true,
    });
  });

  it("marks only a taken-over refusal forceable", () => {
    for (const code of SERVER_FAILURE_CODES) {
      expect(stopFailure(409, { error: "…", code }).forceable).toBe(code === TAKEN_OVER_CODE);
    }
  });

  it("falls back to a status-naming sentence when the body carries no usable error", () => {
    // A tunnel's HTML error page parses to null; a hostile body is arbitrary bytes. The operator must
    // never be shown an empty line or the word "undefined".
    expect(stopFailure(502, null)).toEqual({
      code: UNKNOWN_STOP_FAILURE_CODE,
      message: "ccctl: stop failed (HTTP 502)",
      forceable: false,
    });
    expect(stopFailure(500, { error: "  " }).message).toBe("ccctl: stop failed (HTTP 500)");
    expect(stopFailure(500, { error: 42 }).message).toBe("ccctl: stop failed (HTTP 500)");
  });

  it("never throws on a shapeless payload", () => {
    for (const payload of [null, undefined, "nope", 7, [], {}]) {
      expect(() => stopFailure(409, payload)).not.toThrow();
      expect(stopFailure(409, payload).forceable).toBe(false);
    }
  });
});

describe("describeStopAccepted", () => {
  it("says WE killed it, and the terminal state it reached", () => {
    expect(describeStopAccepted({ sessionId: "s-1", outcome: "stopped", status: "closed" })).toBe(
      "stopped s-1 — closed",
    );
  });

  it("says it was ALREADY dead — a different fact, not dressed up as a kill", () => {
    // Both outcomes satisfy the operator's request, but "I killed it" and "it was already dead" are
    // not the same sentence, and the server explicitly declined to claim the first one here.
    expect(describeStopAccepted({ sessionId: "s-1", outcome: "already-exited", status: "closed" })).toBe(
      "s-1 had already exited — closed",
    );
  });

  it("carries an `errored` terminal status rather than flattening every stop to `closed`", () => {
    // A stop does not overwrite the diagnosis of a session that had already failed on its own.
    expect(describeStopAccepted({ sessionId: "s-1", outcome: "stopped", status: "errored" })).toBe(
      "stopped s-1 — errored",
    );
  });

  it("degrades an unrecognized outcome without guessing which of the two ways it ended", () => {
    expect(describeStopAccepted({ sessionId: "s-1", outcome: "vaporized", status: "closed" })).toBe(
      "s-1 is stopped — closed",
    );
  });

  it("names an unnamed session rather than dropping the news of it", () => {
    // A stop the server accepted but would not name is still a stop the operator must be told about.
    expect(describeStopAccepted({ outcome: "stopped", status: "closed" })).toBe("stopped (unknown session) — closed");
  });

  it("drops a missing status rather than printing a dangling separator", () => {
    expect(describeStopAccepted({ sessionId: "s-1", outcome: "stopped" })).toBe("stopped s-1");
  });

  it("never throws on a shapeless payload", () => {
    for (const payload of [null, undefined, "nope", 7, []]) {
      expect(() => describeStopAccepted(payload)).not.toThrow();
    }
  });
});
