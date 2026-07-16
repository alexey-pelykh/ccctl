// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { decideRelease, decideStop, releaseLaunchedSession, stopLaunchedSession } from "./session-release.js";
import { SURFACE_LIVENESS_READINGS, type LaunchedSession, type SurfaceLiveness } from "./session-launcher.js";

// The safe-teardown rule (#35) in ISOLATION — the "probe before you kill" policy that stands between
// every server teardown and a `close()`. Hermetic: no server, no HTTP, no tmux, no real process — a
// fake handle reports whatever reading a scenario needs, and the rule's whole observable output is
// whether `close()` was reached. `close()` IS what "killed" means here (it is the only destructive
// verb a handle has), so `closed === 0` is the assertion that a surface was not killed. The
// wired-through behavior — shutdown and the eviction timer routing through this rule — is covered by
// `ui-session-launch.test.ts` and `pending-launch.test.ts`; the per-backend readings that feed it are
// covered by `session-launcher-tmux.test.ts` and `session-launcher-pty.test.ts`.

/**
 * A fake launched surface reporting a fixed (or thrown) {@link SurfaceLiveness}, recording what was
 * done to it — and, once CLOSED, honestly reporting itself `exited`.
 *
 * That last part is not garnish, and it is why this fake models a WELL-BEHAVED backend: a close that
 * resolves leaves the surface gone, so the next probe must say so. Both real backends do exactly this
 * (the pty flips its `exited` flag; tmux's window stops being listed, which is precisely why a killed
 * window reads `exited` and never `taken-over`). A fake that kept answering `taken-over` forever would
 * be modelling a close that did NOTHING, and `stopLaunchedSession` re-reads the surface after a close
 * precisely to catch that — so such a fake would quietly assert the bug is fine. The tests that need a
 * misbehaving backend build one explicitly, inline, rather than bending this one (see the `REJECTS a
 * close() that RESOLVED over a still-live surface` family below); mirrors the same choice, for the same
 * stated reason, in `ui-session-stop.test.ts`'s `fakeLauncher`.
 */
