// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";
import { createFallbackSessionLauncher } from "./session-launcher-fallback.js";
import {
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "./session-launcher.js";

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
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
  return launcher;
}

/** A launcher that always rejects with the given error — for pinning how the composite CLASSIFIES it (#33). */
function failingLauncher(error: unknown): ISessionLauncher {
  return { launch: (): Promise<LaunchedSession> => Promise.reject(error) };
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

  it("rejects a TYPED `backend-unavailable` when all reject, carrying every backend failure as its cause", async () => {
    const launcher = createFallbackSessionLauncher([rejectingLauncher("no tmux"), rejectingLauncher("no pty")]);

    const error = await launcher.launch(OPTIONS).catch((caught: unknown) => caught);

    // N failures, ONE answer (#33): nothing more specific was named, so the honest, literal reading
    // is the one it gives — no backend could bring a surface up.
    expect(error).toBeInstanceOf(SessionLaunchError);
    expect((error as SessionLaunchError).code).toBe("backend-unavailable");
    // Every backend's own failure survives underneath, so a log can still say WHICH failed and how.
    const cause = (error as SessionLaunchError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toHaveLength(2);
  });

  // The rule that keeps the composite's answer HONEST: a launch that is wrong in itself fails on
  // every backend identically, so "all backends rejected" says nothing about the host. Reporting
  // `backend-unavailable` there would be true-but-misleading — it would send the operator off
  // installing tmux to fix a missing worker binary.
  it("prefers a CALLER-FAULT code over `backend-unavailable` when one is among the failures", async () => {
    const launcher = createFallbackSessionLauncher([
      rejectingLauncher("no tmux"),
      failingLauncher(new SessionLaunchError("worker-not-found", "ccctl: could not run `claude`")),
    ]);

    const error = await launcher.launch(OPTIONS).catch((caught: unknown) => caught);

    expect((error as SessionLaunchError).code).toBe("worker-not-found");
    // The full picture is still preserved beneath it.
    expect((error as SessionLaunchError).cause).toBeInstanceOf(AggregateError);
  });

  it("still answers `backend-unavailable` when every failure is a backend's own unavailability", async () => {
    const launcher = createFallbackSessionLauncher([
      failingLauncher(new SessionLaunchError("backend-unavailable", "ccctl: tmux is absent")),
      failingLauncher(new SessionLaunchError("backend-unavailable", "ccctl: node-pty would not load")),
    ]);

    const error = await launcher.launch(OPTIONS).catch((caught: unknown) => caught);

    expect((error as SessionLaunchError).code).toBe("backend-unavailable");
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
