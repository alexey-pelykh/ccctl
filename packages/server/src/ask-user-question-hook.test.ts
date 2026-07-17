// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASKUSERQUESTION_TOOL_NAME,
  extractAskUserQuestionPayload,
  runHook,
  writeHandoffFile,
} from "./ask-user-question-hook.js";

// The `PreToolUse` hook script (#262, #78 Option A) in ISOLATION — no `claude` binary, no server, no
// HTTP. Its whole job is CAPTURE-AND-HAND-OFF: read stdin, extract an `AskUserQuestion` payload
// verbatim, and write it to a same-host file, atomically and symlink-safely, always answering an empty
// decision. The wired-through correlation (reading this file back and stamping a `sequence_num`) is
// covered by `worker-channel.test.ts` § `reconcileHookHandoff`; the settings that WIRE this hook into a
// launch are covered by `hook-settings-installer.test.ts`.

/** Permission bits (mask off the file-type bits) of a path — mirrors `session-store-file.test.ts`. */
function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("extractAskUserQuestionPayload", () => {
  it("extracts the raw `questions` value verbatim — no transcription", () => {
    const questions = [{ questionId: "q0", prompt: "Approve?", options: [{ label: "Yes" }], multiSelect: false }];
    const stdin = { tool_name: "AskUserQuestion", tool_input: { questions } };

    // Reference equality, not merely deep equality: the module doc states this hook FORWARDS the
    // payload rather than transcribing it — `requiresActionEnrichmentFromValue` (`@ccctl/core`) is
    // the one place its shape is actually enforced, at consumption time.
    expect(extractAskUserQuestionPayload(stdin)).toBe(questions);
  });

  it("pins the tool name this hook matches", () => {
    expect(ASKUSERQUESTION_TOOL_NAME).toBe("AskUserQuestion");
  });

  it("returns `undefined` for a non-object stdin value", () => {
    for (const value of [null, "not json", 42, true, ["array"]]) {
      expect(extractAskUserQuestionPayload(value)).toBeUndefined();
    }
  });

  it("returns `undefined` when `tool_name` is not `AskUserQuestion` — a no-op for every other tool", () => {
    expect(
      extractAskUserQuestionPayload({ tool_name: "Bash", tool_input: { questions: [{ prompt: "x" }] } }),
    ).toBeUndefined();
  });

  it("returns `undefined` when `tool_input` is missing, not an object, or an array", () => {
    expect(extractAskUserQuestionPayload({ tool_name: "AskUserQuestion" })).toBeUndefined();
    expect(extractAskUserQuestionPayload({ tool_name: "AskUserQuestion", tool_input: "nope" })).toBeUndefined();
    expect(extractAskUserQuestionPayload({ tool_name: "AskUserQuestion", tool_input: null })).toBeUndefined();
    expect(extractAskUserQuestionPayload({ tool_name: "AskUserQuestion", tool_input: [1, 2] })).toBeUndefined();
  });

  it("returns `undefined` when `tool_input` carries no `questions` key at all", () => {
    expect(extractAskUserQuestionPayload({ tool_name: "AskUserQuestion", tool_input: {} })).toBeUndefined();
  });
});

describe("writeHandoffFile", () => {
  let dir: string;
  let handoffPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccctl-hook-write-"));
    handoffPath = join(dir, "handoff.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes `{ questions }` — the exact shape `worker-channel.ts` § `consumeHookHandoffQuestions` reads back", () => {
    const questions = [{ questionId: "q0", prompt: "Approve?", options: [{ label: "Yes" }], multiSelect: false }];

    writeHandoffFile(handoffPath, questions);

    expect(JSON.parse(readFileSync(handoffPath, "utf8")) as unknown).toEqual({ questions });
  });

  it("writes at owner-read/write-only (0600), forced past a permissive umask", () => {
    writeHandoffFile(handoffPath, [{ prompt: "x" }]);

    expect(fileMode(handoffPath)).toBe(0o600);
  });

  it("is atomic and symlink-safe — a pre-existing symlink at the target is REPLACED, not followed", () => {
    // The elsewhere file a symlink at the handoff path would redirect through, if the write followed
    // rather than replaced it.
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ questions: ["do not touch me"] }));
    symlinkSync(elsewhere, handoffPath);

    writeHandoffFile(handoffPath, [{ prompt: "real capture" }]);

    // `rename(2)` replaced the destination directory entry — the symlink is GONE, a real regular file
    // sits there instead, and the file it used to point through was never written to.
    expect(lstatSync(handoffPath).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(handoffPath, "utf8")) as unknown).toEqual({
      questions: [{ prompt: "real capture" }],
    });
    expect(JSON.parse(readFileSync(elsewhere, "utf8")) as unknown).toEqual({ questions: ["do not touch me"] });
  });

  it("fails open silently when the target cannot be written — no throw, nothing left behind", () => {
    const unwritable = join(dir, "no-such-subdir", "handoff.json");

    expect(() => writeHandoffFile(unwritable, [{ prompt: "x" }])).not.toThrow();
    expect(existsSync(unwritable)).toBe(false);
  });
});

describe("runHook", () => {
  let dir: string;
  let handoffPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccctl-hook-run-"));
    handoffPath = join(dir, "handoff.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The stdin document a REAL `PreToolUse` hook invocation for `AskUserQuestion` carries. */
  function stdinFor(questions: unknown): string {
    return JSON.stringify({ tool_name: "AskUserQuestion", tool_input: { questions } });
  }

  it("captures a well-formed AskUserQuestion payload and always answers the empty decision", () => {
    const questions = [{ questionId: "q0", prompt: "Approve?", options: [{ label: "Yes" }], multiSelect: false }];

    const output = runHook(stdinFor(questions), handoffPath);

    // Never `permissionDecision: "ask"` (ADR-005) — an empty object is an implicit allow, leaving the
    // native block this hook must never redundantly force.
    expect(output).toEqual({});
    expect(JSON.parse(readFileSync(handoffPath, "utf8")) as unknown).toEqual({ questions });
  });

  it("writes nothing for a tool other than AskUserQuestion — a no-op, not merely an empty capture", () => {
    const output = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), handoffPath);

    expect(output).toEqual({});
    expect(existsSync(handoffPath)).toBe(false);
  });

  it("fails open on malformed JSON stdin — empty decision, nothing written, never throws", () => {
    expect(() => runHook("{not valid json", handoffPath)).not.toThrow();
    expect(runHook("{not valid json", handoffPath)).toEqual({});
    expect(existsSync(handoffPath)).toBe(false);
  });

  it("fails open when the handoff path cannot be written — empty decision, no throw", () => {
    const unwritable = join(dir, "missing-dir", "handoff.json");

    expect(() => runHook(stdinFor([{ prompt: "x" }]), unwritable)).not.toThrow();
    expect(runHook(stdinFor([{ prompt: "x" }]), unwritable)).toEqual({});
    expect(existsSync(unwritable)).toBe(false);
  });
});
