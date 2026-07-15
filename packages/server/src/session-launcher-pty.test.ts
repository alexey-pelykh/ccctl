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
import { SessionLaunchError } from "./session-launcher.js";
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
 * A recording in-memory fake {@link OwnedPty}. Counts `kill` calls, records the SIGNAL each one
 * carried, and lets a test fire `onExit` to simulate the child dying. `autoExitOnKill` (default true)
 * models the real pty — a `kill` signals the child, which exits and fires `onExit`; a test that wants
 * to observe teardown mid-flight sets it false and fires the exit by hand.
 *
 * `ignoresPoliteSignal` models the child the emergency-stop exists for: one that catches and IGNORES
 * the default signal (SIGHUP on POSIX) and therefore only ever dies on the uncatchable escalation. A
 * fake that always exited on the first `kill` cannot tell a backend that escalates from one that hangs
 * forever, which is the whole property under test.
 */
function makeFakePty(config?: {
  readonly pid?: number;
  readonly autoExitOnKill?: boolean;
  readonly ignoresPoliteSignal?: boolean;
}): {
  readonly pty: OwnedPty;
  readonly killCount: () => number;
  readonly killSignals: () => ReadonlyArray<string | undefined>;
  readonly fireExit: () => void;
  readonly hasExitListener: () => boolean;
} {
  const autoExitOnKill = config?.autoExitOnKill ?? true;
  const ignoresPoliteSignal = config?.ignoresPoliteSignal ?? false;
  let killCalls = 0;
  const signals: Array<string | undefined> = [];
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
    kill(signal?: string): void {
      killCalls += 1;
      signals.push(signal);
      // The polite signal is the one with no explicit name (the pty default). A child that ignores it
      // simply does not exit — no `onExit`, nothing reaped — until something uncatchable arrives.
      if (ignoresPoliteSignal && signal === undefined) {
        return;
      }
      if (autoExitOnKill) {
        fireExit();
      }
    },
  };
  return {
    pty,
    killCount: (): number => killCalls,
    killSignals: (): ReadonlyArray<string | undefined> => signals,
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

  it("AC2: close() ESCALATES to an uncatchable signal when the child ignores the polite one", async () => {
    // Given the child this whole backend's teardown is judged on: a free-running worker that catches
    // and ignores SIGHUP. Without an escalation "the child is reaped" is a promise kept only for
    // children that cooperate — this one never exits, never fires onExit, and leaves close() pending
    // FOREVER, which takes the emergency-stop, its retry, and shutdown's reaping down with it.
    const fake = makeFakePty({ ignoresPoliteSignal: true });
    const launcher = createPtySessionLauncher({
      workerCommand,
      spawn: () => fake.pty,
      killEscalationMs: 10,
    });
    const session = await launcher.launch(OPTIONS);

    // When teardown asks it to go.
    await session.close();

    // Then it was asked politely FIRST and forced only after declining — the ordering is the point, so
    // a cooperating worker still gets its chance to flush and exit on its own terms.
    expect(fake.killSignals()).toEqual([undefined, "SIGKILL"]);
    // And it really is gone: close() resolved, which it only does once onExit has reaped the child.
    await expect(session.liveness()).resolves.toBe("exited");
  });

  it("AC2: does NOT escalate against a child that goes politely — SIGKILL is the exception, not the routine", async () => {
    // The complement, and the one that keeps the escalation honest: a healthy worker exits on the
    // first signal in milliseconds and must never be SIGKILLed for it. An escalation that fired
    // anyway would be aimed at a dead pid — or, once the OS recycles it, at somebody else's process.
    const fake = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => fake.pty, killEscalationMs: 10 });
    const session = await launcher.launch(OPTIONS);

    await session.close();
    // Well past the window the escalation would have fired in.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fake.killSignals()).toEqual([undefined]);
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

  it("rejects a TYPED `spawn-failed` when the pty cannot be brought up for a reason it cannot name", async () => {
    // The spawner rejecting is the "backend cannot bring a surface up" signal. With no errno to read,
    // this backend does NOT guess (#33): `spawn-failed` is the honest answer, and the original
    // failure survives as `cause` rather than being swallowed.
    const cause = new Error("node-pty unavailable");
    const launcher = createPtySessionLauncher({ workerCommand, spawn: () => Promise.reject(cause) });

    const error = await launcher.launch(OPTIONS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SessionLaunchError);
    expect((error as SessionLaunchError).code).toBe("spawn-failed");
    expect((error as SessionLaunchError).cause).toBe(cause);
  });

  it("rejects a TYPED `worker-not-found` when the worker binary is not there (an ENOENT errno)", async () => {
    // The ONE cause a pty spawn names structurally: `ENOENT` on the executable. That is the patched
    // `claude` missing — a caller-fault no fallback backend would fix — NOT this backend being
    // unavailable, and the two send the operator to completely different fixes.
    const enoent = Object.assign(new Error("File not found: claude"), { code: "ENOENT" });
    const launcher = createPtySessionLauncher({
      workerCommand: () => ["claude", "--sdk-url", "http://127.0.0.1:1"],
      spawn: () => Promise.reject(enoent),
    });

    const error = await launcher.launch(OPTIONS).catch((e: unknown) => e);

    expect((error as SessionLaunchError).code).toBe("worker-not-found");
    // The message names the executable it could not run, so the operator knows WHAT is missing.
    expect((error as SessionLaunchError).message).toContain("claude");
    expect((error as SessionLaunchError).cause).toBe(enoent);
  });

  it("rejects a TYPED `spawn-failed` when the spawner throws synchronously", async () => {
    const launcher = createPtySessionLauncher({
      workerCommand,
      spawn: () => {
        throw new Error("spawn failed");
      },
    });

    const error = await launcher.launch(OPTIONS).catch((e: unknown) => e);

    expect((error as SessionLaunchError).code).toBe("spawn-failed");
  });

  it("rejects a worker command that names no executable (empty argv)", async () => {
    const launcher = createPtySessionLauncher({ workerCommand: () => [], spawn: () => makeFakePty().pty });

    await expect(launcher.launch(OPTIONS)).rejects.toThrow(/non-empty worker command/);
  });
});

