// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  createPtySessionLauncher,
  DEGRADED_ATTACH_HINT,
  type OwnedPty,
  type PtySpawner,
  type PtySpawnOptions,
} from "./session-launcher-pty.js";
import type { WorkerCommandFactory } from "./session-launcher-tmux.js";
import type { SessionLaunchOptions } from "./session-launcher.js";

// #30 is the owned-pty backend of the #28 `ISessionLauncher` port — the PORTABLE FALLBACK. The one
// impure edge (spawning a pty) is behind the injectable `PtySpawner` seam, so these tests drive the
// FULL orchestration — spawn the worker → degraded attach surface → teardown (kill + reap) —
// hermetically, with an in-memory fake pty and NO real pty / no `node-pty`, exactly as the tmux
// backend's tests do. They pin the ACs the backend can prove in-repo: it spawns the worker rooted
// at cwd (AC1); teardown signals the child so its pty fd is released and it is reaped (AC2). AC3
// (the launched worker registers with the local server) is a consequence of running the
// caller-supplied, control-server-wired worker in a real pty, proven end-to-end by the fenced e2e
// live-worker oracle — never faked here.

/**
 * A recording in-memory fake {@link OwnedPty}. Counts `kill` calls and lets a test fire `onExit`
 * to simulate the child dying. `autoExitOnKill` (default true) models the real pty — a `kill`
 * signals the child, which exits and fires `onExit`; a test that wants to observe teardown mid-flight
 * sets it false and fires the exit by hand.
 */
function makeFakePty(config?: { readonly pid?: number; readonly autoExitOnKill?: boolean }): {
  readonly pty: OwnedPty;
  readonly killCount: () => number;
  readonly fireExit: () => void;
  readonly hasExitListener: () => boolean;
} {
  const autoExitOnKill = config?.autoExitOnKill ?? true;
  let killCalls = 0;
  const exitListeners: Array<(event: { readonly exitCode: number; readonly signal?: number }) => void> = [];
  const fireExit = (): void => {
    for (const listener of exitListeners.splice(0)) {
      listener({ exitCode: 0 });
    }
  };
  const pty: OwnedPty = {
    pid: config?.pid ?? 4242,
    onExit(listener): void {
      exitListeners.push(listener);
    },
    kill(): void {
      killCalls += 1;
      if (autoExitOnKill) {
        fireExit();
      }
    },
  };
  return {
    pty,
    killCount: (): number => killCalls,
    fireExit,
    hasExitListener: (): boolean => exitListeners.length > 0,
  };
}

/** A recording {@link PtySpawner} that hands back `pty` and captures every spawn's file / args / options. */
function recordingSpawner(pty: OwnedPty): {
  readonly spawn: PtySpawner;
  readonly calls: Array<{ readonly file: string; readonly args: readonly string[]; readonly options: PtySpawnOptions }>;
} {
  const calls: Array<{ readonly file: string; readonly args: readonly string[]; readonly options: PtySpawnOptions }> =
    [];
  const spawn: PtySpawner = (file, args, options): OwnedPty => {
    calls.push({ file, args: [...args], options });
    return pty;
  };
  return { spawn, calls };
}

/** A worker-command factory that threads every launch option into a recognizable patched argv (as tmux's tests). */
const workerCommand: WorkerCommandFactory = (options: SessionLaunchOptions): readonly string[] => [
  "claude-patched",
  "--permission-mode",
  options.permissionMode,
  ...(options.project !== undefined ? ["--project", options.project] : []),
  ...(options.initialPrompt !== undefined ? ["--prompt", options.initialPrompt] : []),
];

const OPTIONS: SessionLaunchOptions = { cwd: "/repo", permissionMode: "default" };

