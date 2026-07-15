// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  LAUNCH_PERMISSION_MODE,
  UNKNOWN_LAUNCH_FAILURE_CODE,
  launchRequest,
  launchFailureCode,
  launchFailure,
  describeLaunchAccepted,
} from "./launch.js";

/**
 * The server's `LaunchFailureCode` set — a local FIXTURE for the loops below, deliberately not
 * exported by `launch.js`: the module reads a code rather than validating one, so a copy there
 * would gate nothing while still going stale. Asserting this list against a module-level copy of
 * itself would be a tautology w.r.t. the drift it names, so the READING of these codes is pinned
 * against the REAL ingress by `@ccctl/e2e`'s `web-ui-launch-flow.test.ts` instead. Here the list
 * only enumerates inputs.
 */
const SERVER_FAILURE_CODES = [
  "launcher-absent",
  "at-capacity",
  "malformed-request",
  "non-prompting-mode",
  "invalid-cwd",
  "worker-not-found",
  "backend-unavailable",
  "spawn-failed",
];

describe("LAUNCH_PERMISSION_MODE", () => {
  it("is a PROMPTING mode, so the server never refuses this control's launch as non-prompting", () => {
    // The server refuses `acceptEdits` / `bypassPermissions` (SRV-C-003, #32): a session that can
    // never block on a decision can never raise the "awaiting input" signal a remote steer needs.
    expect(["default", "plan"]).toContain(LAUNCH_PERMISSION_MODE);
  });

  it("mirrors the server's PermissionMode vocabulary", () => {
    expect(LAUNCH_PERMISSION_MODE).toBe("default");
  });
});

describe("launchRequest", () => {
  it("builds the wire body from a cwd alone — the one required field (AC1)", () => {
    expect(launchRequest({ cwd: "/home/alex/code/app" })).toEqual({
      cwd: "/home/alex/code/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
    });
  });

  it("carries the optional initial prompt and project when given (AC1)", () => {
    expect(launchRequest({ cwd: "/srv/app", project: "checkout", initialPrompt: "fix the failing test" })).toEqual({
      cwd: "/srv/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
      project: "checkout",
      initialPrompt: "fix the failing test",
    });
  });

  it("OMITS a blank optional rather than sending an empty string the server would carry", () => {
    const request = launchRequest({ cwd: "/srv/app", project: "   ", initialPrompt: "" });
    expect(request).toEqual({ cwd: "/srv/app", permissionMode: LAUNCH_PERMISSION_MODE });
    // Omitted, not set to undefined: absence is what the server reads as "no project" /
    // "a bare terminal", and `{ project: undefined }` would serialize away anyway — assert the
    // shape the parse actually sees.
    expect(Object.hasOwn(request, "project")).toBe(false);
    expect(Object.hasOwn(request, "initialPrompt")).toBe(false);
  });

  it("carries each optional independently", () => {
    expect(launchRequest({ cwd: "/srv/app", project: "checkout" })).toEqual({
      cwd: "/srv/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
      project: "checkout",
    });
    expect(launchRequest({ cwd: "/srv/app", initialPrompt: "ship it" })).toEqual({
      cwd: "/srv/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
      initialPrompt: "ship it",
    });
  });

  it("trims every field before it goes on the wire", () => {
    expect(launchRequest({ cwd: "  /srv/app  ", project: " checkout ", initialPrompt: "  ship it  " })).toEqual({
      cwd: "/srv/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
      project: "checkout",
      initialPrompt: "ship it",
    });
  });

  it("returns null on a blank / missing / non-string cwd, so the caller no-ops instead of POSTing a body the server would refuse", () => {
    expect(launchRequest({ cwd: "" })).toBeNull();
    expect(launchRequest({ cwd: "   " })).toBeNull();
    expect(launchRequest({ cwd: 42 })).toBeNull();
    expect(launchRequest({ project: "checkout", initialPrompt: "ship it" })).toBeNull();
    expect(launchRequest({})).toBeNull();
    expect(launchRequest(undefined)).toBeNull();
    expect(launchRequest(null)).toBeNull();
  });

  it("drops a non-string optional rather than putting it on the wire", () => {
    // The server's parse rejects a non-string `project` / `initialPrompt` as `malformed-request`;
    // a shapeless DOM read degrades to omission rather than a refused launch.
    expect(launchRequest({ cwd: "/srv/app", project: 42, initialPrompt: {} })).toEqual({
      cwd: "/srv/app",
      permissionMode: LAUNCH_PERMISSION_MODE,
    });
  });
});

describe("launchFailureCode", () => {
  it("recognizes every mirrored code", () => {
    for (const code of SERVER_FAILURE_CODES) {
      expect(launchFailureCode({ error: "…", code })).toBe(code);
    }
  });

  it("surfaces an unrecognized code verbatim, so server-side drift is visible rather than hidden", () => {
    expect(launchFailureCode({ error: "…", code: "some-new-code" })).toBe("some-new-code");
  });

  it("reads a missing code as the no-code fallback — the ingress's 405 branch answers `{ error }` alone", () => {
    expect(launchFailureCode({ error: "ccctl: GET not allowed on /api/sessions" })).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
  });

  it("reads a blank / non-string / shapeless payload as the no-code fallback, never throwing", () => {
    expect(launchFailureCode({ code: "" })).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode({ code: "   " })).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode({ code: 502 })).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode({ code: null })).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode({})).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode(null)).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode(undefined)).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode("invalid-cwd")).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailureCode([])).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
  });
});

