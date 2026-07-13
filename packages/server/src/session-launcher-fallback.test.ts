// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";
import { createFallbackSessionLauncher } from "./session-launcher-fallback.js";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "./session-launcher.js";

// The fallback composite is the reification of the port's "the caller falls back to another
// backend" contract (#31). These tests exercise it against fakes — one that RESOLVES (a surface
// came up) and one that REJECTS (the backend could not) — so no real tmux / pty is spawned.

/** A launcher that resolves with a tagged handle and records the options it was asked to launch. */
function resolvingLauncher(hint: string): ISessionLauncher & { lastOptions: SessionLaunchOptions | null } {
  const launcher = {
    lastOptions: null as SessionLaunchOptions | null,
    launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launcher.lastOptions = options;
      return Promise.resolve({
        attachment: { attachable: true, hint },
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
  return launcher;
}

/** A launcher that always rejects — the "backend cannot bring a surface up" signal (tmux absent). */
function rejectingLauncher(reason: string): ISessionLauncher {
  return {
    launch: (): Promise<LaunchedSession> => Promise.reject(new Error(reason)),
  };
}

const OPTIONS: SessionLaunchOptions = { cwd: "/repo", permissionMode: "default" };

describe("createFallbackSessionLauncher", () => {
  it("returns the primary backend's handle and does not try later backends", async () => {
    const fallback = resolvingLauncher("fallback");
    const fallbackSpy = vi.spyOn(fallback, "launch");
    const launcher = createFallbackSessionLauncher([resolvingLauncher("primary"), fallback]);

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.hint).toBe("primary");
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("falls back to the next backend when the primary rejects", async () => {
    const launcher = createFallbackSessionLauncher([rejectingLauncher("no tmux"), resolvingLauncher("fallback")]);

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.hint).toBe("fallback");
  });

  it("tries backends in order and returns the first that resolves", async () => {
    const launcher = createFallbackSessionLauncher([
      rejectingLauncher("no tmux"),
      rejectingLauncher("no pty"),
      resolvingLauncher("third"),
    ]);

    const session = await launcher.launch(OPTIONS);

    expect(session.attachment.hint).toBe("third");
  });

  it("rejects with an AggregateError carrying every backend failure when all reject", async () => {
    const launcher = createFallbackSessionLauncher([rejectingLauncher("no tmux"), rejectingLauncher("no pty")]);

    await expect(launcher.launch(OPTIONS)).rejects.toBeInstanceOf(AggregateError);
    const error = await launcher.launch(OPTIONS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it("throws at construction when given no backends", () => {
    expect(() => createFallbackSessionLauncher([])).toThrow(/at least one backend/);
  });

  it("passes the launch options through to the backend it uses", async () => {
    const primary = resolvingLauncher("primary");
    const launcher = createFallbackSessionLauncher([primary]);
    const options: SessionLaunchOptions = {
      cwd: "/work/atlas",
      permissionMode: "acceptEdits",
      project: "atlas",
      initialPrompt: "start",
    };

    await launcher.launch(options);

    expect(primary.lastOptions).toEqual(options);
  });
});
