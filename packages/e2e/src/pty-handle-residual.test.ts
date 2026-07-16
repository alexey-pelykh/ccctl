// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  classifyPtyHandleResidual,
  describePtyFence,
  LEAK_CONTROL_REAP_TIMEOUT_MS,
  PTY_RESIDUAL_CHECK,
  readHandleState,
  REAP_CONVERGENCE_TIMEOUT_MS,
  resolvePtyE2EEnv,
  WORKER_ARGS,
  WORKER_SLEEP_SECONDS,
  type HandleReading,
  type PtyResidualCapture,
} from "./pty-handle-residual.js";

// The CREDENTIAL-FREE half of the #68 real-pty handle-residual oracle: its FENCE, its PURE
// CLASSIFIER (the Tier-A encoding of #68's two ACs), and the OS PROBE's own semantics. This runs in
// the plain `test` lane on EVERY box — no node-pty, no native binding, no fenced env — because what
// is fenced about the oracle is the BINDING, not the JUDGMENT. The e2e spec
// (`pty-handle-residual.e2e.test.ts`) drives the real binding and does nothing but dispatch on the
// verdict this file pins.
//
// The probe tests below are the notable ones: `readHandleState` reads the OS, so it is impure — but
// it needs no pty to be proven. A live pid (our own), a reaped pid, a real open fd, a closed fd, and
// a character device are all obtainable credential-free, and they are exactly the readings the
// classifier's verdicts turn on. Pinning them here means a `drift` from the fenced run is a statement
// about the DAEMON, not about whether the probe can tell an open fd from a closed one.

const LIVE: HandleReading = {
  childPresent: true,
  fdOpen: true,
  fdIdentity: "16777232:268435459:610",
  fdCharacterDevice: true,
};

const GONE: HandleReading = {
  childPresent: false,
  childErrno: "ESRCH",
  fdOpen: false,
  fdErrno: "EBADF",
};

/** A complete, healthy capture — every leg observed, the two readings DISAGREEING as they must. */
function healthyCapture(overrides: Partial<PtyResidualCapture> = {}): PtyResidualCapture {
  return {
    spawned: { pid: 4242, fd: 12 },
    launchStatus: 201,
    sessionId: "session-abc",
    listedStatus: "registering",
    atLaunch: LIVE,
    afterTeardown: GONE,
    teardownDriven: true,
    ...overrides,
  };
}

describe("resolvePtyE2EEnv (#68) — the real-pty oracle's own fence", () => {
  it("is READY only when BOTH the master switch and the pty arm are set", () => {
    expect(resolvePtyE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_PTY: "1" })).toEqual({ ready: true });
  });

  it("is NOT ready when the shared master switch is absent, and names it", () => {
    expect(resolvePtyE2EEnv({ CCCTL_E2E_PTY: "1" })).toEqual({ ready: false, missing: ["CCCTL_E2E"] });
  });

  it("is NOT ready when the pty arm is absent, and names it", () => {
    expect(resolvePtyE2EEnv({ CCCTL_E2E: "1" })).toEqual({ ready: false, missing: ["CCCTL_E2E_PTY"] });
  });

  it("names EVERY absent var, not just the first — an operator fixes one round-trip, not two", () => {
    expect(resolvePtyE2EEnv({})).toEqual({ ready: false, missing: ["CCCTL_E2E", "CCCTL_E2E_PTY"] });
  });

  it.each(["", "  ", "0", "false", "FALSE", "no", "No"])(
    "reads %o as OFF — the conventional spellings, matching every sibling fence in this package",
    (value) => {
      expect(resolvePtyE2EEnv({ CCCTL_E2E: value, CCCTL_E2E_PTY: "1" }).ready).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "on", "please"])("reads %o as ON — present and not an OFF spelling", (value) => {
    expect(resolvePtyE2EEnv({ CCCTL_E2E: value, CCCTL_E2E_PTY: value }).ready).toBe(true);
  });

  it("does NOT reuse the tailnet or live-worker arms — a box with a tailnet has not thereby got a pty", () => {
    // The prerequisite is a different piece of infrastructure (a native binding that loads AND can
    // spawn), so a run armed only for the tunnel oracles must NOT arm this one.
    expect(resolvePtyE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_TAILSCALE: "1", ANTHROPIC_API_KEY: "sk-x" }).ready).toBe(false);
  });

  it("describes both states for the suite title", () => {
    expect(describePtyFence({ ready: true })).toContain("armed");
    expect(describePtyFence({ ready: false, missing: ["CCCTL_E2E_PTY"] })).toContain("CCCTL_E2E_PTY");
  });
});

