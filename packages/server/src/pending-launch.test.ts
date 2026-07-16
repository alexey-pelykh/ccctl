// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NO_OP_LOGGER, type LogEvent, type Logger, type Session } from "@ccctl/core";
import { createSessionEventRelays, relayFor } from "./event-stream.js";
import {
  canonicalCwd,
  claimPendingLaunch,
  clearPendingLaunches,
  evictPendingLaunch,
  resolveLaunchCwd,
  trackPendingLaunch,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
  type PendingLaunch,
  type PendingLaunchState,
} from "./pending-launch.js";
import type { LaunchedSession, SessionLaunchOptions, SurfaceLiveness } from "./session-launcher.js";

// The pending-launch registry (#33) in ISOLATION — the bookkeeping that makes a launch either
// CLAIMED (its worker registered) or EVICTED (it never did), and never a ghost. Hermetic: no server,
// no HTTP, no real terminal — just the state transitions and the timer, so each is pinned on its own.
// The wired-through behavior is covered by `ui-session-launch.test.ts`.

/**
 * A fake launched terminal: counts its closes, so eviction's "the child is reaped" half is observable.
 *
 * Reports `alive-server-owned` by default — the ordinary launched surface nobody has touched, which is
 * what eviction is entitled to reap (#35). Pass another reading to stand up the surfaces eviction must
 * NOT reap: `taken-over` is the operator driving it at their desk.
 */
function fakeLaunched(liveness: SurfaceLiveness = "alive-server-owned") {
  let closes = 0;
  const launched: LaunchedSession = {
    attachment: { attachable: true, hint: "tmux attach -t ccctl:1" },
    liveness: (): Promise<SurfaceLiveness> => Promise.resolve(liveness),
    close: (): Promise<void> => {
      closes += 1;
      return Promise.resolve();
    },
  };
  return { launched, closeCount: (): number => closes };
}

function makeState(registrationTimeoutMs = 60_000, logger: Logger = NO_OP_LOGGER): PendingLaunchState {
  return {
    sessions: new Map<string, Session>(),
    launchedSurfaces: new Map<string, LaunchedSession>(),
    pendingLaunches: new Map<string, PendingLaunch>(),
    eventRelays: createSessionEventRelays(),
    registrationTimeoutMs,
    logger,
  };
}

/** A capturing sink so a test can assert the lifecycle trail (#61) a launch birth / ghost eviction emitted. */
function captureLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { logger: { log: (event) => events.push(event) }, events };
}

const OPTIONS: SessionLaunchOptions = { cwd: "/work/atlas", permissionMode: "default" };

/**
 * Fixtures for the correlation key, built as REAL directories — because canonicalization can only be
 * proven against a directory whose spellings actually differ, and the ways they differ are
 * platform-specific:
 *
 *   - `LINKED_CWD` — a symlink (`link/` → `target/`). Bites on every platform. A bare `tmpdir()` path
 *     would NOT: macOS resolves `/var/…` to `/private/var/…` while Linux resolves `/tmp/…` to itself,
 *     so a test written against `tmpdir()` alone silently degenerates into comparing a string with
 *     itself on CI. The explicit symlink is what makes it real.
 *   - `CASE_VARIANT_CWD` — the same directory spelled in the wrong case (`mixedcase` for `MixedCase`).
 *     Only meaningful on a case-INSENSITIVE filesystem (macOS's default, Windows), which is exactly
 *     where it is dangerous: `getcwd(3)` normalizes case and Node's JS `realpathSync` does not, so a
 *     server canonicalizing with the wrong one produces a key the worker will never echo back. The
 *     tests that use it are skipped where the filesystem cannot produce it.
 *
 * Built at MODULE scope rather than in `beforeAll`, deliberately: `it.skipIf` is evaluated when a test
 * is COLLECTED, which happens before any `beforeAll` runs — so a flag assigned in `beforeAll` is still
 * its initial value at that moment, and the guarded test would be skipped on EVERY platform. A test
 * that never runs anywhere, reported as a harmless "skipped". The probe has to happen here for the
 * skip condition to mean what it says.
 */
