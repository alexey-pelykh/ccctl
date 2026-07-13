// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { createTmuxSessionLauncher, type TmuxRunner, type WorkerCommandFactory } from "./session-launcher-tmux.js";
import type { SessionLaunchOptions } from "./session-launcher.js";

// #29 is the tmux backend of the #28 `ISessionLauncher` port. The one impure edge (spawning
// `tmux`) is behind the injectable `TmuxRunner` seam, so these tests drive the FULL
// orchestration — ensure-session → new-window → attach hint → teardown — hermetically, with a
// recording fake and NO real tmux, exactly as the port's own contract test uses in-memory
// fakes. They pin the three ACs: `new-window` launches the worker (AC1), the surface is
// natively attachable with a concrete `tmux attach` hint (AC2), and the launched worker is the
// caller-supplied, control-server-wired command whose registration (AC3) the fenced e2e
// live-worker oracle proves end-to-end (never faked here).

/** A recording fake `TmuxRunner`. Simulates each tmux subcommand; records every invocation. */
function makeFakeRunner(config?: {
  /** Whether `has-session` succeeds (the ccctl session already exists). Default: false (absent). */
  readonly sessionExists?: boolean;
  /** The `session:index` target `new-window -P -F` prints. Default: `ccctl:1`. */
  readonly newWindowTarget?: string;
  /** Inject a failure for calls matching a subcommand (e.g. simulate tmux absent / window gone). */
  readonly failSubcommand?: { readonly sub: string; readonly error: Error };
}): { readonly runner: TmuxRunner; readonly calls: readonly string[][] } {
  const calls: string[][] = [];
  const sessionExists = config?.sessionExists ?? false;
  const target = config?.newWindowTarget ?? "ccctl:1";
  const runner: TmuxRunner = (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const sub = args[0];
    if (config?.failSubcommand !== undefined && sub === config.failSubcommand.sub) {
      return Promise.reject(config.failSubcommand.error);
    }
    if (sub === "has-session") {
      return sessionExists ? Promise.resolve("") : Promise.reject(new Error("can't find session: ccctl"));
    }
    if (sub === "new-window") {
      return Promise.resolve(target);
    }
    // new-session / kill-window / anything else: succeed with no output.
    return Promise.resolve("");
  };
  return { runner, calls };
}

/** A worker-command factory that threads every launch option into a recognizable patched argv. */
const workerCommand: WorkerCommandFactory = (options: SessionLaunchOptions): readonly string[] => [
  "claude-patched",
  "--permission-mode",
  options.permissionMode,
  ...(options.project !== undefined ? ["--project", options.project] : []),
  ...(options.initialPrompt !== undefined ? ["--prompt", options.initialPrompt] : []),
];

/** All recorded calls for one tmux subcommand (`has-session`, `new-window`, …). */
function callsFor(calls: readonly string[][], sub: string): readonly string[][] {
  return calls.filter((call) => call[0] === sub);
}