describe("the worker sleep ⟷ convergence-window coupling (#68) — the invariant that fails as a GREEN", () => {
  it("keeps the stand-in worker alive strictly past the drive's own tail", () => {
    // THE guard on the subtlest trap in this oracle. If the `sleep` expired before the
    // after-teardown reading, node-pty would reap the child — and close its master fd — on the
    // child's OWN exit, and the drive would read a clean `verified` while crediting the daemon with
    // a teardown it never performed. A LEAKING daemon would pass. The failure is invisible because
    // it fails GREEN, so the floor is computed from the window rather than written down and hoped
    // for — and this pins that it is really cleared, so raising one constant without the other
    // fails HERE, loudly, instead of silently downgrading the oracle to a rubber stamp.
    expect(WORKER_SLEEP_SECONDS * 1_000).toBeGreaterThan(REAP_CONVERGENCE_TIMEOUT_MS);
  });

  it("bakes the derived duration into the argv the launcher actually runs", () => {
    // The derivation is worthless if the argv still carries a stale literal.
    expect(WORKER_ARGS).toEqual(["-c", `exec sleep ${WORKER_SLEEP_SECONDS}`]);
    expect(WORKER_SLEEP_SECONDS).toBe(30);
  });

  it("keeps the negative control's window BELOW the sleep — the safe direction for an override", () => {
    // A caller may only ever shorten the window (the control does, deliberately). A longer one would
    // reopen the hole from outside the module, which the derivation cannot prevent.
    expect(LEAK_CONTROL_REAP_TIMEOUT_MS).toBeLessThan(WORKER_SLEEP_SECONDS * 1_000);
  });
});

describe("readHandleState (#68) — the OS probe's semantics, proven WITHOUT a pty", () => {
  it("reads a LIVE pid as present — our own process is the one pid we know exists", () => {
    const fd = openSync(process.execPath, "r");
    try {
      const reading = readHandleState(process.pid, fd);
      expect(reading.childPresent).toBe(true);
      expect(reading.childErrno).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });

  it("reads a REAPED pid as absent with ESRCH — the exact reading AC2's `reaped` turns on", () => {
    // spawnSync runs the child to completion and REAPS it before returning, so its pid is gone from
    // the process table — which is what ESRCH means, and what distinguishes a reap from a zombie.
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]);
    expect(dead.status).toBe(0);
    const fd = openSync(process.execPath, "r");
    try {
      const reading = readHandleState(dead.pid ?? 0, fd);
      expect(reading.childPresent).toBe(false);
      expect(reading.childErrno).toBe("ESRCH");
    } finally {
      closeSync(fd);
    }
  });

  it("reads an OPEN fd as open, and reports WHAT it points at (the identity a recycled number needs)", () => {
    const fd = openSync(process.execPath, "r");
    try {
      const reading = readHandleState(process.pid, fd);
      expect(reading.fdOpen).toBe(true);
      expect(reading.fdErrno).toBeUndefined();
      expect(reading.fdIdentity).toMatch(/^\d+:\d+:\d+$/);
    } finally {
      closeSync(fd);
    }
  });

  it("reads a CLOSED fd as released with EBADF — the exact reading AC2's `fd closed` turns on", () => {
    const fd = openSync(process.execPath, "r");
    closeSync(fd);
    const reading = readHandleState(process.pid, fd);
    expect(reading.fdOpen).toBe(false);
    expect(reading.fdErrno).toBe("EBADF");
    expect(reading.fdIdentity).toBeUndefined();
  });

  it("distinguishes a CHARACTER DEVICE from a regular file — a pty master is the former", () => {
    // /dev/null is a character device, as a pty master is; a regular file is not. This is the check
    // that catches a backend handing back a descriptor onto something that is not a pty at all.
    const chr = openSync("/dev/null", "r");
    const reg = openSync(process.execPath, "r");
    try {
      expect(readHandleState(process.pid, chr).fdCharacterDevice).toBe(true);
      expect(readHandleState(process.pid, reg).fdCharacterDevice).toBe(false);
    } finally {
      closeSync(chr);
      closeSync(reg);
    }
  });

  it("gives two DIFFERENT identities for two different objects — so a recycled number is detectable", () => {
    const a = openSync(process.execPath, "r");
    const b = openSync("/dev/null", "r");
    try {
      expect(readHandleState(process.pid, a).fdIdentity).not.toBe(readHandleState(process.pid, b).fdIdentity);
    } finally {
      closeSync(a);
      closeSync(b);
    }
  });
});

