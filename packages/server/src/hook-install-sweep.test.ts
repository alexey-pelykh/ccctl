// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyHookInstallFileName,
  isProcessAlive,
  LEGACY_HOOK_INSTALL_GRACE_MS,
  sweepOrphanedHookInstalls,
  type ProcessAlivenessProbe,
} from "./hook-install-sweep.js";
import { hookInstallFileName, installAskUserQuestionHookSettings } from "./hook-settings-installer.js";

// The startup hook-install sweep (#275, ADR-008) in ISOLATION — no daemon, no launcher. The orphan class
// it exists for is unreachable by every #262 cleanup path (both read the in-memory `ServerState.hookInstalls`,
// which a SIGKILL erases), so the ONLY thing that can decide a file's fate here is its name plus a liveness
// probe. These tests fix both halves of that decision, and — more importantly — the two race legs that make
// a shared-directory sweep safe at all. `index.test.ts` proves the sweep is actually CALLED at startup.

const DEAD_PID = 4242;
const LIVE_PID = 777;
const OWN_PID = 31337;

/** A probe with an explicit live set — the sweep's whole live/dead input, made deterministic. */
function probeWithLive(...livePids: number[]): ProcessAlivenessProbe {
  const live = new Set(livePids);
  return (pid) => live.has(pid);
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ccctl-hook-sweep-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Write one install-shaped file and return its name. */
function writeFile(name: string, mtimeMs?: number): string {
  const path = join(stateDir, name);
  writeFileSync(path, "{}", { mode: 0o600 });
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
  }
  return name;
}

/** Sweep this test's directory with a fixed own-pid, probe, and clock. */
function sweep(isAlive: ProcessAlivenessProbe, now = Date.now()) {
  return sweepOrphanedHookInstalls({ stateDir, ownPid: OWN_PID, isAlive, now });
}

describe("classifyHookInstallFileName — ownership is decidable from the name alone", () => {
  it("reads the owner PID and role off an owned install file", () => {
    expect(classifyHookInstallFileName(hookInstallFileName(4242, "tok-a", "settings"))).toEqual({
      kind: "owned",
      ownerPid: 4242,
      role: "settings",
    });
    expect(classifyHookInstallFileName(hookInstallFileName(9, "tok-b", "handoff"))).toEqual({
      kind: "owned",
      ownerPid: 9,
      role: "handoff",
    });
  });

  it("classifies a pre-#275 bare-token file as legacy — it has no owner to probe", () => {
    expect(classifyHookInstallFileName("f81d4fae-7dec-11d0-a765-00a0c91e6bf6.settings.json")).toEqual({
      kind: "legacy",
      role: "settings",
    });
  });

  it("does NOT mistake an all-digit UUID first group for an owner PID — the `_` separator is why", () => {
    // The exact collision the separator choice exists to prevent: under a `-` separator this legacy
    // name would parse as owner PID 12345678, and the sweep would probe a PID that never wrote it.
    const allDigitFirstGroup = "12345678-1234-1234-1234-123456789abc.settings.json";

    expect(classifyHookInstallFileName(allDigitFirstGroup)).toEqual({ kind: "legacy", role: "settings" });
  });

  it("recognizes an interrupted atomic write's leftover temp file, owned and legacy alike", () => {
    expect(classifyHookInstallFileName("4242_tok.settings.json.991.abc123.tmp")).toEqual({
      kind: "owned",
      ownerPid: 4242,
      role: "settings",
    });
    expect(classifyHookInstallFileName("tok.handoff.json.991.abc123.tmp")).toEqual({
      kind: "legacy",
      role: "handoff",
    });
  });

  it("recognizes the HOOK's own interrupted atomic write — the second writer into this directory", () => {
    // `ask-user-question-hook.ts` § `writeHandoffFile` writes `.{randomBytes(8).toString("hex")}.tmp`.
    // It carries no owner stamp and cannot: the hook runs in the WORKER process, which knows only the
    // handoff path it was handed. Modelling only the daemon's temp form would strand these forever.
    expect(classifyHookInstallFileName(".d222468dab44feb1.tmp")).toEqual({ kind: "hook-temp" });
    expect(classifyHookInstallFileName(`.${"0".repeat(16)}.tmp`)).toEqual({ kind: "hook-temp" });
  });

  it("classifies anything neither writer produces as foreign", () => {
    for (const name of [
      "notes.txt",
      "sessions.json",
      "4242_tok.settings",
      "4242_tok.other.json",
      ".hidden",
      ".short.tmp", // too few hex chars to be the hook's form
      ".d222468dab44feb1.txt", // right stem, wrong extension
    ]) {
      expect(classifyHookInstallFileName(name)).toEqual({ kind: "foreign" });
    }
  });
});