describe("createTmuxSessionLauncher (#29 tmux backend)", () => {
  it("AC1: `tmux new-window` launches the patched worker rooted at cwd, named after the project", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await launcher.launch({ cwd: "/work/atlas", permissionMode: "acceptEdits", project: "atlas" });

    const newWindow = callsFor(calls, "new-window");
    expect(newWindow).toHaveLength(1);
    expect(newWindow[0]).toEqual([
      "new-window",
      "-P",
      "-F",
      "#{session_name}:#{window_index}",
      "-c",
      "/work/atlas",
      "-n",
      "atlas",
      "claude-patched",
      "--permission-mode",
      "acceptEdits",
      "--project",
      "atlas",
    ]);
  });

  it("AC2: the surface is natively attachable, with the concrete `tmux attach` command for the captured window", async () => {
    const { runner } = makeFakeRunner({ newWindowTarget: "ccctl:3" });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(session.attachment.attachable).toBe(true);
    expect(session.attachment.hint).toBe("tmux attach -t ccctl:3");
  });

  it("passes every launch parameter through to the worker command — permission mode, project, initial prompt", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await launcher.launch({
      cwd: "/work/project",
      permissionMode: "bypassPermissions",
      project: "orion",
      initialPrompt: "start the failing test",
    });

    const [newWindow] = callsFor(calls, "new-window");
    // The worker argv (everything after `-n <name>`) carries mode, project, and prompt.
    expect(newWindow).toEqual(
      expect.arrayContaining([
        "claude-patched",
        "--permission-mode",
        "bypassPermissions",
        "--project",
        "orion",
        "--prompt",
        "start the failing test",
      ]),
    );
  });

  it("names the window with a default when the launch carries no project", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await launcher.launch({ cwd: "/repo", permissionMode: "plan" });

    const [newWindow] = callsFor(calls, "new-window");
    const nameFlagIndex = newWindow?.indexOf("-n") ?? -1;
    expect(newWindow?.[nameFlagIndex + 1]).toBe("claude");
  });

  it("creates the shared ccctl session on first launch (has-session absent → new-session -d)", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: false });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toEqual([["has-session", "-t", "ccctl"]]);
    expect(callsFor(calls, "new-session")).toEqual([["new-session", "-d", "-s", "ccctl"]]);
    // Ordering: the session is ensured BEFORE the window is created inside it.
    const order = calls.map((call) => call[0]);
    expect(order.indexOf("new-session")).toBeLessThan(order.indexOf("new-window"));
  });

  it("reuses the ccctl session when it already exists (has-session ok → NO new-session)", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toHaveLength(1);
    expect(callsFor(calls, "new-session")).toHaveLength(0);
    expect(callsFor(calls, "new-window")).toHaveLength(1);
  });

  it("tolerates a concurrent launch creating the ccctl session first (a benign new-session race)", async () => {
    // Two cold-start launches race: ours sees the session absent, but a sibling wins the
    // create before ours runs `new-session` (which then fails "duplicate"). A re-check finds
    // the session up, so the race is benign and the window is still created.
    let sessionUp = false;
    const calls: string[][] = [];
    const runner: TmuxRunner = (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      const sub = args[0];
      if (sub === "has-session") {
        return sessionUp ? Promise.resolve("") : Promise.reject(new Error("can't find session: ccctl"));
      }
      if (sub === "new-session") {
        sessionUp = true; // a sibling launch created it between our check and now
        return Promise.reject(new Error("duplicate session: ccctl"));
      }
      if (sub === "new-window") {
        return Promise.resolve("ccctl:2");
      }
      return Promise.resolve("");
    };
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(session.attachment.attachable).toBe(true);
    expect(session.attachment.hint).toBe("tmux attach -t ccctl:2");
    expect(callsFor(calls, "new-window")).toHaveLength(1);
  });

  it("rejects when tmux cannot bring a surface up, so the caller falls back to another backend (owned-pty #30)", async () => {
    // tmux absent: BOTH has-session and new-session spawn-fail (ENOENT).
    const enoent = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    const runner: TmuxRunner = () => Promise.reject(enoent);
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await expect(launcher.launch({ cwd: "/repo", permissionMode: "default" })).rejects.toThrow(/ENOENT/);
  });

  it("rejects when the window itself cannot be created (new-window fails)", async () => {
    const { runner } = makeFakeRunner({
      sessionExists: true,
      failSubcommand: { sub: "new-window", error: new Error("tmux: no server running") },
    });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });

    await expect(launcher.launch({ cwd: "/repo", permissionMode: "default" })).rejects.toThrow(/no server running/);
  });

  it("tears the window down on close via kill-window with the captured target", async () => {
    const { runner, calls } = makeFakeRunner({ newWindowTarget: "ccctl:2" });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await session.close();

    expect(callsFor(calls, "kill-window")).toEqual([["kill-window", "-t", "ccctl:2"]]);
  });

  it("close is idempotent: a second call is a safe no-op (kill-window runs exactly once)", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(callsFor(calls, "kill-window")).toHaveLength(1);
  });

  it("close resolves even when the window is already gone (kill-window failure is swallowed)", async () => {
    const { runner } = makeFakeRunner({
      failSubcommand: { sub: "kill-window", error: new Error("can't find window: ccctl:1") },
    });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await expect(session.close()).resolves.toBeUndefined();
  });

  it("honors a custom session name and tmux binary in the commands and the attach hint", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true, newWindowTarget: "myctl:1" });
    const launcher = createTmuxSessionLauncher({
      runner,
      workerCommand,
      sessionName: "myctl",
      tmuxBin: "/opt/tmux/bin/tmux",
    });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toEqual([["has-session", "-t", "myctl"]]);
    expect(session.attachment.hint).toBe("/opt/tmux/bin/tmux attach -t myctl:1");
  });
});
