// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { createTmuxSessionLauncher, type SessionLaunchOptions } from "@ccctl/server";
import {
  buildWorkerCommand,
  CLAUDE_BIN_ENV,
  DEFAULT_CLAUDE_BIN,
  DEFAULT_WORKER_NAME,
  defaultWorkerCommand,
  resolveClaudeBin,
} from "./worker-command.js";

// The production worker-argv builder (#157) pins two load-bearing things: WHICH binary the daemon's
// launcher spawns (the PATCHED `claude`, bound via CCCTL_CLAUDE_BIN with a bare-PATH default), and the
// exact `remote-control` subcommand argv the worker registers with. These unit the pure builder + the
// env resolution, then wire the production factory THROUGH the tmux backend to prove the argv the
// launcher actually execs — the acceptance shape, end to end short of a real tmux/worker.

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;

describe("resolveClaudeBin — binds the patched-binary path (default / override)", () => {
  it("defaults to the bare-PATH `claude` when CCCTL_CLAUDE_BIN is unset (worktree-safe, no ../)", () => {
    expect(resolveClaudeBin({})).toBe(DEFAULT_CLAUDE_BIN);
    expect(DEFAULT_CLAUDE_BIN).toBe("claude");
  });

  it("uses the configured path when CCCTL_CLAUDE_BIN is set (an operator pins the patched binary)", () => {
    expect(resolveClaudeBin({ [CLAUDE_BIN_ENV]: "/opt/ccctl/claude-patched" })).toBe("/opt/ccctl/claude-patched");
  });

  it("trims surrounding whitespace on a configured path", () => {
    expect(resolveClaudeBin({ [CLAUDE_BIN_ENV]: "  /opt/claude-patched \n" })).toBe("/opt/claude-patched");
  });

  it("treats a blank (whitespace-only) value as not configured — falls back to the default", () => {
    expect(resolveClaudeBin({ [CLAUDE_BIN_ENV]: "   " })).toBe(DEFAULT_CLAUDE_BIN);
    expect(resolveClaudeBin({ [CLAUDE_BIN_ENV]: "" })).toBe(DEFAULT_CLAUDE_BIN);
  });
});

describe("buildWorkerCommand — emits the remote-control subcommand argv (#157)", () => {
  const base: SessionLaunchOptions = { cwd: "/work/repo", permissionMode: "default" };

  it("builds `<bin> remote-control --name <name> --permission-mode <mode> --spawn=same-dir` exactly", () => {
    expect(buildWorkerCommand("claude", { ...base, project: "oracle" })).toEqual([
      "claude",
      "remote-control",
      "--name",
      "oracle",
      "--permission-mode",
      "default",
      "--spawn=same-dir",
    ]);
  });

  it("puts the resolved patched binary at argv[0] (spawns the patched binary, never a fixed `claude`)", () => {
    expect(buildWorkerCommand("/opt/claude-patched", base)[0]).toBe("/opt/claude-patched");
  });

  it("uses `--remote-control` as a SUBCOMMAND (argv[1]), not a flag", () => {
    expect(buildWorkerCommand("claude", base)[1]).toBe("remote-control");
  });

  it("names the worker after the project label when present", () => {
    const argv = buildWorkerCommand("claude", { ...base, project: "my-project" });
    expect(argv[argv.indexOf("--name") + 1]).toBe("my-project");
  });

  it("falls back to the default worker name when the launch carries no project", () => {
    const argv = buildWorkerCommand("claude", base);
    expect(argv[argv.indexOf("--name") + 1]).toBe(DEFAULT_WORKER_NAME);
  });

  it("carries `--spawn=same-dir` as a single trailing token (skips the interactive spawn-mode prompt)", () => {
    const argv = buildWorkerCommand("claude", base);
    expect(argv).toContain("--spawn=same-dir");
    expect(argv.at(-1)).toBe("--spawn=same-dir");
  });

  it("maps every pinned permission mode onto --permission-mode", () => {
    for (const mode of PERMISSION_MODES) {
      const argv = buildWorkerCommand("claude", { ...base, permissionMode: mode });
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(mode);
    }
  });
});