const fixtureRoot = mkdtempSync(join(tmpdir(), "ccctl-pending-"));
const LINKED_CWD = join(fixtureRoot, "link");
mkdirSync(join(fixtureRoot, "target"));
symlinkSync(join(fixtureRoot, "target"), LINKED_CWD, "dir");
const RESOLVED_CWD = realpathSync.native(LINKED_CWD);

mkdirSync(join(fixtureRoot, "MixedCase"));
const CASE_VARIANT_CWD = join(fixtureRoot, "mixedcase");
const CASE_INSENSITIVE_FS = ((): boolean => {
  try {
    statSync(CASE_VARIANT_CWD); // the mis-cased spelling names the same real directory
    return true;
  } catch {
    return false; // case-sensitive filesystem: the variant simply does not exist
  }
})();

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * The cwd a process ACTUALLY launched at `cwd` reports as its own — the ground truth the whole
 * correlation rests on, read from the kernel rather than assumed. This is deliberately not a test of
 * `realpathSync` against `realpathSync`: the launched worker answers `getcwd(3)`, and the only
 * question that matters is whether this server's key agrees with THAT. Asserting against the real
 * thing is what makes the test independent of any belief about which realpath does what.
 */
function childReportedCwd(cwd: string): string {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd }).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("canonicalCwd", () => {
  it("agrees with the cwd a process launched at that path REPORTS — the correlation's ground truth", () => {
    expect(RESOLVED_CWD).not.toBe(LINKED_CWD); // the fixture is only meaningful if the spellings differ

    // Every spelling of one directory must key to the one string its worker will send back.
    expect(canonicalCwd(LINKED_CWD)).toBe(childReportedCwd(LINKED_CWD));
    expect(canonicalCwd(`${LINKED_CWD}/`)).toBe(childReportedCwd(LINKED_CWD));
    expect(canonicalCwd(join(LINKED_CWD, "nowhere", ".."))).toBe(childReportedCwd(LINKED_CWD));
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    "agrees on a MIS-CASED path too — `getcwd(3)` normalizes case, and the JS `realpathSync` does not",
    () => {
      // The sharp edge, and the reason this module uses `realpathSync.native`: on a case-insensitive
      // filesystem `…/mixedcase` and `…/MixedCase` are ONE directory, a process launched at either
      // reports the real case, and Node's JavaScript realpath echoes back whichever case it was given.
      // A server canonicalizing with it would store a key its own worker can never match — and then
      // evict the live session it launched.
      expect(childReportedCwd(CASE_VARIANT_CWD)).not.toBe(CASE_VARIANT_CWD);
      expect(canonicalCwd(CASE_VARIANT_CWD)).toBe(childReportedCwd(CASE_VARIANT_CWD));
    },
  );

  it("falls back to a lexical resolve for a path it cannot walk — bookkeeping never throws", () => {
    // The directory was deleted between the launch and the registration. A normalized absolute path is
    // still a far better key than the raw string, and the §2 leg must not fail over bookkeeping.
    expect(canonicalCwd("/ccctl-not-a-real-path/deeper/")).toBe(resolvePath("/ccctl-not-a-real-path/deeper"));
  });
});

describe("resolveLaunchCwd", () => {
  it("answers the path a process launched there will report — the SAME dialect the claim compares in", () => {
    // The launch mints the key and the claim matches it; if these two functions ever disagreed about
    // what "canonical" means, every claim would miss. Both are pinned to the kernel, not to each other.
    expect(resolveLaunchCwd(LINKED_CWD)).toBe(childReportedCwd(LINKED_CWD));
    expect(resolveLaunchCwd(`${LINKED_CWD}/`)).toBe(canonicalCwd(LINKED_CWD));
  });

  it.skipIf(!CASE_INSENSITIVE_FS)("answers the real case for a mis-cased directory", () => {
    expect(resolveLaunchCwd(CASE_VARIANT_CWD)).toBe(childReportedCwd(CASE_VARIANT_CWD));
  });

  it("answers undefined for anything that is not an existing directory — the typed `invalid-cwd`", () => {
    expect(resolveLaunchCwd(join(fixtureRoot, "does-not-exist"))).toBeUndefined();
    const file = join(fixtureRoot, "a-file");
    writeFileSync(file, "x");
    expect(resolveLaunchCwd(file)).toBeUndefined(); // it exists — but a session cannot be rooted at a file
  });
});

describe("DEFAULT_REGISTRATION_TIMEOUT_MS", () => {
  it("is the AC's ~10s window a launched session may stay `registering`", () => {
    expect(DEFAULT_REGISTRATION_TIMEOUT_MS).toBe(10_000);
  });
});

describe("trackPendingLaunch", () => {
  it("registers the launched session as `registering`, tracks its terminal, and records it pending", () => {
    const state = makeState();
    const { launched } = fakeLaunched();

    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    // Visible in the registry from LAUNCH — honestly marked as not-yet-live.
    expect(state.sessions.get("sess-1")?.status).toBe("registering");
    // Owned for shutdown teardown from the moment it exists (a registering terminal is a real one),
    // and owned UNDER THIS SESSION'S ID — which is what makes it addressable by an emergency-stop
    // (#76). A handle tracked but not keyed to its session is one shutdown can reap and nothing else.
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);
    // Pending, with the launch identity the §2 registration will be matched against.
    expect(state.pendingLaunches.get("sess-1")).toMatchObject({
      sessionId: "sess-1",
      cwd: OPTIONS.cwd,
      permissionMode: OPTIONS.permissionMode,
      launched,
    });
  });

  it("carries the launch's permission mode onto the registering session's life-long degraded marker", () => {
    const state = makeState();
    // `plan` is prompting → notifications are NOT degraded. (A non-prompting mode never reaches here:
    // the ingress refuses it before any launch — SRV-C-003 launch half, #32.)
    trackPendingLaunch(state, "sess-1", { cwd: "/w", permissionMode: "plan" }, fakeLaunched().launched);

    expect(state.sessions.get("sess-1")?.notificationsDegraded).toBe(false);
  });

  it("records the CANONICAL cwd — the form the worker will report, not the form the operator typed", () => {
    const state = makeState();
    trackPendingLaunch(state, "sess-1", { cwd: `${LINKED_CWD}/`, permissionMode: "default" }, fakeLaunched().launched);

    // The key the §2 registration is matched against is stored resolved, so the comparison is between
    // two paths of the same dialect. Storing the raw string is how a live session gets evicted.
    expect(state.pendingLaunches.get("sess-1")?.cwd).toBe(RESOLVED_CWD);
    // A lone launch on its (cwd, mode) is unambiguous — it may lend its id to its worker.
    expect(state.pendingLaunches.get("sess-1")?.ambiguous).toBe(false);
  });

  it("marks BOTH launches ambiguous when a second one shares a (cwd, mode)", () => {
    const state = makeState();
    trackPendingLaunch(state, "sess-first", OPTIONS, fakeLaunched().launched);
    expect(state.pendingLaunches.get("sess-first")?.ambiguous).toBe(false);

    trackPendingLaunch(state, "sess-second", OPTIONS, fakeLaunched().launched);

    // The pair now identifies NEITHER — including the one that was unambiguous a moment ago.
    expect(state.pendingLaunches.get("sess-first")?.ambiguous).toBe(true);
    expect(state.pendingLaunches.get("sess-second")?.ambiguous).toBe(true);
  });
});

