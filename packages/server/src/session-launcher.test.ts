// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { isSurfaceLiveness, SURFACE_LIVENESS_READINGS } from "./session-launcher.js";
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

describe("SurfaceLiveness (the pinned set)", () => {
  it("holds exactly the five readings — the ONE thing `tsc` does not check about this set", () => {
    // `SURFACE_LIVENESS_READINGS` is typed `readonly SurfaceLiveness[]`, which accepts a SUBSET: a
    // member can be dropped from the array while staying in the union, and the compiler is happy. Every
    // exhaustive `Record<SurfaceLiveness, …>` in this package is checked against the UNION, so none of
    // them notices either — and the rule tests that count "of the five readings" derive their five from
    // this very array, so they would quietly under-test rather than fail.
    //
    // `host-unreachable` is the member that makes this worth a test rather than a nicety (#197): it is
    // the fail-closed target of `readLiveness`, so guard-ACCEPTS and guard-REJECTS are observationally
    // identical through the only boundary that narrows a backend's answer — drop it and the whole suite
    // stays green while `isSurfaceLiveness` (public API, `index.ts`) silently rejects a reading a
    // third-party backend is entitled to report. This literal is the gate.
    expect(SURFACE_LIVENESS_READINGS).toEqual([
      "alive-server-owned",
      "taken-over",
      "exited",
      "host-unreachable",
      "surface-indeterminate",
    ]);
  });

  it("accepts every pinned reading and fails closed on anything else", () => {
    for (const reading of SURFACE_LIVENESS_READINGS) {
      expect(isSurfaceLiveness(reading)).toBe(true);
    }
    // Named literally, not derived: the loop above would pass a set that had lost one.
    expect(isSurfaceLiveness("host-unreachable")).toBe(true);
    expect(isSurfaceLiveness("surface-indeterminate")).toBe(true);
    // The word #197 REPLACED. A backend still shipping it is a drifted build, and it must not be read
    // as a reading this server knows — `readLiveness` files it as `host-unreachable`, the safe side.
    expect(isSurfaceLiveness("unknown")).toBe(false);
    for (const value of ["", "probably-fine", null, undefined, 7, {}]) {
      expect(isSurfaceLiveness(value)).toBe(false);
    }
  });
});

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