describe("defaultWorkerCommand — resolves the binary from the environment at launch time", () => {
  const originalBin = process.env[CLAUDE_BIN_ENV];
  const options: SessionLaunchOptions = { cwd: "/work/repo", permissionMode: "acceptEdits", project: "oracle" };

  afterEach(() => {
    if (originalBin === undefined) {
      Reflect.deleteProperty(process.env, CLAUDE_BIN_ENV);
    } else {
      process.env[CLAUDE_BIN_ENV] = originalBin;
    }
  });

  it("defaults argv[0] to the bare-PATH `claude` when CCCTL_CLAUDE_BIN is unset", () => {
    Reflect.deleteProperty(process.env, CLAUDE_BIN_ENV);
    expect(defaultWorkerCommand(options)[0]).toBe("claude");
  });

  it("honors a CCCTL_CLAUDE_BIN override without a rebuild (read per launch on the long-lived daemon)", () => {
    process.env[CLAUDE_BIN_ENV] = "/opt/claude-patched";
    expect(defaultWorkerCommand(options)).toEqual([
      "/opt/claude-patched",
      "remote-control",
      "--name",
      "oracle",
      "--permission-mode",
      "acceptEdits",
      "--spawn=same-dir",
    ]);
  });
});

describe("wired through the tmux launcher — the argv the daemon actually execs (AC1–AC3)", () => {
  const originalBin = process.env[CLAUDE_BIN_ENV];
  const options: SessionLaunchOptions = { cwd: "/work/repo", permissionMode: "default", project: "oracle" };

  afterEach(() => {
    if (originalBin === undefined) {
      Reflect.deleteProperty(process.env, CLAUDE_BIN_ENV);
    } else {
      process.env[CLAUDE_BIN_ENV] = originalBin;
    }
  });

  /**
   * A fake {@link TmuxRunner} that records every tmux invocation and answers `has-session` as
   * "exists" (so no `new-session` is issued) and `new-window` with a stable target — letting the
   * test read back the argv passed as `new-window`'s trailing arguments.
   */
  function recordingRunner(): { runner: (args: readonly string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = [];
    const runner = (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      return Promise.resolve(args[0] === "new-window" ? "ccctl:1" : "");
    };
    return { runner, calls };
  }

  /** The trailing worker argv `tmux new-window` was handed — everything after `-n <windowName>`. */
  function newWindowWorkerArgv(calls: string[][]): string[] {
    const newWindow = calls.find((call) => call[0] === "new-window");
    if (newWindow === undefined) {
      throw new Error("expected a `tmux new-window` invocation");
    }
    return newWindow.slice(newWindow.indexOf("-n") + 2);
  }

  it("execs `claude remote-control … --spawn=same-dir` by default (always the remote-control subcommand — never a bare `claude`)", async () => {
    Reflect.deleteProperty(process.env, CLAUDE_BIN_ENV);
    const { runner, calls } = recordingRunner();
    const launcher = createTmuxSessionLauncher({ workerCommand: defaultWorkerCommand, runner });

    await launcher.launch(options);

    expect(newWindowWorkerArgv(calls)).toEqual([
      "claude",
      "remote-control",
      "--name",
      "oracle",
      "--permission-mode",
      "default",
      "--spawn=same-dir",
    ]);
  });

  it("execs the CONFIGURED patched binary when CCCTL_CLAUDE_BIN is set (spawns patched, not bare)", async () => {
    process.env[CLAUDE_BIN_ENV] = "/opt/ccctl/claude-patched";
    const { runner, calls } = recordingRunner();
    const launcher = createTmuxSessionLauncher({ workerCommand: defaultWorkerCommand, runner });

    await launcher.launch(options);

    expect(newWindowWorkerArgv(calls)[0]).toBe("/opt/ccctl/claude-patched");
  });
});