describe("claimPendingLaunch", () => {
  it("matches a registration on (cwd, permissionMode), returns the id to REUSE, and disarms eviction", async () => {
    const state = makeState(30);
    const { launched, closeCount } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    const claimed = claimPendingLaunch(state, OPTIONS.cwd, OPTIONS.permissionMode);

    expect(claimed).toBe("sess-1");
    expect(state.pendingLaunches.size).toBe(0);
    // The claimed terminal is NOT closed and NOT un-tracked: the session is alive now, and the server
    // still owns its terminal until shutdown. It stays keyed by the id the claim just handed back —
    // the pending record is consumed here, so this map is the ONLY thing that still knows which
    // terminal the now-live session is running on, and #76's stop is addressed by exactly that.
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);

    // The eviction timer was disarmed — a claimed session is never reaped as a ghost. (Without this,
    // the timer would fire and close a LIVE session's terminal out from under it.)
    await sleep(120);
    expect(state.sessions.has("sess-1")).toBe(true);
    expect(closeCount()).toBe(0);
  });

  it("does NOT match a different cwd or a different permission mode", () => {
    const state = makeState();
    trackPendingLaunch(state, "sess-1", OPTIONS, fakeLaunched().launched);

    expect(claimPendingLaunch(state, "/somewhere/else", OPTIONS.permissionMode)).toBeUndefined();
    expect(claimPendingLaunch(state, OPTIONS.cwd, "plan")).toBeUndefined();
    // Unmatched: the launch is still pending, still awaiting ITS worker.
    expect(state.pendingLaunches.size).toBe(1);
  });

  it("returns undefined when nothing is pending — an ATTACHED (UC1) worker mints its own id", () => {
    expect(claimPendingLaunch(makeState(), OPTIONS.cwd, OPTIONS.permissionMode)).toBeUndefined();
  });

  it("refuses a RELATIVE cwd — it would resolve against the DAEMON's directory and false-claim", () => {
    // A real worker always reports an absolute `getcwd(3)`, so a relative cwd on the §2 wire is
    // malformed. Resolving it would key the registration to wherever the daemon happens to be
    // running — letting a malformed body steal a launch's id and disarm its eviction timer.
    const state = makeState();
    const daemonCwd = process.cwd();
    trackPendingLaunch(state, "sess-1", { cwd: daemonCwd, permissionMode: "default" }, fakeLaunched().launched);

    expect(claimPendingLaunch(state, ".", "default")).toBeUndefined();
    expect(claimPendingLaunch(state, "sub/dir", "default")).toBeUndefined();
    // The launch is untouched — still pending, still awaiting its own worker.
    expect(state.pendingLaunches.size).toBe(1);
    // And the well-formed absolute report still claims it.
    expect(claimPendingLaunch(state, daemonCwd, "default")).toBe("sess-1");
  });

  it("matches a registration whose cwd is the RESOLVED form of the path the launch was made with", async () => {
    const state = makeState(30);
    const { launched, closeCount } = fakeLaunched();
    // The operator launches through a symlink (or with a trailing slash, or via `/tmp` on macOS)…
    trackPendingLaunch(state, "sess-1", { cwd: LINKED_CWD, permissionMode: "default" }, launched);
    expect(RESOLVED_CWD).not.toBe(LINKED_CWD); // …and the two spellings really do differ.

    // …but the worker inside that terminal reports its `getcwd(3)`, which is always fully resolved.
    // Comparing the two verbatim misses, and a MISSED claim is the dangerous direction: the timer
    // stays armed on a session that DID register, and reaps a live session's terminal.
    expect(claimPendingLaunch(state, RESOLVED_CWD, "default")).toBe("sess-1");

    await sleep(120);
    expect(state.sessions.has("sess-1")).toBe(true);
    expect(closeCount()).toBe(0);
  });

  it("refuses to lend an id when two launches share a (cwd, mode) — and stays refusing (sticky)", async () => {
    const state = makeState(30);
    const first = fakeLaunched();
    const second = fakeLaunched();
    trackPendingLaunch(state, "sess-first", OPTIONS, first.launched);
    trackPendingLaunch(state, "sess-second", OPTIONS, second.launched);

    // The pair identifies NEITHER launch now, so neither may lend its id: reusing one would bind this
    // worker to a terminal it may well not be running in — a coin-flip cross-wiring (#20). The caller
    // mints a fresh id instead, which costs only the convenience of the handle shown at launch.
    expect(claimPendingLaunch(state, OPTIONS.cwd, OPTIONS.permissionMode)).toBeUndefined();
    // It still CONSUMED one pending launch — a worker did register, so one of these timers must be
    // disarmed or it will reap a LIVE terminal — and dropped the row nothing will ever advance now.
    expect(state.pendingLaunches.size).toBe(1);
    expect(state.sessions.has("sess-first")).toBe(false);
    // The terminal itself is untouched: a worker is running in it, unlike an evicted ghost's.
    expect(first.closeCount()).toBe(0);

    // STICKY: the survivor is the only match now, yet it still refuses. Consuming one member did not
    // make the other identifiable — the registration that consumed it could have come from either.
    expect(claimPendingLaunch(state, OPTIONS.cwd, OPTIONS.permissionMode)).toBeUndefined();
    expect(state.pendingLaunches.size).toBe(0);
    expect(state.sessions.has("sess-second")).toBe(false);

    // The safety property, and the whole reason a claim consumes even when it cannot identify: BOTH
    // timers were disarmed, so neither live worker's terminal is closed out from under it.
    await sleep(120);
    expect(first.closeCount()).toBe(0);
    expect(second.closeCount()).toBe(0);
  });

  it("taints only the shared pair — a launch in another directory still lends its id", () => {
    const state = makeState();
    trackPendingLaunch(state, "sess-a1", OPTIONS, fakeLaunched().launched);
    trackPendingLaunch(state, "sess-a2", OPTIONS, fakeLaunched().launched);
    trackPendingLaunch(state, "sess-b", { cwd: "/work/beta", permissionMode: "default" }, fakeLaunched().launched);

    // Ambiguity is a property of a (cwd, mode) GROUP, not a mode the whole registry falls into.
    expect(claimPendingLaunch(state, "/work/beta", "default")).toBe("sess-b");
  });

  // The interleaving that makes the ambiguous case genuinely dangerous, and the one a 2-launches /
  // 2-registrations test cannot reach: two launches in one directory, and only ONE worker ever comes
  // up. The claim consumes a record — but it CANNOT know whether it consumed the record of the launch
  // that registered or of the one that died. So from here, neither terminal can be proven dead, and a
  // per-launch eviction would close the live worker's terminal half the time.
  it("never closes a terminal in a group where a worker registered — even the one it evicts", async () => {
    const state = makeState(30);
    const first = fakeLaunched();
    const second = fakeLaunched();
    trackPendingLaunch(state, "sess-first", OPTIONS, first.launched);
    trackPendingLaunch(state, "sess-second", OPTIONS, second.launched);

    // ONE worker registers. It is in one of the two terminals; nothing on the wire says which.
    expect(claimPendingLaunch(state, OPTIONS.cwd, OPTIONS.permissionMode)).toBeUndefined();
    // The survivor is now off-limits to a destructive eviction.
    expect(state.pendingLaunches.get("sess-second")?.mayHoldLiveWorker).toBe(true);

    await sleep(120);

    // AC3 still holds on the LIST: the un-registered row is evicted and no longer shown.
    expect(state.sessions.has("sess-first")).toBe(false);
    expect(state.sessions.has("sess-second")).toBe(false);
    expect(state.pendingLaunches.size).toBe(0);
    // But NO terminal was closed — closing either would be a coin flip against the live session.
    // The surfaces stay owned by the server (`launchedSurfaces`) and are torn down at shutdown.
    expect(first.closeCount()).toBe(0);
    expect(second.closeCount()).toBe(0);
    expect(state.launchedSurfaces.get("sess-second")).toBe(second.launched);
    // Their entries OUTLIVE their rows — both rows are gone (asserted above) while both handles stay
    // owned for shutdown. That is what keeps the surface map safe to consult by key without knowing
    // anything about ambiguity: an emergency-stop resolves the SESSION first, so an entry whose row
    // was dropped is unreachable by construction rather than by a rule someone has to remember (#76).
    expect(state.launchedSurfaces.get("sess-first")).toBe(first.launched);
  });
});