describe("createPtySessionLauncher (#30 owned-pty backend)", () => {
  it("AC1: spawns the patched worker (executable + args) rooted at cwd, in a default-geometry pty", async () => {
    const { spawn, calls } = recordingSpawner(makeFakePty().pty);
    const launcher = createPtySessionLauncher({ workerCommand, spawn });

    await launcher.launch({ cwd: "/work/atlas", permissionMode: "acceptEdits", project: "atlas" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: "claude-patched",
      args: ["--permission-mode", "acceptEdits", "--project", "atlas"],
      options: { cwd: "/work/atlas", name: "xterm-256color", cols: 80, rows: 24 },
    });
  });

  it("passes every launch parameter through to the worker command — permission mode, project, initial prompt", async () => {
    const { spawn, calls } = recordingSpawner(makeFakePty().pty);
    const launcher = createPtySessionLauncher({ workerCommand, spawn });

    await launcher.launch({
      cwd: "/work/project",
      permissionMode: "bypassPermissions",
      project: "orion",
      initialPrompt: "start the failing test",
    });

    expect(calls[0]?.file).toBe("claude-patched");
    expect(calls[0]?.args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--project",
      "orion",
      "--prompt",
      "start the failing test",
    ]);
  });

  it("AC2/degraded: reports a non-attachable surface with the operator-facing degradation note", async () => {
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => makeFakePty().pty });

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.attachable).toBe(false);
    expect(session.attachment.hint).toBe(DEGRADED_ATTACH_HINT);
    // The note names WHY (no direct attach) and WHERE to drive it instead (the ccctl UI).
    expect(session.attachment.hint).toContain("ccctl UI");
  });

  it("AC2: teardown signals the child — kill releases the pty fd and reaps the child", async () => {
    const fake = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty });
    const session = await launcher.launch(OPTIONS);

    await session.close();

    expect(fake.killCount()).toBe(1);
  });

  it("AC2: close() awaits the reaping — it does not resolve until the child has actually exited", async () => {
    // kill signals but the child has not exited yet; close() must stay pending until onExit fires.
    const fake = makeFakePty({ autoExitOnKill: false });
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty });
    const session = await launcher.launch(OPTIONS);

    let resolved = false;
    const closing = session.close().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(fake.killCount()).toBe(1); // the child was signalled…
    expect(resolved).toBe(false); // …but teardown is not done until it is reaped

    fake.fireExit(); // the child finally exits → reaped
    await closing;
    expect(resolved).toBe(true);
  });

  it("close is idempotent: a second call is a safe no-op (the child is signalled exactly once)", async () => {
    const fake = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty });
    const session = await launcher.launch(OPTIONS);

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(fake.killCount()).toBe(1);
  });

  it("close resolves without a second kill when the child already exited on its own", async () => {
    const fake = makeFakePty({ autoExitOnKill: false });
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty });
    const session = await launcher.launch(OPTIONS);

    fake.fireExit(); // the worker exited by itself before any teardown

    await expect(session.close()).resolves.toBeUndefined();
    expect(fake.killCount()).toBe(0); // nothing left to signal — no kill
  });

  it("registers an exit listener at launch so a self-exiting child is tracked", async () => {
    const fake = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty });

    await launcher.launch(OPTIONS);

    expect(fake.hasExitListener()).toBe(true);
  });

  it("honors a custom terminal name and pty geometry", async () => {
    const { spawn, calls } = recordingSpawner(makeFakePty().pty);
    const launcher = createPtySessionLauncher({ workerCommand, spawn, termName: "vt100", cols: 120, rows: 40 });

    await launcher.launch({ cwd: "/repo", permissionMode: "plan" });

    expect(calls[0]?.options).toEqual({ cwd: "/repo", name: "vt100", cols: 120, rows: 40 });
  });

  it("supports an async spawner (the default lazily imports node-pty and is async)", async () => {
    const fake = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => Promise.resolve(fake.pty) });

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.attachable).toBe(false);
    await expect(session.close()).resolves.toBeUndefined();
    expect(fake.killCount()).toBe(1);
  });

  it("rejects when the pty cannot be brought up, so the caller falls back to another backend", async () => {
    // The spawner rejecting is the "backend cannot bring a surface up" signal — e.g. node-pty absent.
    const launcher = createPtySessionLauncher({
      workerCommand,
      spawn: () => Promise.reject(new Error("node-pty unavailable")),
    });

    await expect(launcher.launch(OPTIONS)).rejects.toThrow(/node-pty unavailable/);
  });

  it("rejects when the spawner throws synchronously", async () => {
    const launcher = createPtySessionLauncher({
      workerCommand,
      spawn: () => {
        throw new Error("spawn failed");
      },
    });

    await expect(launcher.launch(OPTIONS)).rejects.toThrow(/spawn failed/);
  });

  it("rejects a worker command that names no executable (empty argv)", async () => {
    const launcher = createPtySessionLauncher({ workerCommand: () => [], spawn: () => makeFakePty().pty });

    await expect(launcher.launch(OPTIONS)).rejects.toThrow(/non-empty worker command/);
  });
});
