// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — "New session" launch logic (pure, DOM-free).
 *
 * The UC2 leg of the zero-build UI (#37, `UI-B-004`). Where `sessions.js` owns how the picker
 * reads EXISTING sessions and `command.js` how a steer addresses one, this module owns the
 * decisions behind the control that BRINGS ONE INTO BEING: what a launch body looks like on the
 * wire, and how the server's answer — accepted, or a TYPED failure — reads back to the operator.
 *
 * `app.js` is the thin shell: it reads the "New session" form, builds a body here, POSTs it to
 * `POST /api/sessions` (the same {@link SESSIONS_PATH} the list is GET from — `command.js` owns
 * that constant), and paints whatever this module says the answer means. Keeping the
 * build/decode decisions here (DOM-free) makes the whole launch contract unit-testable without a
 * browser, exactly as the decode / steer / list decisions are.
 *
 * The server shapes are MIRRORED here as constants, deliberately NOT imported: this module is
 * served to the browser as-is (no bundler, no build), so it stays dependency-free vanilla ESM.
 * The mirrored contract (`ui-session-launch.ts`, camelCase per ADR-001 — snake_case governs only
 * the foreign-owned register wire):
 *
 *   request  → SessionLaunchOptions = { cwd: string, permissionMode: PermissionMode,
 *                                       project?: string, initialPrompt?: string }
 *   201      → LaunchAcceptedWire   = { sessionId: string, attachable: boolean, hint: string }
 *   failure  → LaunchFailureWire    = { error: string, code: LaunchFailureCode }
 *
 * `LaunchFailureCode` is the pinned discriminant that says WHICH failure it is (#33), so the
 * operator is told what to do rather than that something broke. The server owns the set and
 * partitions it by WHO must act: the operator's request is wrong (`invalid-cwd`,
 * `non-prompting-mode`, `malformed-request`), this server cannot launch at all (`launcher-absent`),
 * it will not launch right now (`at-capacity`, #36 — well-formed, and retryable the moment a slot
 * frees), or the host could bring no surface up (`worker-not-found`, `backend-unavailable`,
 * `spawn-failed`). This module deliberately mirrors NO copy of that set: it reads a code rather than
 * validating one ({@link launchFailureCode}), so a local copy would gate nothing while still going
 * stale. What IS pinned against the REAL server — not against a second hand-copy of itself — is how
 * this module READS the server's answers: the launch-flow spec in `@ccctl/e2e` drives it against a
 * live ingress. The set's MEMBERSHIP is gated nowhere on this side, and deliberately so: a ninth
 * code needs no change here, so the partition named above is documentation of the server's set
 * rather than a gate on it.
 *
 * The launched session is placed in the registry as `registering` FROM BIRTH (#33), so it shows
 * up in the picker on the very next `GET /api/sessions` poll with no new plumbing — the launch
 * needs only to trigger a refresh, never to insert a row of its own (#37 AC2).
 */

/**
 * The {@link PermissionMode} a launched session runs under (mirrors `@ccctl/core`).
 *
 * Pinned rather than offered as a control: the server REQUIRES the field — an absent or unknown
 * mode is refused `malformed-request` — so the UI must send one, and #37's control takes only an
 * initial prompt and a working directory/project. `default` is the standard PROMPTING mode, which
 * is the half that matters: a launched session must be able to block on a decision and raise the
 * "awaiting input" signal a remotely-driven session is steered by, so the server refuses the
 * non-prompting modes (`acceptEdits` / `bypassPermissions`) with a typed `non-prompting-mode`
 * (SRV-C-003, #32). Sending `default` therefore makes that refusal unreachable from this control
 * BY CONSTRUCTION — {@link launchFailure} still decodes the code, because the server owns the
 * closed set and this UI is not the only thing that can be wrong about it.
 *
 * The other prompting mode, `plan`, is reachable on the wire but has no control here; surfacing a
 * mode picker is a separate item, not #37's scope.
 */
export const LAUNCH_PERMISSION_MODE = "default";

/**
 * What {@link launchFailureCode} reads when the answer carries no usable code at all. Not a
 * `LaunchFailureCode` — it is the ABSENCE of one, and it is REACHABLE against a correct server: the
 * ingress's `405` branch answers `{ error }` with no `code` (no launch was attempted, so there is no
 * launch failure to type), and a tunnel or proxy can interpose a body of its own.
 */
export const UNKNOWN_LAUNCH_FAILURE_CODE = "unknown";

/** Trim a value to a string, or the empty string when it is not one (mirrors `command.js`). */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the launch body from the "New session" form's fields, or `null` when no working directory
 * was given — so the caller no-ops rather than POSTing a body the server would only refuse as
 * `malformed-request`. Mirrors the null-on-blank shape of `command.js`'s
 * {@link inputCommand} / {@link redirectCommand}.
 *
 * The cwd is the one REQUIRED field (the server demands a non-empty string; the form marks it
 * `required` so the browser blocks a blank submit before this is ever reached — this is the
 * defensive second half of that pair, for a caller that is not the form). `project` and
 * `initialPrompt` are the optional halves of #37 AC1: a blank one is OMITTED from the body
 * entirely rather than sent as `""` or `undefined` — the server's parse rejects a non-string and
 * treats absence as "not scoped to a project" / "a bare terminal the operator will drive by hand",
 * which is exactly what a blank field means. Every field is trimmed before it goes on the wire.
 *
 * @param {{ cwd?: unknown, project?: unknown, initialPrompt?: unknown }} fields - the form's values.
 * @returns {{ cwd: string, permissionMode: string, project?: string, initialPrompt?: string } | null}
 */
export function launchRequest(fields) {
  const cwd = trimmed(fields?.cwd);
  if (cwd === "") {
    return null;
  }
  const project = trimmed(fields?.project);
  const initialPrompt = trimmed(fields?.initialPrompt);
  return {
    cwd,
    permissionMode: LAUNCH_PERMISSION_MODE,
    ...(project !== "" ? { project } : {}),
    ...(initialPrompt !== "" ? { initialPrompt } : {}),
  };
}

/**
 * The typed code a failure answer carries — the server's `code` VERBATIM whenever it is a non-blank
 * string, and {@link UNKNOWN_LAUNCH_FAILURE_CODE} when there is no usable code at all.
 *
 * Passing an unrecognized code through rather than checking it against a local copy of the set is
 * the same choice `sessions.js`'s {@link activityLabel} makes for an unrecognized activity kind: if
 * the server grows a code this build predates, the operator should see the server's word for what
 * happened — drift that is VISIBLE is a bug report, drift that is hidden is a mystery. The UI is a
 * READER of this set, not an enforcer of it: the server owns it and is the side that must fail
 * closed on a code it does not know, and there is nothing this UI would do differently for an
 * unrecognized one anyway — it renders the code and the server's sentence either way. That is
 * exactly why no mirrored copy of the set lives here: it could only go stale, never gate.
 *
 * Defensive over any decoded value (a non-object, a null, an array, a non-string code): never
 * throws, and degrades to {@link UNKNOWN_LAUNCH_FAILURE_CODE}.
 *
 * @param {unknown} payload - a decoded `LaunchFailureWire`, or any value.
 * @returns {string}
 */
export function launchFailureCode(payload) {
  const code = trimmed(payload?.code);
  return code === "" ? UNKNOWN_LAUNCH_FAILURE_CODE : code;
}

/**
 * Read a failed `POST /api/sessions` answer into the two things the operator is shown (#37 AC3):
 * the TYPED `code` (which failure it is) and the human `message` (what to do about it).
 *
 * The message is the server's own `error` sentence, used verbatim and never re-derived here. That
 * is deliberate: every ccctl fail-closed branch already writes an actionable sentence, and it
 * writes a BETTER one than this module could — it echoes the directory the operator typed
 * (`invalid-cwd`), names how many sessions are live and what the cap is (`at-capacity`), lists the
 * two prompting modes (`non-prompting-mode`). A per-code sentence table here would be a second,
 * worse copy of prose the server already owns, and it would drift.
 *
 * Both halves are defensive, because not every failure answer comes from ccctl's typed ingress: the
 * `405` branch answers `{ error }` with no code, a tunnel or proxy can interpose an HTML error page
 * (so `payload` is `null` — the caller could not parse JSON), and a hostile body is arbitrary bytes.
 * A missing / blank / non-string `error` falls back to a sentence naming the status, so the
 * operator is never shown an empty line or the word "undefined".
 *
 * @param {number} status - the answer's HTTP status (the browser's `Response.status`).
 * @param {unknown} payload - the decoded `LaunchFailureWire`, or `null` when the body was not JSON.
 * @returns {{ code: string, message: string }}
 */
export function launchFailure(status, payload) {
  const error = trimmed(payload?.error);
  return {
    code: launchFailureCode(payload),
    message: error === "" ? `ccctl: launch failed (HTTP ${status})` : error,
  };
}

/**
 * The one-line confirmation an accepted launch reads as: WHICH session came up, and how to reach
 * its terminal at the operator's own desk.
 *
 * Both halves come from the server's `201` body. The `sessionId` is the id of the `registering`
 * row the launch just placed in the registry — the handle that lets the operator pick THEIR launch
 * out of the picker rather than guess which of N rows is theirs (#37 AC2). The `hint` is the
 * server's human-facing attach guidance, and it is self-describing across both surfaces: the
 * concrete attach command when the surface is fully attachable (tmux, #29), or a note explaining
 * the degradation when it is not (the owned-pty fallback, #30) — so the sibling `attachable`
 * boolean needs no reading here, and this UI never re-derives prose the server already wrote.
 *
 * Defensive over any decoded value, matching this module's never-throws posture: a missing id
 * reads as `"(unknown session)"` (a launch the server accepted but would not name is still a
 * launch the operator must be told about), and a missing hint simply drops that half of the line
 * rather than printing a dangling separator.
 *
 * @param {unknown} payload - a decoded `LaunchAcceptedWire`, or any value.
 * @returns {string}
 */
export function describeLaunchAccepted(payload) {
  const sessionId = trimmed(payload?.sessionId);
  const hint = trimmed(payload?.hint);
  const head = `launched ${sessionId === "" ? "(unknown session)" : sessionId}`;
  return hint === "" ? head : `${head} — ${hint}`;
}