describe("evictPendingLaunch", () => {
  it("reaps a ghost TOTALLY — session dropped, terminal closed, handle un-tracked, relay reaped", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);
    // A UI that subscribed to watch this session come up — its relay must not outlive the ghost (#176).
    relayFor(state.eventRelays, "sess-1");
    expect(state.eventRelays.has("sess-1")).toBe(true);

    await evictPendingLaunch(state, "sess-1");

    expect(state.sessions.has("sess-1")).toBe(false); // "the session list no longer shows it"
    expect(closeCount()).toBe(1); // the spawned child is reaped, not orphaned
    expect(state.launchedSurfaces.has("sess-1")).toBe(false); // shutdown will not re-close it
    expect(state.pendingLaunches.has("sess-1")).toBe(false);
    expect(state.eventRelays.has("sess-1")).toBe(false);
  });

  it("drops the ghost's ROW synchronously, before it has finished probing the terminal (#35)", () => {
    // The probe made the TERMINAL half of eviction asynchronous; the SESSION half must not follow it.
    // A ghost's row has to leave `GET /api/sessions` the moment eviction runs (#33 AC3), however long
    // interrogating its surface takes — the list's honesty cannot be held hostage to a tmux round-trip.
    const state = makeState();
    const { launched } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);
    relayFor(state.eventRelays, "sess-1");

    void evictPendingLaunch(state, "sess-1"); // deliberately NOT awaited

    expect(state.sessions.has("sess-1")).toBe(false);
    expect(state.pendingLaunches.has("sess-1")).toBe(false);
    expect(state.eventRelays.has("sess-1")).toBe(false);
  });

  it("fires automatically once the registration timeout elapses — the ghost-reaper of AC3", async () => {
    const state = makeState(30);
    const { launched, closeCount } = fakeLaunched();

    trackPendingLaunch(state, "sess-1", OPTIONS, launched);
    expect(state.sessions.has("sess-1")).toBe(true);

    await sleep(120);

    expect(state.sessions.has("sess-1")).toBe(false);
    expect(state.pendingLaunches.size).toBe(0);
    expect(closeCount()).toBe(1);
  });

  it("is a no-op on an unknown or already-claimed session — a registered session is never evicted", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);
    claimPendingLaunch(state, OPTIONS.cwd, OPTIONS.permissionMode);

    // The race the claim exists to win: the timer fires just after the worker registered.
    await evictPendingLaunch(state, "sess-1");
    await evictPendingLaunch(state, "never-existed");

    // The claimed session and its live terminal are untouched.
    expect(state.sessions.has("sess-1")).toBe(true);
    expect(closeCount()).toBe(0);
  });

  it("is idempotent — a second eviction reaps nothing twice", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    await evictPendingLaunch(state, "sess-1");
    await evictPendingLaunch(state, "sess-1");

    expect(closeCount()).toBe(1);
  });

  // Rule: A taken-over session is not killed — WIRED THROUGH the ghost-reaper (#35 AC2).
  //
  // The sharpest edge in the server, and the reason #35 is not only about shutdown. This timer fires
  // ~10s after launch, which is exactly when a takeover happens: the operator launches a session,
  // attaches at their desk and starts driving it by hand — so no worker ever registers, which is
  // precisely what this timer reads as "ghost". Un-probed, it closes the window they are typing in.
  it("evicts the ROW but does NOT kill a surface the operator took over (#35)", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched("taken-over");
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    await evictPendingLaunch(state, "sess-1");

    // The row still goes — the session list stays honest (#33 AC3): no worker registered, so there is
    // no live ccctl session here, whatever is on that terminal.
    expect(state.sessions.has("sess-1")).toBe(false);
    expect(state.pendingLaunches.has("sess-1")).toBe(false);
    // But the surface is untouched. The operator keeps working in it.
    expect(closeCount()).toBe(0);
    // And the server KEEPS the handle: if they detach before shutdown, shutdown's own release finds it
    // server-owned again and tears it down properly. Forgetting it here would strand a live surface.
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);
  });

  it("evicts the ROW but does NOT kill a surface whose host could not be reached (#35 AC5)", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched("host-unreachable");
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    await evictPendingLaunch(state, "sess-1");

    expect(state.sessions.has("sess-1")).toBe(false);
    expect(closeCount()).toBe(0);
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);
  });

  it("evicts the ROW but does NOT kill a surface reported indeterminate either (#35 AC5, #197)", async () => {
    // The ghost-reaper is the sharpest teardown in the server — it fires ~10s after launch, which is
    // exactly when a takeover happens. #197 made one non-answer forceable, and this pins that the reach
    // of that change stopped at the stop path: NOBODY asked this timer to kill anything, so a reachable
    // host is not a licence for it to. A surface it cannot read stays up.
    const state = makeState();
    const { launched, closeCount } = fakeLaunched("surface-indeterminate");
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    await evictPendingLaunch(state, "sess-1");

    expect(state.sessions.has("sess-1")).toBe(false);
    expect(closeCount()).toBe(0);
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);
  });

  it("un-tracks an already-exited surface without closing it — teardown is a no-op (#35 AC4)", async () => {
    const state = makeState();
    const { launched, closeCount } = fakeLaunched("exited");
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    await evictPendingLaunch(state, "sess-1");

    expect(state.sessions.has("sess-1")).toBe(false);
    // Nothing to close: the worker already exited on its own. No error, no destructive action.
    expect(closeCount()).toBe(0);
    // The surface IS gone, so — unlike the taken-over case above — the handle is dropped: there is
    // nothing left for shutdown to re-probe.
    expect(state.launchedSurfaces.has("sess-1")).toBe(false);
  });

  // The converse of the "never closes a terminal in a claimed group" rule — it must not over-apply.
  // An AMBIGUOUS group nobody ever registered from holds no live worker at all, so both of its
  // terminals are provably dead and both are reaped in full. Ambiguity alone does not buy a terminal
  // immunity; only a registration that could have come from any of them does.
  it("still closes BOTH terminals of an ambiguous group when no worker ever registered", async () => {
    const state = makeState(30);
    const first = fakeLaunched();
    const second = fakeLaunched();
    trackPendingLaunch(state, "sess-first", OPTIONS, first.launched);
    trackPendingLaunch(state, "sess-second", OPTIONS, second.launched);

    await sleep(120);

    expect(state.sessions.size).toBe(0);
    expect(first.closeCount()).toBe(1);
    expect(second.closeCount()).toBe(1);
    expect(state.launchedSurfaces.size).toBe(0);
  });
});