describe("isProcessAlive", () => {
  it("reports this very process alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a non-process id dead rather than handing it to process.kill", () => {
    // 0 and negatives address process GROUPS in `kill(2)`; they are not PIDs and must never probe alive.
    for (const pid of [0, -1, -process.pid, 1.5, Number.NaN]) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });
});

describe("sweepOrphanedHookInstalls — the three reaped populations", () => {
  it("reaps an install whose owning daemon is gone (the #275 orphan class)", () => {
    const settings = writeFile(hookInstallFileName(DEAD_PID, "tok", "settings"));
    const handoff = writeFile(hookInstallFileName(DEAD_PID, "tok", "handoff"));

    expect(sweep(probeWithLive(LIVE_PID))).toEqual({ reaped: 2, retained: 0 });
    expect(existsSync(join(stateDir, settings))).toBe(false);
    expect(existsSync(join(stateDir, handoff))).toBe(false);
  });

  it("reaps our OWN pid's leftovers — a previous daemon that held this PID before us", () => {
    const stale = writeFile(hookInstallFileName(OWN_PID, "tok", "settings"));

    // Our own PID probes ALIVE (we are it) and is reaped anyway: the sweep runs before the listener
    // opens, so this process cannot yet have installed anything of its own to destroy.
    expect(sweep(probeWithLive(OWN_PID))).toEqual({ reaped: 1, retained: 0 });
    expect(existsSync(join(stateDir, stale))).toBe(false);
  });

  it("reaps an aged-out legacy file, and RETAINS a fresh one", () => {
    const now = Date.now();
    const aged = writeFile("aged-token.settings.json", now - LEGACY_HOOK_INSTALL_GRACE_MS - 60_000);
    const fresh = writeFile("fresh-token.settings.json", now - 60_000);

    expect(sweep(probeWithLive(), now)).toEqual({ reaped: 1, retained: 1 });
    expect(existsSync(join(stateDir, aged))).toBe(false);
    expect(existsSync(join(stateDir, fresh))).toBe(true);
  });

  it("reaps an aged-out HOOK temp file, and RETAINS one a worker may still be mid-write on", () => {
    // The worker is the process an operator actually Ctrl-Cs, so this is arguably the likelier
    // interrupted write of the two — and it has no owner to probe, hence the same age floor.
    const now = Date.now();
    const aged = writeFile(".aaaaaaaaaaaaaaaa.tmp", now - LEGACY_HOOK_INSTALL_GRACE_MS - 60_000);
    const fresh = writeFile(".bbbbbbbbbbbbbbbb.tmp", now - 60_000);

    expect(sweep(probeWithLive(), now)).toEqual({ reaped: 1, retained: 1 });
    expect(existsSync(join(stateDir, aged))).toBe(false);
    expect(existsSync(join(stateDir, fresh))).toBe(true);
  });
});

