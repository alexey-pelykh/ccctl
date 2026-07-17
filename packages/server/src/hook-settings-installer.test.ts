// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAskUserQuestionHookSettings,
  cleanupHookInstall,
  HOOK_STATE_DIR_MODE,
  HOOK_STATE_FILE_MODE,
  HOOK_STATE_SUBDIR,
  installAskUserQuestionHookSettings,
  resolveHookScriptPath,
  resolveHookStateDir,
} from "./hook-settings-installer.js";
import { CCCTL_STATE_DIR } from "./session-store-file.js";

// The launch-time settings installer (#262, #78 Option A) in ISOLATION — no launcher, no server. Wires
// the `AskUserQuestion` `PreToolUse` hook into ONE launch attempt: where its per-launch state lives
// (`resolveHookStateDir`), what the wiring reads as (`buildAskUserQuestionHookSettings`), and the two
// filesystem operations a launch actually performs (`installAskUserQuestionHookSettings` /
// `cleanupHookInstall`). `ui-session-launch.test.ts` § "AskUserQuestion hook install wiring" proves this
// is actually CALLED from a real launch; this file proves what it does in isolation.

/** Permission bits (mask off the file-type bits) of a path — mirrors `session-store-file.test.ts`. */
function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("resolveHookStateDir — XDG state path resolution", () => {
  it("honours an absolute XDG_STATE_HOME, under a `hooks` subdirectory sibling to the session store", () => {
    expect(resolveHookStateDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/tester")).toBe(
      join("/xdg/state", CCCTL_STATE_DIR, HOOK_STATE_SUBDIR),
    );
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveHookStateDir({}, "/home/tester")).toBe(
      join("/home/tester", ".local", "state", CCCTL_STATE_DIR, HOOK_STATE_SUBDIR),
    );
  });

  it("falls back when XDG_STATE_HOME is empty or relative (spec: absolute only)", () => {
    const expected = join("/home/tester", ".local", "state", CCCTL_STATE_DIR, HOOK_STATE_SUBDIR);
    expect(resolveHookStateDir({ XDG_STATE_HOME: "" }, "/home/tester")).toBe(expected);
    expect(resolveHookStateDir({ XDG_STATE_HOME: "relative/state" }, "/home/tester")).toBe(expected);
  });

  it("pins the subdirectory name", () => {
    expect(HOOK_STATE_SUBDIR).toBe("hooks");
  });
});

describe("resolveHookScriptPath", () => {
  it("resolves to an absolute path naming the compiled hook script", () => {
    const resolved = resolveHookScriptPath();

    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("ask-user-question-hook.js")).toBe(true);
  });
});

describe("buildAskUserQuestionHookSettings", () => {
  it("wires a PreToolUse hook matching ONLY AskUserQuestion, invoking `node <script> <handoffPath>`", () => {
    const settings = buildAskUserQuestionHookSettings(
      "/opt/ccctl/ask-user-question-hook.js",
      "/state/abc.handoff.json",
    );

    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [
              {
                type: "command",
                command: 'node "/opt/ccctl/ask-user-question-hook.js" "/state/abc.handoff.json"',
              },
            ],
          },
        ],
      },
    });
  });

  it("JSON-quotes both paths — argv-safe even when a path contains a space", () => {
    const settings = buildAskUserQuestionHookSettings("/opt/ccctl dir/hook.js", "/state/has space/abc.handoff.json");

    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      'node "/opt/ccctl dir/hook.js" "/state/has space/abc.handoff.json"',
    );
  });
});

describe("installAskUserQuestionHookSettings / cleanupHookInstall", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccctl-hook-installer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the state directory at owner-only (0700)", () => {
    const stateDir = join(dir, "hooks");

    installAskUserQuestionHookSettings("token-1", stateDir);

    expect(fileMode(stateDir)).toBe(HOOK_STATE_DIR_MODE);
    expect(HOOK_STATE_DIR_MODE).toBe(0o700);
  });

  it("writes a settings file at owner-read/write-only (0600), matching buildAskUserQuestionHookSettings", () => {
    const install = installAskUserQuestionHookSettings("token-1", dir);

    expect(fileMode(install.settingsPath)).toBe(HOOK_STATE_FILE_MODE);
    expect(HOOK_STATE_FILE_MODE).toBe(0o600);
    const written = JSON.parse(readFileSync(install.settingsPath, "utf8")) as unknown;
    expect(written).toEqual(buildAskUserQuestionHookSettings(resolveHookScriptPath(), install.handoffPath));
  });

  it("returns BOTH the settings path and the handoff path, both under the given state dir", () => {
    const install = installAskUserQuestionHookSettings("token-1", dir);

    expect(install.settingsPath.startsWith(dir)).toBe(true);
    expect(install.handoffPath.startsWith(dir)).toBe(true);
    expect(install.settingsPath).not.toBe(install.handoffPath);
  });

  it("does NOT create the handoff file itself — only the hook, on its own later run, does that", () => {
    const install = installAskUserQuestionHookSettings("token-1", dir);

    expect(existsSync(install.handoffPath)).toBe(false);
  });

  it("keys two installs by their own token — no collision between concurrent launches", () => {
    const first = installAskUserQuestionHookSettings("token-a", dir);
    const second = installAskUserQuestionHookSettings("token-b", dir);

    expect(first.settingsPath).not.toBe(second.settingsPath);
    expect(first.handoffPath).not.toBe(second.handoffPath);
  });

  it("cleanupHookInstall removes both files", () => {
    const install = installAskUserQuestionHookSettings("token-1", dir);
    // Simulate the hook having fired once and left a handoff file behind — cleanup must remove THIS
    // too, not just the settings file it wrote itself.
    writeFileSync(install.handoffPath, JSON.stringify({ questions: [] }));

    cleanupHookInstall(install);

    expect(existsSync(install.settingsPath)).toBe(false);
    expect(existsSync(install.handoffPath)).toBe(false);
  });

  it("cleanupHookInstall is a no-op — never throws — when the files are already gone", () => {
    const install = installAskUserQuestionHookSettings("token-1", dir);
    cleanupHookInstall(install);

    expect(() => cleanupHookInstall(install)).not.toThrow();
  });
});
