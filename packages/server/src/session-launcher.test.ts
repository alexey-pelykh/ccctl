// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions, SurfaceLiveness } from "./session-launcher.js";

// #28 ships the launcher PORT only — no backend (tmux #29 / owned-pty #30 follow). These
// tests lock the interface as a tested contract by standing up minimal in-memory launchers
// that implement it, exercising the shape #29/#30 must satisfy. They double as executable
// documentation of how a backend is expected to behave.

/** A fake tmux-style launcher: natively attachable, records what it was asked to launch. */
class FakeTmuxLauncher implements ISessionLauncher {
  lastOptions: SessionLaunchOptions | null = null;
  closeCount = 0;
  /** The reading its handle reports — settable, since a tmux window's is the one that really varies (#35). */
  liveness: SurfaceLiveness = "alive-server-owned";

  launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
    this.lastOptions = options;
    return Promise.resolve({
      attachment: { attachable: true, hint: "tmux attach -t ccctl:1" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve(this.liveness),
      close: (): Promise<void> => {
        this.closeCount += 1;
        return Promise.resolve();
      },
    });
  }
}

/** A fake owned-pty-style launcher: attachability DEGRADED, and it says so (#30). */
class FakePtyLauncher implements ISessionLauncher {
  launch(_options: SessionLaunchOptions): Promise<LaunchedSession> {
    return Promise.resolve({
      attachment: { attachable: false, hint: "owned pty: attach is degraded — no shared terminal to join" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
      close: (): Promise<void> => Promise.resolve(),
    });
  }
}

describe("ISessionLauncher (contract)", () => {
  it("resolves with a handle carrying the surface's attachment", async () => {
    const launcher = new FakeTmuxLauncher();

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(session.attachment.attachable).toBe(true);
    expect(session.attachment.hint).toContain("tmux attach");
  });

  it("surfaces DEGRADED attachability for a backend that cannot fully attach (owned-pty fallback, #30)", async () => {
    const launcher = new FakePtyLauncher();

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "plan" });

    expect(session.attachment.attachable).toBe(false);
    expect(session.attachment.hint).toMatch(/degraded/i);
  });

  it("passes every launch parameter through — cwd, permission mode, project, initial prompt", async () => {
    const launcher = new FakeTmuxLauncher();

    await launcher.launch({
      cwd: "/work/project",
      permissionMode: "acceptEdits",
      project: "atlas",
      initialPrompt: "start the failing test",
    });

    expect(launcher.lastOptions).toEqual({
      cwd: "/work/project",
      permissionMode: "acceptEdits",
      project: "atlas",
      initialPrompt: "start the failing test",
    });
  });

  it("launches with only the required parameters — project and initial prompt are optional", async () => {
    const launcher = new FakeTmuxLauncher();

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "bypassPermissions" });

    expect(launcher.lastOptions?.project).toBeUndefined();
    expect(launcher.lastOptions?.initialPrompt).toBeUndefined();
    expect(session.attachment.attachable).toBe(true);
  });

  it("tears the surface down on close, and close is safe to call more than once", async () => {
    const launcher = new FakeTmuxLauncher();
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(launcher.closeCount).toBe(2);
  });
});