describe("sweepOrphanedHookInstalls — what it must never touch", () => {
  it("RETAINS an install owned by a live, concurrently-running daemon", () => {
    const live = writeFile(hookInstallFileName(LIVE_PID, "tok", "settings"));

    expect(sweep(probeWithLive(LIVE_PID))).toEqual({ reaped: 0, retained: 1 });
    expect(existsSync(join(stateDir, live))).toBe(true);
  });

  it("RETAINS a file it did not write — a foreign name is not this module's to delete", () => {
    const foreign = writeFile("operator-notes.txt");

    expect(sweep(probeWithLive())).toEqual({ reaped: 0, retained: 1 });
    expect(existsSync(join(stateDir, foreign))).toBe(true);
  });

  it("never descends into a subdirectory, even one named like an install", () => {
    const nested = join(stateDir, hookInstallFileName(DEAD_PID, "tok", "settings"));
    mkdirSync(nested);
    writeFileSync(join(nested, hookInstallFileName(DEAD_PID, "inner", "settings")), "{}");

    expect(sweep(probeWithLive())).toEqual({ reaped: 0, retained: 1 });
    expect(existsSync(nested)).toBe(true);
  });

  it("bounds the blast radius: a symlink out of the state dir never deletes its TARGET (AC3)", () => {
    // Credit where it is due — this passes because of the `Dirent.isFile()` filter (a symlink reports
    // `isSymbolicLink()`, so it never reaches the delete at all), NOT because of the `realpathSync`
    // guard, which a direct child can never trip. `unlinkWithinStateDir` is a second layer for a
    // future caller that iterates differently; see its docstring. Labelling this "the guard works"
    // would credit the wrong layer and leave the real one untested if it were ever removed.
    const outside = mkdtempSync(join(tmpdir(), "ccctl-hook-sweep-outside-"));
    const victim = join(outside, "precious.json");
    writeFileSync(victim, "do not delete");
    // A symlink NAMED like a dead-owner install — the sweep's most tempting candidate.
    symlinkSync(victim, join(stateDir, hookInstallFileName(DEAD_PID, "tok", "settings")));

    try {
      expect(sweep(probeWithLive())).toEqual({ reaped: 0, retained: 1 });
      expect(existsSync(victim)).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("do not delete");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("counts a delete it could not perform as RETAINED, never as reaped", () => {
    // The honest-accounting branch: an unwritable directory makes `unlink` fail, and the outcome must
    // report the file as still there rather than inflating `reaped` with a deletion that did not happen.
    // Skipped as root, where the permission bits do not bind.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const orphan = writeFile(hookInstallFileName(DEAD_PID, "tok", "settings"));
    chmodSync(stateDir, 0o500); // r-x: listable, not writable — `unlink` fails EACCES

    try {
      expect(sweep(probeWithLive())).toEqual({ reaped: 0, retained: 1 });
      expect(existsSync(join(stateDir, orphan))).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  it("is a no-op on a directory that does not exist yet — nothing has ever launched", () => {
    expect(sweepOrphanedHookInstalls({ stateDir: join(stateDir, "absent"), ownPid: OWN_PID })).toEqual({
      reaped: 0,
      retained: 0,
    });
  });
});

describe("sweepOrphanedHookInstalls — the race legs it closes by construction", () => {
  it("leaves a CONCURRENT daemon's just-installed files alone: they carry its live PID", () => {
    // The exact race #275's AC names — "avoid deleting a file a just-launched session is about to
    // install". A mid-launch daemon is alive by definition, so its fresh install is never a candidate.
    const concurrent = installAskUserQuestionHookSettings("fresh-token", stateDir, LIVE_PID);

    expect(sweep(probeWithLive(LIVE_PID))).toEqual({ reaped: 0, retained: 1 });
    expect(existsSync(concurrent.settingsPath)).toBe(true);
  });

  it("partitions a mixed directory in ONE pass — dead reaped, live untouched", () => {
    const deadSettings = writeFile(hookInstallFileName(DEAD_PID, "a", "settings"));
    const deadHandoff = writeFile(hookInstallFileName(DEAD_PID, "a", "handoff"));
    const liveSettings = writeFile(hookInstallFileName(LIVE_PID, "b", "settings"));
    const ownStale = writeFile(hookInstallFileName(OWN_PID, "c", "settings"));
    const foreign = writeFile("unrelated.log");

    expect(sweep(probeWithLive(LIVE_PID, OWN_PID))).toEqual({ reaped: 3, retained: 2 });
    expect(existsSync(join(stateDir, deadSettings))).toBe(false);
    expect(existsSync(join(stateDir, deadHandoff))).toBe(false);
    expect(existsSync(join(stateDir, ownStale))).toBe(false);
    expect(existsSync(join(stateDir, liveSettings))).toBe(true);
    expect(existsSync(join(stateDir, foreign))).toBe(true);
  });

  it("reaps a REAL install once its owner is gone — the installer and the sweep agree on the format", () => {
    // The end-to-end contract that matters: whatever `installAskUserQuestionHookSettings` writes, the
    // sweep must recognize. A format drift between the two would silently make the reaper a no-op.
    const install = installAskUserQuestionHookSettings("real-token", stateDir, DEAD_PID);
    expect(existsSync(install.settingsPath)).toBe(true);

    expect(sweep(probeWithLive(LIVE_PID))).toEqual({ reaped: 1, retained: 0 });
    expect(existsSync(install.settingsPath)).toBe(false);
  });
});