describe("classifyPtyHandleResidual (#68) — verified: the whole claim held", () => {
  it("VERIFIES a real launch whose fd and child were live at launch and gone after teardown", () => {
    const report = classifyPtyHandleResidual(healthyCapture());
    expect(report.verdict).toBe("verified");
    expect(report.violations).toEqual([]);
    expect(report.reason).toContain("no residual");
  });

  it("VERIFIES when the fd NUMBER was recycled onto a DIFFERENT object — that is a release, not a leak", () => {
    // POSIX hands out the lowest free descriptor, so the pty master's number is a prime candidate for
    // the next thing this process opens. A bare "is fd 12 open?" would call this a leak and fail a
    // faithful daemon; the identity is what tells reuse from residue.
    const report = classifyPtyHandleResidual(
      healthyCapture({
        afterTeardown: {
          childPresent: false,
          childErrno: "ESRCH",
          fdOpen: true,
          fdIdentity: "99:5:777", // a DIFFERENT object now holds the number
          fdCharacterDevice: false,
        },
      }),
    );
    expect(report.verdict).toBe("verified");
  });
});

describe("classifyPtyHandleResidual (#68) — drift: a residual was OBSERVED", () => {
  it("DRIFTS when the child SURVIVED teardown — the orphaned worker AC2 forbids", () => {
    const report = classifyPtyHandleResidual(
      healthyCapture({ afterTeardown: { ...GONE, childPresent: true, childErrno: undefined } }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.childReaped);
  });

  it("DRIFTS when the child is present as EPERM — the pid still exists, so it was NOT reaped", () => {
    // EPERM means "exists, not yours to signal". Reading it as gone would let a leak that changed
    // ownership pass as a clean reap.
    const report = classifyPtyHandleResidual(
      healthyCapture({ afterTeardown: { ...GONE, childPresent: true, childErrno: "EPERM" } }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain("EPERM");
  });

  it("DRIFTS when the fd is still open on the SAME object — the leaked descriptor", () => {
    const report = classifyPtyHandleResidual(
      healthyCapture({
        afterTeardown: { childPresent: false, childErrno: "ESRCH", fdOpen: true, fdIdentity: LIVE.fdIdentity },
      }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.fdReleased);
  });

  it("DRIFTS when a real pty was spawned but the daemon denied the launch — a surface it disowns", () => {
    const report = classifyPtyHandleResidual(healthyCapture({ launchStatus: 502, launchFailure: "spawn-failed" }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.launch);
  });

  it("DRIFTS when the launched fd is open but is NOT a character device — that is not a pty master", () => {
    const report = classifyPtyHandleResidual(healthyCapture({ atLaunch: { ...LIVE, fdCharacterDevice: false } }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.fdOpened);
  });

  it("reports EVERY violated check, not merely the first — one round-trip, not N", () => {
    const report = classifyPtyHandleResidual(
      healthyCapture({ afterTeardown: { childPresent: true, fdOpen: true, fdIdentity: LIVE.fdIdentity } }),
    );
    expect(report.verdict).toBe("drift");
    expect(report.violations).toHaveLength(2);
  });

  it("checks DRIFT BEFORE gaps — a leak is a leak even if a later leg went missing", () => {
    // Ordering is load-bearing: a present-but-wrong observation must never be masked by a downstream
    // inconclusive gap, or a daemon could hide a leak by also failing to be listed.
    const report = classifyPtyHandleResidual(
      healthyCapture({ listedStatus: undefined, afterTeardown: { ...GONE, childPresent: true } }),
    );
    expect(report.verdict).toBe("drift");
  });
});

describe("classifyPtyHandleResidual (#68) — the self-guard: the positive can never be vacuous", () => {
  it("NEVER verifies when the probe read the handle as GONE at launch — nothing was there to reap", () => {
    // THE guard. A residual check asks "is it gone?", and its failure mode is a probe that says "gone"
    // because it never looked. AC2's "opened on launch" is a claim under test, so a probe stuck on
    // "gone" fails it here and can never reach `verified` — the two readings MUST disagree.
    const report = classifyPtyHandleResidual(healthyCapture({ atLaunch: GONE }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.childLive);
    expect(report.violations.join(" ")).toContain(PTY_RESIDUAL_CHECK.fdOpened);
  });

  it("NEVER verifies when the probe reads the handle as PRESENT throughout — a probe stuck on `alive`", () => {
    const report = classifyPtyHandleResidual(healthyCapture({ afterTeardown: LIVE }));
    expect(report.verdict).toBe("drift");
  });

  it("NEVER verifies without an at-launch reading at all — an unobserved precondition is a gap", () => {
    expect(classifyPtyHandleResidual(healthyCapture({ atLaunch: undefined })).verdict).toBe("inconclusive");
  });
});

describe("classifyPtyHandleResidual (#68) — inconclusive: skips, never fakes", () => {
  it("is INCONCLUSIVE when the real backend never brought a pty up, and names the daemon's own reason", () => {
    // The default-checkout outcome: node-pty cannot load (no Linux prebuild) or cannot spawn (the
    // shipped spawn-helper is left non-executable by `allowBuilds: node-pty: false`).
    const report = classifyPtyHandleResidual({
      spawned: undefined,
      launchStatus: 502,
      launchFailure: "backend-unavailable",
      teardownDriven: true,
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.violations).toEqual([]);
    expect(report.reason).toContain("backend-unavailable");
  });

  it("is INCONCLUSIVE — NOT drift — when the launch failed and no pty spawned: that is an absent backend", () => {
    // The discriminator against the drift case above: a non-201 WITHOUT a spawn is the backend being
    // unavailable (a runtime-skip), whereas a non-201 WITH a spawn is a contradiction (a drift).
    expect(classifyPtyHandleResidual({ launchStatus: 502, launchFailure: "spawn-failed" }).verdict).toBe(
      "inconclusive",
    );
  });

  it("is INCONCLUSIVE when the handle exposes no master fd — a ConPTY is not a POSIX pty", () => {
    const report = classifyPtyHandleResidual(
      healthyCapture({ spawned: { pid: 4242, fd: undefined }, atLaunch: undefined, afterTeardown: undefined }),
    );
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(PTY_RESIDUAL_CHECK.masterFd);
  });

  it("is INCONCLUSIVE when the teardown was never driven — the claim was never put to the test", () => {
    const report = classifyPtyHandleResidual(healthyCapture({ teardownDriven: false, afterTeardown: undefined }));
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(PTY_RESIDUAL_CHECK.childReaped);
  });

  it("is INCONCLUSIVE when the session was never listed — AC1's end-to-end leg went unobserved", () => {
    expect(classifyPtyHandleResidual(healthyCapture({ listedStatus: undefined })).verdict).toBe("inconclusive");
  });

  it("is INCONCLUSIVE when the daemon's ingress never answered", () => {
    expect(classifyPtyHandleResidual(healthyCapture({ launchStatus: undefined })).verdict).toBe("inconclusive");
  });

  it("names EVERY gap in one report — an operator diagnoses once", () => {
    const report = classifyPtyHandleResidual({});
    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(PTY_RESIDUAL_CHECK.backend);
    expect(report.reason).toContain(PTY_RESIDUAL_CHECK.launch);
    expect(report.reason).toContain(PTY_RESIDUAL_CHECK.listed);
  });
});