describe("launchFailure", () => {
  it("surfaces the typed code AND the server's own actionable sentence (AC3)", () => {
    expect(
      launchFailure(400, {
        error: "ccctl: cannot launch a session at `/nope` — it is not an existing directory",
        code: "invalid-cwd",
      }),
    ).toEqual({
      code: "invalid-cwd",
      message: "ccctl: cannot launch a session at `/nope` — it is not an existing directory",
    });
  });

  it("never re-derives the sentence — the server's prose carries the numbers only it knows", () => {
    // `at-capacity` (#36) names the live count and the cap; a UI-side table could not.
    const answer = launchFailure(429, {
      error: "ccctl: at capacity — 8 sessions are live and the cap is 8, so this server will not launch another.",
      code: "at-capacity",
    });
    expect(answer.code).toBe("at-capacity");
    expect(answer.message).toContain("the cap is 8");
  });

  it("carries each mirrored code through with its sentence", () => {
    for (const code of SERVER_FAILURE_CODES) {
      expect(launchFailure(500, { error: `failed: ${code}`, code })).toEqual({
        code,
        message: `failed: ${code}`,
      });
    }
  });

  it("falls back to a status-naming sentence when the answer carries no usable error prose", () => {
    // A tunnel / proxy interposing a non-JSON error page: the caller could not parse a body at all.
    expect(launchFailure(502, null)).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: launch failed (HTTP 502)",
    });
    expect(launchFailure(500, {})).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: launch failed (HTTP 500)",
    });
    expect(launchFailure(500, { error: "" })).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: launch failed (HTTP 500)",
    });
    expect(launchFailure(500, { error: "   " })).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: launch failed (HTTP 500)",
    });
    expect(launchFailure(500, { error: 42 })).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: launch failed (HTTP 500)",
    });
  });

  it("keeps a typed code even when its prose is unusable — the code is the half AC3 turns on", () => {
    expect(launchFailure(429, { code: "at-capacity" })).toEqual({
      code: "at-capacity",
      message: "ccctl: launch failed (HTTP 429)",
    });
  });

  it("reads the ingress's 405 (no launch attempted, so no code) as prose plus the no-code fallback", () => {
    expect(launchFailure(405, { error: "ccctl: GET not allowed on /api/sessions" })).toEqual({
      code: UNKNOWN_LAUNCH_FAILURE_CODE,
      message: "ccctl: GET not allowed on /api/sessions",
    });
  });

  it("never throws over an arbitrary or hostile body", () => {
    expect(launchFailure(500, undefined).code).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailure(500, "<html>502 Bad Gateway</html>").code).toBe(UNKNOWN_LAUNCH_FAILURE_CODE);
    expect(launchFailure(500, []).message).toBe("ccctl: launch failed (HTTP 500)");
    expect(launchFailure(500, 42).message).toBe("ccctl: launch failed (HTTP 500)");
  });
});

describe("describeLaunchAccepted", () => {
  it("names WHICH session came up and how to attach to it (AC2)", () => {
    expect(
      describeLaunchAccepted({
        sessionId: "3f2b1c4d-0000-4000-8000-000000000001",
        attachable: true,
        hint: "tmux attach -t ccctl:1",
      }),
    ).toBe("launched 3f2b1c4d-0000-4000-8000-000000000001 — tmux attach -t ccctl:1");
  });

  it("surfaces the degraded surface's note verbatim — the hint self-describes both backends", () => {
    // The owned-pty fallback (#30) is not attachable; its hint explains that, so `attachable`
    // needs no separate reading.
    expect(
      describeLaunchAccepted({
        sessionId: "sess-2",
        attachable: false,
        hint: "this session runs on an owned pty and cannot be attached to from another terminal",
      }),
    ).toBe("launched sess-2 — this session runs on an owned pty and cannot be attached to from another terminal");
  });

  it("drops the hint half rather than printing a dangling separator when there is none", () => {
    expect(describeLaunchAccepted({ sessionId: "sess-3", attachable: true, hint: "" })).toBe("launched sess-3");
    expect(describeLaunchAccepted({ sessionId: "sess-3" })).toBe("launched sess-3");
  });

  it("still reports an accepted launch the server would not name, never throwing on a shapeless body", () => {
    expect(describeLaunchAccepted({ hint: "tmux attach -t ccctl:1" })).toBe(
      "launched (unknown session) — tmux attach -t ccctl:1",
    );
    expect(describeLaunchAccepted({})).toBe("launched (unknown session)");
    expect(describeLaunchAccepted(null)).toBe("launched (unknown session)");
    expect(describeLaunchAccepted(undefined)).toBe("launched (unknown session)");
    expect(describeLaunchAccepted({ sessionId: 42, hint: 7 })).toBe("launched (unknown session)");
  });
});