// The owned pty's liveness reading (#35). Only TWO of the four readings are reachable here, and that
// is a property of this backend rather than a gap: `taken-over` needs a surface an operator can reach,
// and this one is explicitly not attachable; `unknown` needs a host to interrogate, and this backend
// owns its child and watches it exit directly.
describe("createPtySessionLauncher liveness (#35)", () => {
  it("reads a running pty as `alive-server-owned` — the server owns this child", async () => {
    const { pty } = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: recordingSpawner(pty).spawn });

    const session = await launcher.launch(OPTIONS);

    await expect(session.liveness()).resolves.toBe("alive-server-owned");
  });

  it("reads a pty whose child already exited as `exited` (AC4)", async () => {
    const { pty, fireExit } = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: recordingSpawner(pty).spawn });
    const session = await launcher.launch(OPTIONS);

    fireExit(); // the worker exited on its own

    await expect(session.liveness()).resolves.toBe("exited");
  });

  it("reads `exited` after its own close() reaped the child — probe and teardown cannot disagree", async () => {
    const { pty } = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: recordingSpawner(pty).spawn });
    const session = await launcher.launch(OPTIONS);

    await session.close();

    // Both read the same `exited` flag, so a second teardown pass over this handle sees a surface that
    // is gone (a no-op) rather than one it thinks it still owns.
    await expect(session.liveness()).resolves.toBe("exited");
  });

  it("never reports `taken-over` — an unattachable surface cannot be taken over", async () => {
    // The reading follows the degradation this backend already reports: `attachable: false` means there
    // is no way for an operator to reach this pty except through the ccctl UI, which IS the server.
    const { pty } = makeFakePty();
    const launcher = createPtySessionLauncher({ workerCommand, spawn: recordingSpawner(pty).spawn });

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.attachable).toBe(false);
    expect(await session.liveness()).not.toBe("taken-over");
  });
});
