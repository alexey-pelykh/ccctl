// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { decideRelease, releaseLaunchedSession } from "./session-release.js";
import { SURFACE_LIVENESS_READINGS, type LaunchedSession, type SurfaceLiveness } from "./session-launcher.js";

// The safe-teardown rule (#35) in ISOLATION — the "probe before you kill" policy that stands between
// every server teardown and a `close()`. Hermetic: no server, no HTTP, no tmux, no real process — a
// fake handle reports whatever reading a scenario needs, and the rule's whole observable output is
// whether `close()` was reached. `close()` IS what "killed" means here (it is the only destructive
// verb a handle has), so `closed === 0` is the assertion that a surface was not killed. The
// wired-through behavior — shutdown and the eviction timer routing through this rule — is covered by
// `ui-session-launch.test.ts` and `pending-launch.test.ts`; the per-backend readings that feed it are
// covered by `session-launcher-tmux.test.ts` and `session-launcher-pty.test.ts`.

/** A fake launched surface reporting a fixed (or thrown) {@link SurfaceLiveness}, recording what was done to it. */
function fakeSurface(liveness: SurfaceLiveness | (() => Promise<SurfaceLiveness>)) {
  const handle = {
    closed: 0,
    probed: 0,
    launched: {
      attachment: { attachable: true, hint: "tmux select-window -t @3 ; attach -t ccctl" },
      liveness: (): Promise<SurfaceLiveness> => {
        handle.probed += 1;
        return typeof liveness === "function" ? liveness() : Promise.resolve(liveness);
      },
      close: (): Promise<void> => {
        handle.closed += 1;
        return Promise.resolve();
      },
    } satisfies LaunchedSession,
  };
  return handle;
}

describe("decideRelease", () => {
  // Rule: A taken-over session is not killed.
  it("leaves a taken-over surface running — the operator has it (AC2)", () => {
    expect(decideRelease("taken-over")).toBe("leave-running");
  });

  // Rule: A server-owned session is torn down.
  it("tears down a surface that is alive and still server-owned (AC3)", () => {
    expect(decideRelease("alive-server-owned")).toBe("tear-down");
  });

  // Rule: Teardown of an already-exited session is a no-op.
  it("no-ops on a surface that already exited (AC4)", () => {
    expect(decideRelease("exited")).toBe("no-op");
  });

  it("treats an `unknown` reading as do-not-kill — a leaked process beats destroying live work (AC5)", () => {
    expect(decideRelease("unknown")).toBe("leave-running");
  });

  it("kills on exactly ONE of the four readings — the safety bias itself, pinned", () => {
    // The decision map is exhaustive by TYPE, but exhaustive-by-type only proves every reading HAS a
    // disposition — not that the bias survived an edit. `tsc` would be just as happy with a table that
    // tore down all four. This asserts the asymmetry: of the four readings, exactly one authorizes a
    // kill, and it is the one that says the surface is still ours.
    const killing = SURFACE_LIVENESS_READINGS.filter((reading) => decideRelease(reading) === "tear-down");

    expect(killing).toEqual(["alive-server-owned"]);
  });
});

describe("releaseLaunchedSession", () => {
  // Rule: A taken-over session is not killed.
  //
  //   Scenario: The operator is driving the session at the desk
  //     Given a launched session the operator has attached to and is driving locally
  //     When the server teardown fires for that session
  //     Then the session is not killed
  //     And the operator can continue working in it
  it("does not kill a session the operator took over at their desk (AC2)", async () => {
    const surface = fakeSurface("taken-over");

    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("leave-running");
    // "the operator can continue working in it": the ONE destructive verb a handle has was never
    // reached. The surface is untouched — teardown looked at it and walked away.
    expect(surface.closed).toBe(0);
  });

  // Rule: A server-owned session is torn down.
  //
  //   Scenario: An unattached server-owned session is torn down
  //     Given a launched session that is alive and still server-owned
  //     When the server teardown fires for that session
  //     Then the session's terminal surface is closed and the child is reaped
  it("tears down an unattached, still-server-owned session (AC3)", async () => {
    const surface = fakeSurface("alive-server-owned");

    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("tear-down");
    expect(surface.closed).toBe(1);
  });

  // Rule: Teardown of an already-exited session is a no-op.
  //
  //   Scenario: The session already exited
  //     Given a launched session that has already exited on its own
  //     When the server teardown fires for that session
  //     Then teardown completes without error and takes no destructive action
  it("is a no-op on an already-exited session — completes without error (AC4)", async () => {
    const surface = fakeSurface("exited");

    // "completes without error": awaiting IS the assertion — a reject fails the test.
    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("no-op");
    // "takes no destructive action".
    expect(surface.closed).toBe(0);
  });

  it("probes liveness BEFORE it tears anything down (AC1)", async () => {
    // The AC's ordering, pinned rather than assumed: a rule that closed first and probed afterwards
    // would satisfy every disposition assertion above while killing exactly the session it exists to
    // spare. Only the order tells the two apart.
    const order: string[] = [];
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "tmux select-window -t @3 ; attach -t ccctl" },
      liveness: (): Promise<SurfaceLiveness> => {
        order.push("probe");
        return Promise.resolve("alive-server-owned");
      },
      close: (): Promise<void> => {
        order.push("close");
        return Promise.resolve();
      },
    };

    await releaseLaunchedSession(launched);

    expect(order).toEqual(["probe", "close"]);
  });

  it("reads a probe that THREW as `unknown`, and so does not kill (AC5)", async () => {
    // A backend whose probe blew up (tmux vanished mid-shutdown, a runner rejected) knows nothing about
    // its surface — and "I cannot see it" must never be optimized into "it must be mine".
    const surface = fakeSurface(() => Promise.reject(new Error("tmux: no server running")));

    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("leave-running");
    expect(surface.closed).toBe(0);
  });

  it("reads a probe that answered OUTSIDE the pinned set as `unknown`, and so does not kill", async () => {
    // Fails CLOSED on the reading itself: a backend that answered a word this rule does not know (a
    // drifted build, a hand-rolled handle) must not have it read as one this rule does — least of all
    // fall through to the kill branch.
    const surface = fakeSurface(() => Promise.resolve("probably-fine" as SurfaceLiveness));

    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("leave-running");
    expect(surface.closed).toBe(0);
  });

  it("stays best-effort when close() itself rejects — the surface is gone either way", async () => {
    // The surface was ours and we tried; it had gone by the time we reached it (the operator closed the
    // window between the probe and the close). A benign race, not a failure: it resolves rather than
    // rejecting into a shutdown path or a timer callback, where nobody could act on the throw anyway.
    const launched: LaunchedSession = {
      attachment: { attachable: false, hint: "owned pty" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
      close: (): Promise<void> => Promise.reject(new Error("no such window")),
    };

    await expect(releaseLaunchedSession(launched)).resolves.toBe("tear-down");
  });

  it("probes exactly once per release — the reading is taken, not re-taken", async () => {
    const surface = fakeSurface("alive-server-owned");

    await releaseLaunchedSession(surface.launched);

    expect(surface.probed).toBe(1);
  });
});