describe("clearPendingLaunches", () => {
  it("disarms every pending eviction at shutdown WITHOUT closing terminals (shutdown closes them)", async () => {
    const state = makeState(30);
    const { launched, closeCount } = fakeLaunched();
    trackPendingLaunch(state, "sess-1", OPTIONS, launched);

    clearPendingLaunches(state);

    expect(state.pendingLaunches.size).toBe(0);
    // The handle stays tracked — shutdown's own teardown closes it, so evicting here would only
    // double-close it.
    expect(state.launchedSurfaces.get("sess-1")).toBe(launched);

    // And the disarmed timer never fires against a dead server's state.
    await sleep(120);
    expect(closeCount()).toBe(0);
    expect(state.sessions.has("sess-1")).toBe(true);
  });
});

describe("pending-launch structured logging (#61)", () => {
  // Rule: a launch's `registering` birth and its ghost eviction both emit, so a launcher stuck at
  // `registering` — a leak-prone state — is diagnosable by a `created` with no matching `closed`.
  it("emits a `session`/`created` event, marked `registering`, when a launch is tracked", () => {
    const { logger, events } = captureLogger();
    const state = makeState(60_000, logger);

    trackPendingLaunch(state, "sess-1", OPTIONS, fakeLaunched().launched);

    expect(events).toEqual([
      {
        category: "session",
        level: "info",
        event: "created",
        sessionId: "sess-1",
        status: "registering",
        detail: "launched, awaiting §2 registration",
      },
    ]);
  });

  it("emits an `evicted` event when a launch never registers within the window (#33)", async () => {
    const { logger, events } = captureLogger();
    const state = makeState(60_000, logger);
    trackPendingLaunch(state, "sess-1", OPTIONS, fakeLaunched().launched);

    await evictPendingLaunch(state, "sess-1");

    // Birth then ghost death, paired by session id — exactly the pair a leak hunt correlates.
    expect(events.map((event) => event.event)).toEqual(["created", "evicted"]);
    expect(events[1]).toMatchObject({ category: "session", event: "evicted", sessionId: "sess-1", status: "closed" });
  });

  it("emits NOTHING when evicting a launch that was already claimed or gone (idempotent)", async () => {
    const { logger, events } = captureLogger();
    const state = makeState(60_000, logger);

    await evictPendingLaunch(state, "never-tracked");

    expect(events).toEqual([]);
  });
});