function fakeSurface(liveness: SurfaceLiveness | (() => Promise<SurfaceLiveness>)) {
  let exited = false;
  const handle = {
    closed: 0,
    probed: 0,
    launched: {
      attachment: { attachable: true, hint: "tmux select-window -t @3 ; attach -t ccctl" },
      liveness: (): Promise<SurfaceLiveness> => {
        handle.probed += 1;
        if (exited) {
          return Promise.resolve("exited");
        }
        return typeof liveness === "function" ? liveness() : Promise.resolve(liveness);
      },
      close: (): Promise<void> => {
        handle.closed += 1;
        exited = true;
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

  it("treats an unreachable host as do-not-kill — a leaked process beats destroying live work (AC5)", () => {
    expect(decideRelease("host-unreachable")).toBe("leave-running");
  });

  it("treats an indeterminate surface as do-not-kill too — a reachable host is not a reason to kill (AC5)", () => {
    // #197 split `unknown` in two and gave FORCE a reason to treat the halves differently: a reachable
    // host means a kill would really travel. This table has no use for that fact — it is ccctl's OWN
    // unprompted teardown, where nobody asked for a kill at all. The tempting drift is to let "the
    // channel works" leak into a table whose question is not "can we?" but "were we asked?".
    expect(decideRelease("surface-indeterminate")).toBe("leave-running");
  });

  it("kills on exactly ONE of the five readings — the safety bias itself, pinned", () => {
    // The decision map is exhaustive by TYPE, but exhaustive-by-type only proves every reading HAS a
    // disposition — not that the bias survived an edit. `tsc` would be just as happy with a table that
    // tore down all five. This asserts the asymmetry: of the five readings, exactly one authorizes a
    // kill, and it is the one that says the surface is still ours. It is also what pins #197's split as
    // NON-widening here: growing the reading set did not grow the killing set.
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

  it("reads a probe that THREW as `host-unreachable`, and so does not kill (AC5)", async () => {
    // A backend whose probe blew up (tmux vanished mid-shutdown, a runner rejected) knows nothing about
    // its surface — and "I cannot see it" must never be optimized into "it must be mine".
    const surface = fakeSurface(() => Promise.reject(new Error("tmux: no server running")));

    const disposition = await releaseLaunchedSession(surface.launched);

    expect(disposition).toBe("leave-running");
    expect(surface.closed).toBe(0);
  });

  it("reads a probe that answered OUTSIDE the pinned set as `host-unreachable`, and so does not kill", async () => {
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

// The EMERGENCY-STOP rule (#76) — the same seam, asked a different question: not "may ccctl's own
// cleanup close this?" but "may the OPERATOR, who is asking, close this?". Same hermetic fakes, same
// `closed === 0` as the assertion that a surface was not killed. The wired-through behavior — the
// ingress, the addressing, the terminal transition — is covered by `ui-session-stop.test.ts`.

describe("decideStop", () => {
  // Rule: An unforced stop IS ccctl's own teardown rule — not a lookalike of it.
  //
  //   Scenario: The operator stops a session without forcing it
  //     Given any liveness reading a backend can produce
  //     When a stop is decided without force
  //     Then it decides exactly what the safe-teardown rule would have decided
  it("is decideRelease itself when unforced — for EVERY reading, not just the interesting ones", () => {
    // Not a tautology test. `decideStop` COULD have been written as its own unforced table, and that
    // table could drift from #35's by one cell without a single other test noticing — the drift would
    // be invisible precisely because both tables would look plausible. This pins the delegation: there
    // is ONE unforced rule in this server, and an unforced stop is it.
    for (const reading of SURFACE_LIVENESS_READINGS) {
      expect(decideStop(reading, false)).toBe(decideRelease(reading));
    }
  });

  // Rule: A taken-over session is not killed without an explicit force.
  it("refuses to kill a taken-over surface when the operator did not force it (AC3)", () => {
    expect(decideStop("taken-over", false)).toBe("leave-running");
  });

  // Rule: An explicit force kills a taken-over session.
  it("kills a taken-over surface when the operator DID force it (AC3)", () => {
    expect(decideStop("taken-over", true)).toBe("tear-down");
  });

  it("does NOT kill on an unreachable host, even forced — a kill cannot travel a channel that is down", () => {
    // The tempting reading of "force" is "kill it whatever you saw". Where the HOST could not be
    // reached, that would be a no-op that LIES: the owned pty can never report it (it observes its
    // child's exit directly), and tmux reports it only when the tmux CLI could not be reached at all —
    // where the window is already gone with its dead server, and where `close()` would travel the same
    // failed runner and swallow its own error. So a forced kill here would report a session "stopped"
    // that was never touched, which is the one answer an emergency-stop must never give.
    // `host-unreachable` is also where an out-of-set answer is filed, and forcing on it would kill on a
    // word this server has just said it does not understand.
    expect(decideStop("host-unreachable", true)).toBe("leave-running");
  });

  // Rule: An explicit force kills a surface whose reachable backend would not report on it (#197).
  it("KILLS an indeterminate surface when forced — the host is reachable, so the kill really travels", () => {
    // The half of the old `unknown` that force CAN act on, and the whole point of #197. The backend
    // reached its host and the host would not say what the surface is — so this rule does not know what
    // the surface is, but it does know the channel to it WORKS. That is precisely the premise the
    // refusal above lacks: `close()` will travel, and `stopLaunchedSession`'s post-close re-read will
    // verify that it landed. Refusing here would mean force may only kill what we already knew enough
    // not to need force for.
    expect(decideStop("surface-indeterminate", true)).toBe("tear-down");
  });

  it("does NOT kill an indeterminate surface UNFORCED — the reachable host is not itself consent", () => {
    // The other side of the cell above, and the one that keeps it honest: what force adds is the
    // operator's say-so, not the channel. Unforced, an unreadable surface is untouchable no matter how
    // healthy the host that would not describe it.
    expect(decideStop("surface-indeterminate", false)).toBe("leave-running");
  });

  it("still no-ops on an already-exited surface when forced — force cannot make it more gone", () => {
    expect(decideStop("exited", true)).toBe("no-op");
  });

  it("flips EXACTLY TWO cells of five — what `force` MEANS, pinned against a table that drifts", () => {
    // The two tables are exhaustive by TYPE, but exhaustive-by-type only proves every reading HAS a
    // forced disposition — `tsc` would be equally happy with a forced table that tore down all five,
    // which is the actual hazard here (force is the one flag in this server that can destroy a surface
    // ccctl itself refuses to touch). This asserts the SHAPE of the override: force is not "the rule was
    // too strict", it is "the rule was missing a fact the operator has", and it may be spent only where
    // the kill it authorizes can actually LAND.
    //
    // The set GREW by one at #197, and pinning it as a literal is what makes such a growth a decision
    // rather than a drift: `host-unreachable` must stay OUT (consent does not reconnect a socket) even
    // though its sibling went in, and these two are one word apart.
    const flipped = SURFACE_LIVENESS_READINGS.filter(
      (reading) => decideStop(reading, true) !== decideStop(reading, false),
    );

    expect(flipped).toEqual(["taken-over", "surface-indeterminate"]);
  });
});

describe("stopLaunchedSession", () => {
  // Rule: A taken-over session is not killed without an explicit force.
  //
  //   Scenario: The operator stops a session they are driving at their desk
  //     Given a launched session the operator has taken over
  //     When a stop is requested WITHOUT force
  //     Then the session is not killed
  //     And the refusal says which reading refused it
  it("does not kill a taken-over surface, and reports WHICH reading refused (AC3)", async () => {
    const surface = fakeSurface("taken-over");

    const outcome = await stopLaunchedSession(surface.launched, false);

    expect(outcome).toEqual({ disposition: "leave-running", liveness: "taken-over" });
    expect(surface.closed).toBe(0);
  });

  // Rule: An explicit force kills a taken-over session.
  //
  //   Scenario: The operator forces a stop on a session they took over
  //     Given a launched session the operator has taken over
  //     When a stop is requested WITH force
  //     Then the session is killed
  it("kills a taken-over surface when the operator forces it (AC3)", async () => {
    const surface = fakeSurface("taken-over");

    const outcome = await stopLaunchedSession(surface.launched, true);

    expect(outcome).toEqual({ disposition: "tear-down", liveness: "taken-over" });
    expect(surface.closed).toBe(1);
  });

  it("carries the `host-unreachable` reading out UNDISTINGUISHED from taken-over — two refusals, two facts", async () => {
    // `ReleaseDisposition` collapses both to `leave-running`, which is right for a teardown (nobody to
    // tell) and wrong for a request (someone is waiting to be told WHY). Reporting "you have this open
    // at your desk" when the truth is "tmux could not be reached" would fabricate a claim the operator
    // acts on — so the reading rides out alongside the disposition.
    const surface = fakeSurface("host-unreachable");

    const outcome = await stopLaunchedSession(surface.launched, true);

    expect(outcome).toEqual({ disposition: "leave-running", liveness: "host-unreachable" });
    expect(surface.closed).toBe(0);
  });

  it("refuses an indeterminate surface UNFORCED, and reports WHICH reading refused (#197)", async () => {
    const surface = fakeSurface("surface-indeterminate");

    const outcome = await stopLaunchedSession(surface.launched, false);

    expect(outcome).toEqual({ disposition: "leave-running", liveness: "surface-indeterminate" });
    expect(surface.closed).toBe(0);
  });

  // Rule: A kill decided on a reading that saw nothing must be CONFIRMED, not merely un-refuted (#197).
  //
  //   Scenario: A coy backend's close() silently fails
  //     Given a launched session whose backend reached its host, will not describe the surface, and
  //       whose close() swallows its own kill error (exactly as tmux's does)
  //     When the operator forces a stop
  //     Then the stop REJECTS rather than reporting the session stopped
  it("REJECTS a forced indeterminate kill nothing confirmed — a coy backend's swallowed close (#197)", async () => {
    // THE HAZARD THE FLIP ITSELF CREATES, and the reason the confirmation rule exists. A backend can be
    // coy AND have a close() that silently fails — the reading promises a working CHANNEL, never a
    // working KILL. Here the surface is live throughout: the decision probe never saw it, the close did
    // nothing, and the re-read still will not say. Fail-open would answer "stopped" over a live runaway
    // on the strength of no observation whatsoever — the module's cardinal sin, and one this flip made
    // newly reachable (before #197, force on this reading was refused outright).
    //
    // Note what this fixture CANNOT be pinned apart from: a backend whose close landed perfectly and
    // stays coy anyway reaches this same rejection, because from out here the two are the same readings
    // in the same order. That is the rule's honest cost, not a gap in it — it exists precisely because
    // the difference is unobservable, and the sin it prevents is the one that is fatal to guess wrong.
    let closes = 0;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "third-party backend" },
      // Never changes: the backend will not describe this surface, before or after the kill.
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("surface-indeterminate"),
      close: (): Promise<void> => {
        // The kill failed and the error was swallowed. From out here it looks like a clean teardown.
        closes += 1;
        return Promise.resolve();
      },
    };

    await expect(stopLaunchedSession(launched, true)).rejects.toThrow("nothing has ever confirmed it is gone");

    // It really did try — this is a verdict on the close's RESULT, not a refusal to attempt it.
    expect(closes).toBe(1);
  });

  it("accepts a forced indeterminate kill the re-read CONFIRMS — #197's own transient-backend case", async () => {
    // The case the issue actually names: a backend reporting indeterminacy "transiently, with a
    // `close()` that works perfectly" — the flip's whole point, so pin that it works.
    //
    // Read the fixture honestly, though: its coyness clears the INSTANT the close lands, which is the
    // FAVOURABLE half of "transient" and not a promise the reading makes. A backend coy because it is
    // loaded can still be coy a millisecond later with the surface genuinely gone — and that stop is
    // REJECTED (the test above is that path; from in here a landed close and a swallowed one are
    // indistinguishable, which is exactly why the rule cannot be free). So this pins the boundary, not a
    // guarantee that the intended backend is never bitten.
    let closed = false;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "third-party backend" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve(closed ? "exited" : "surface-indeterminate"),
      close: (): Promise<void> => {
        closed = true;
        return Promise.resolve();
      },
    };

    await expect(stopLaunchedSession(launched, true)).resolves.toEqual({
      disposition: "tear-down",
      liveness: "surface-indeterminate",
    });
  });

  it("probes, closes, then probes AGAIN — decide before acting, then verify what you did", async () => {
    // Given a surface that honestly reports itself gone once closed (both real backends do).
    // The FIRST probe is the safety property: force is exactly where skipping it would be tempting (the
    // operator already said kill it), and a stop that closed and then decided would satisfy every
    // verdict it reports while killing precisely the session the ambiguity rules exist to spare — it
    // would report `taken-over` on a surface it had already destroyed.
    // The LAST probe is the honesty property: `close()` resolving is the backend's CLAIM that it is
    // done, and a claim is not a proof — see `stopLaunchedSession`. Pinning the two together pins the
    // whole shape of a stop: decide, act, verify.
    const order: string[] = [];
    let exited = false;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "tmux attach -t ccctl" },
      liveness: (): Promise<SurfaceLiveness> => {
        order.push("probe");
        return Promise.resolve(exited ? "exited" : "alive-server-owned");
      },
      close: (): Promise<void> => {
        order.push("close");
        exited = true;
        return Promise.resolve();
      },
    };

    await stopLaunchedSession(launched, true);

    expect(order).toEqual(["probe", "close", "probe"]);
  });

  it("REJECTS when close() fails — a stop that did not stop must never resolve (AC2/AC4)", async () => {
    // The one deliberate divergence from `releaseLaunchedSession`, which swallows this exact reject.
    // Read that swallow's reason: it runs in a shutdown path and a timer callback, "where a stray
    // reject is an unhandled rejection rather than anything anyone can act on". A stop is neither —
    // there is an operator waiting, and the only thing they need from an emergency-stop is to be able
    // to BELIEVE it. Swallowing here would resolve `tear-down` — "stopped" — over a session that is
    // still running, ending the operator's attention on the one session that needed it.
    const launched: LaunchedSession = {
      attachment: { attachable: false, hint: "owned pty" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
      close: (): Promise<void> => Promise.reject(new Error("kill: operation not permitted")),
    };

    await expect(stopLaunchedSession(launched, true)).rejects.toThrow("operation not permitted");
  });

  it("REJECTS when close() never finishes — a stop must answer, and an owned pty can wait forever", async () => {
    // Given a surface whose close() never settles. That is not a contrived fake: the owned pty (#30)
    // signals its child and then awaits the child's OWN exit, unbounded, because "teardown is not
    // 'done' until it has exited". A child that does not die on SIGHUP leaves that await pending
    // forever — and #76 is the first close() caller with anyone on the other end. Unbounded, the HTTP
    // request holding this never answers, and Node will not close a server with a live request on it,
    // so one wedged child would take the daemon's shutdown with it.
    const launched: LaunchedSession = {
      attachment: { attachable: false, hint: "owned pty" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
      close: (): Promise<void> => new Promise<void>(() => {}),
    };

    // When the operator forces a stop, with the bound injected short (the same knob the real caller
    // leaves at its 5s default).
    // Then it gives up and says so, rather than hanging.
    await expect(stopLaunchedSession(launched, true, 20)).rejects.toThrow("did not finish closing within 20ms");
  });

  it("REJECTS a close() that RESOLVED over a still-live surface — a claim is not a proof", async () => {
    // Given a backend whose close() resolves while its surface keeps reporting itself alive and ours.
    // This is the abandoned-close retry, concretely: the owned pty latches `closed` BEFORE it awaits
    // the reaping, so once a stop has timed out and walked away, every later close() on that handle
    // returns instantly — cheerfully, and to a child that is still running.
    //
    // Without the re-read, the operator's retry after a `stop-failed` would answer "stopped" about the
    // one session that just refused to die. `FORCED_STOP_BY_LIVENESS` spends a paragraph refusing to
    // give exactly that answer for `host-unreachable`; a rule cannot argue that and then trust an
    // unverified close two functions later.
    let closes = 0;
    const launched: LaunchedSession = {
      attachment: { attachable: false, hint: "owned pty" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
      close: (): Promise<void> => {
        closes += 1;
        return Promise.resolve();
      },
    };

    await expect(stopLaunchedSession(launched, true)).rejects.toThrow("still running");

    // It really did try — this is a verdict on the close's RESULT, not a refusal to attempt it.
    expect(closes).toBe(1);
  });

  it("does NOT contradict a close() it cannot disprove — an indeterminate re-read is not a failure", async () => {
    // Given a backend whose kill worked and whose host, reached fine, simply would not describe the
    // surface afterwards.
    // The re-read fails OPEN here, unusually for this module, and deliberately: it is a check on our own
    // work rather than the do-not-kill rule. This reading is a host DECLINING to answer down a channel
    // that demonstrably works — which genuinely cannot contradict the close, and treating it as failure
    // would send the operator hunting a session that is already dead.
    //
    // Note the DECISION probe here is `alive-server-owned`: this stop definitely saw the surface, so
    // falling open is a choice between two stories about something we observed. That is exactly what
    // scopes the confirmation rule (#197) away from this case and onto the forced-indeterminate kill,
    // where nothing was observed at all. This test is the boundary — it fails if that rule ever widens
    // into "only `exited` may ever succeed".
    let closed = false;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "third-party backend" },
      liveness: (): Promise<SurfaceLiveness> =>
        Promise.resolve(closed ? "surface-indeterminate" : "alive-server-owned"),
      close: (): Promise<void> => {
        closed = true;
        return Promise.resolve();
      },
    };

    // Then the stop stands on the reading it DECIDED from, which is the one the operator asked about.
    await expect(stopLaunchedSession(launched, true)).resolves.toEqual({
      disposition: "tear-down",
      liveness: "alive-server-owned",
    });
  });

  // Rule: A stop may not report a teardown while the surface is still there to be seen.
  //
  //   Scenario: The operator retries a force-stop whose first attempt wedged
  //     Given a taken-over tmux window whose first forced stop timed out and answered `stop-failed`
  //     When the operator re-sends the same forced stop
  //     Then the stop REJECTS rather than reporting the session stopped
  it("REJECTS a close() whose re-read still SEES the surface, taken-over — a sighting refutes a close", async () => {
    // A `taken-over` re-read is a positive sighting of a LIVE surface, not an ambiguity: tmux reports it
    // only for a window still in its enumeration (`readWindowLiveness`), and a killed window is not
    // listed — it reads `exited`. So this proves the close did not work, exactly as `alive-server-owned`
    // does; the two differ only about WHO holds the surface, which is the decision probe's question.
    //
    // This is the reachable one, and it is the hazard `stopLaunchedSession` names in its own prose:
    // tmux's `close()` latches `closed` BEFORE it awaits the kill, so once a forced stop has timed out
    // and walked away, the operator's retry finds a handle whose `close()` returns instantly having sent
    // NO kill at all — over the very window that just refused to die. Fail-open here would answer
    // "stopped" about it. Modelled after the real backend rather than invented: `closes` counts the
    // kills that were actually attempted.
    let closes = 0;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "tmux attach -t ccctl" },
      // The operator has it, before AND after — nothing killed this window.
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve("taken-over"),
      close: (): Promise<void> => {
        // The abandoned-close retry: latched `closed`, so this sends nothing and resolves cheerfully.
        closes += 1;
        return Promise.resolve();
      },
    };

    await expect(stopLaunchedSession(launched, true)).rejects.toThrow("still running");
    expect(closes).toBe(1);
  });

  // Rule: A stop may not report a teardown that nothing confirmed (#197).
  //
  //   Scenario: The runner breaks between the decision probe and the kill
  //     Given a tmux window whose runner breaks after the stop decided to tear it down
  //     When the kill is sent and the post-close re-read cannot reach the host
  //     Then the stop REJECTS rather than reporting the session stopped
  it("REJECTS a close() whose host cannot be reached to confirm it — two unknowns are not a success (#197)", async () => {
    // THE BUG #197 EXISTS TO CLOSE. tmux's `close()` swallows EVERY `kill-window` error, so a kill that
    // failed is only ever catchable by this re-read. Before the split, the re-read read `unknown` from
    // that same broken runner and could not contradict it — so a LIVE tmux window was reported stopped,
    // in the narrow race where the runner breaks between the decision probe and the kill.
    //
    // Now the reading names the runner as the thing that broke, and the verdict follows: the kill went
    // into a channel that was down, and the confirmation came back from that same down channel.
    // Believing the close here is believing nobody.
    let killSent = false;
    const launched: LaunchedSession = {
      attachment: { attachable: true, hint: "tmux attach -t ccctl" },
      liveness: (): Promise<SurfaceLiveness> => Promise.resolve(killSent ? "host-unreachable" : "alive-server-owned"),
      close: (): Promise<void> => {
        // The runner is broken; `kill-window` fails and tmux's close() swallows the error, exactly as
        // the real backend does. From here it looks like a perfectly successful teardown.
        killSent = true;
        return Promise.resolve();
      },
    };

    await expect(stopLaunchedSession(launched, true)).rejects.toThrow("could not be reached to confirm");
  });

  it("does not kill an already-exited surface — nothing to stop, and it says so (AC4)", async () => {
    const surface = fakeSurface("exited");

    const outcome = await stopLaunchedSession(surface.launched, true);

    expect(outcome).toEqual({ disposition: "no-op", liveness: "exited" });
    expect(surface.closed).toBe(0);
  });

  it("fails closed to do-not-kill when the probe THROWS, even forced", async () => {
    // A backend that cannot answer must never be optimized into "it must be mine" — the same
    // fail-closed narrowing #35 relies on, reached through the same `readLiveness`, which is precisely
    // why the forced path lives in this module rather than re-implementing the most safety-critical
    // code in it at a call site.
    const surface = fakeSurface(() => Promise.reject(new Error("tmux: no server running")));

    const outcome = await stopLaunchedSession(surface.launched, true);

    // `host-unreachable`, not `surface-indeterminate` (#197): a throw means the ask itself did not
    // complete, so the one thing this server may NOT infer is that the channel works — which is exactly
    // the premise the other reading asserts, and exactly what force would spend a kill on.
    expect(outcome).toEqual({ disposition: "leave-running", liveness: "host-unreachable" });
    expect(surface.closed).toBe(0);
  });

  it("fails closed to `host-unreachable` on an OUT-OF-SET answer, even forced (#197)", async () => {
    // The other fail-closed path, and the sharper one now that a non-answer can be forceable: an
    // unintelligible word must land on the reading that assumes LEAST, or a drifted build could talk
    // this server into a forced kill by saying something it does not understand.
    const surface = fakeSurface(() => Promise.resolve("probably-fine" as SurfaceLiveness));

    const outcome = await stopLaunchedSession(surface.launched, true);

    expect(outcome).toEqual({ disposition: "leave-running", liveness: "host-unreachable" });
    expect(surface.closed).toBe(0);
  });
});
