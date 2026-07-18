// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The HOOK-INSTALL SWEEP (#275) — the startup reap that collects per-launch `AskUserQuestion` hook
 * files (`hook-settings-installer.ts`, #262) which no cleanup path can ever reach again. The
 * disk-hygiene sibling of the orphan-reaper (`session-reconcile.ts`, #34): that one reconciles
 * RECORDS against surfaces that outlived a daemon; this one reconciles FILES against the daemons
 * that wrote them. Both run before the listener opens; neither touches a live process.
 *
 * **Why anything leaks at all.** #262 cleans up an install on two paths — a graceful session close
 * (`session-close.ts`) and a failed launch (`ui-session-launch.ts` § `launchSession`'s catch). Both
 * read `ServerState.hookInstalls`, an **in-memory map**. A `SIGKILL`, an OOM kill, or a plain
 * restart erases it, so every file written by a launch that was still live at that moment becomes
 * permanently unreachable: no later daemon knows those files exist, let alone that they are safe to
 * delete. This is the first per-launch artifact class in the repo that can accumulate that way —
 * the session and device stores are keyed and reconciled against real state on load; these were not.
 *
 * **Why a naive "delete everything on start" is wrong.** The hook state directory is shared by every
 * daemon running as this user on this host (it is derived from `$XDG_STATE_HOME`, which is per-user,
 * not per-process). A second daemon starting while a first is serving would delete the first's LIVE
 * installs and silently break its `AskUserQuestion` enrichment. #275's AC names this directly and
 * refuses the naive sweep.
 *
 * **The ownership rule (ADR-008).** Each install is stamped with its installing daemon's PID in the
 * filename (`{ownerPid}_{token}.{settings,handoff}.json`), and the sweep reaps exactly three
 * populations:
 *
 *   1. **Files owned by a PID that is not alive** — their daemon is gone; nothing will ever clean
 *      them up. This is the orphan population #275 reports.
 *   2. **Files owned by OUR OWN pid** — a previous daemon that happened to hold this PID before us.
 *      Safe because this sweep runs BEFORE the listener opens, so the STARTING SERVER cannot yet have
 *      installed anything of its own to destroy. Note the scope: that is a guarantee about one
 *      `startServer` call, NOT about the process (see the PRECONDITION on
 *      {@link sweepOrphanedHookInstalls} — a second server started in the same process WOULD reap the
 *      first's live installs, since they share a PID).
 *   3. **Unowned files**, and only once older than {@link LEGACY_HOOK_INSTALL_GRACE_MS} — pre-#275
 *      installs (precisely the accumulated orphans this issue exists to clear) and the HOOK's own
 *      interrupted atomic writes (`.{16-hex}.tmp`), which cannot carry an owner because the hook runs
 *      in the worker process, not the daemon. The age floor is what keeps this branch race-safe; see
 *      {@link LEGACY_HOOK_INSTALL_GRACE_MS}.
 *
 * Everything else is RETAINED. A file owned by a live PID belongs to a concurrently-running daemon;
 * a file whose name this module does not recognize was not written by the installer and is not this
 * module's to delete.
 *
 * **The startup race is closed on both legs, by construction rather than by timing.** A
 * just-launched session's files carry the PID of the daemon that is launching it — which is alive
 * for as long as it is mid-launch — so a concurrent daemon's fresh install is never a candidate
 * (leg 1). And this daemon cannot race itself, because the sweep is sequenced ahead of the listener
 * (leg 2). Neither leg depends on a window being "narrow enough".
 *
 * **Fail closed, always.** Every uncertainty resolves to RETAIN: a PID that cannot be proven dead
 * (including `EPERM` — a live process owned by another user), an unreadable directory, a failed
 * `stat`, a name that does not parse. The cost of retaining a file that could have been deleted is
 * a few inert KB — exactly the pre-#275 status quo. The cost of deleting a file that is still in
 * use is a live session's broken enrichment. Those are not symmetric, and this module never treats
 * them as if they were.
 */

import { readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  HOOK_INSTALL_OWNER_SEPARATOR,
  resolveHookStateDir,
  type HookInstallFileKind,
} from "./hook-settings-installer.js";

/**
 * How old an UNOWNED (pre-#275) hook install file must be before the sweep will reap it — 24h.
 *
 * Legacy files carry no PID stamp, so the ownership rule that makes the sweep race-safe cannot be
 * applied to them: there is no way to ask whether the daemon that wrote one is still running. The
 * age floor substitutes for that missing signal. The only way reaping a legacy file could ever harm
 * anything is if a still-running PRE-#275 daemon installed it and is still using it — and such a
 * daemon installs its files at LAUNCH, so a file that has sat unmodified for a full day cannot be
 * one it just wrote. A day is far beyond any launch window while staying short enough that the
 * accumulated orphans actually get cleared.
 *
 * Even in the impossible-in-practice case where this is wrong, the blast radius is bounded to
 * enrichment: the hook is enrich-only (ADR-005), so losing its files degrades an `AskUserQuestion`
 * decoration and never the native block the operator actually depends on.
 */
export const LEGACY_HOOK_INSTALL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A READ-ONLY port answering "is the process with this PID still running?" — the sweep's ONLY input
 * for the live/dead decision, and deliberately the only process-shaped capability in this module's
 * types. There is no signal/kill handle anywhere here, so "the sweep never touches a live process"
 * is not a discipline to remember; it is a thing the code cannot do. Mirrors the shape (and the
 * intent) of `session-reconcile.ts` § `ProcessLivenessProbe`.
 */
export type ProcessAlivenessProbe = (pid: number) => boolean;

/**
 * The default {@link ProcessAlivenessProbe}: signal `0`, which performs the existence and permission
 * checks without delivering anything.
 *
 * `EPERM` means the process EXISTS but belongs to another user — alive, and emphatically not ours
 * to reason about, so it reads as alive. Every other error (`ESRCH`, chiefly) means no such process.
 * A non-positive or non-integer PID is not a real process id and is reported dead rather than handed
 * to `process.kill`, where `0` and negatives address process GROUPS.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a filename in the hook state directory turned out to be. */
export type HookInstallFileClass =
  /** `{ownerPid}_{token}.{kind}.json` — an install stamped with the daemon that wrote it (#275). */
  | { readonly kind: "owned"; readonly ownerPid: number; readonly role: HookInstallFileKind }
  /** `{token}.{kind}.json` — a pre-#275 install, with no owner to probe. */
  | { readonly kind: "legacy"; readonly role: HookInstallFileKind }
  /** `.{16-hex}.tmp` — the HOOK's own interrupted atomic write, which carries no owner either. */
  | { readonly kind: "hook-temp" }
  /** Not a name either writer produces — not this module's file, and never reaped. */
  | { readonly kind: "foreign" };

/**
 * The trailing form of an interrupted atomic write BY THE DAEMON: `hook-settings-installer.ts` §
 * `writeStateFileAtomic` writes `{finalName}.{pid}.{base36}.tmp` beside its target and renames it
 * into place, so a daemon killed between the two leaves this behind. Optional, so the same pattern
 * matches a settled file and its orphaned temp — and, because the daemon's temp keeps the full
 * `{ownerPid}_…` stem, such a temp is probed by owner exactly like the file it was becoming.
 */
const TEMP_WRITE_SUFFIX = String.raw`(?:\.\d+\.[0-9a-z]+\.tmp)?`;

/**
 * The HOOK's own interrupted atomic write — `ask-user-question-hook.ts` § `writeHandoffFile` writes
 * `.{randomBytes(8).toString("hex")}.tmp` (a leading dot, 16 hex chars) in the same directory before
 * renaming it onto the handoff path.
 *
 * **There are TWO writers into this directory, and only modelling one of them leaks.** This form
 * carries no owner stamp and cannot: the hook runs INSIDE THE WORKER, a different process from the
 * daemon, and knows only the handoff path it was handed — not who launched it. It is also arguably
 * the LIKELIER interrupted write of the two, because the worker is the process an operator actually
 * `Ctrl-C`s. So it is reaped on the same age floor as a legacy file, for the same reason: there is
 * no ownership signal to probe, and a temp file that has sat untouched for a day is not one any live
 * process is still mid-write on.
 */
const HOOK_TEMP_FILE_PATTERN = /^\.[0-9a-f]{16}\.tmp$/;

/**
 * {@link HOOK_INSTALL_OWNER_SEPARATOR} is interpolated RAW into the two patterns below (both as a
 * literal and inside a character class), so it must not be a regex metacharacter — `_` is not. This
 * asserts that at module load rather than letting a future change to the constant silently corrupt
 * both patterns into something that still compiles but classifies wrongly.
 */
if (/[\\^$.|?*+()[\]{}]/.test(HOOK_INSTALL_OWNER_SEPARATOR)) {
  throw new Error(
    `ccctl: HOOK_INSTALL_OWNER_SEPARATOR must not be a regex metacharacter (got \`${HOOK_INSTALL_OWNER_SEPARATOR}\`) — ` +
      "it is interpolated raw into the hook-install filename patterns",
  );
}

/** `{ownerPid}_{token}.{settings|handoff}.json`, plus an optional interrupted-write temp suffix. */
const OWNED_FILE_PATTERN = new RegExp(
  String.raw`^(\d+)${HOOK_INSTALL_OWNER_SEPARATOR}[^${HOOK_INSTALL_OWNER_SEPARATOR}/]+\.(settings|handoff)\.json${TEMP_WRITE_SUFFIX}$`,
);

/** Pre-#275 `{token}.{settings|handoff}.json` — no owner stamp, plus an optional temp suffix. */
const LEGACY_FILE_PATTERN = new RegExp(
  String.raw`^[^${HOOK_INSTALL_OWNER_SEPARATOR}/]+\.(settings|handoff)\.json${TEMP_WRITE_SUFFIX}$`,
);

/**
 * Classify one directory entry by NAME alone — the sweep's whole basis for deciding whether a file
 * is anyone's, and if so whose. Name-only is the point: the contents of a settings file are the
 * Claude Code CLI's to define, and a handoff file is written by the hook, not by the daemon, so
 * neither can be relied on to carry provenance. The filename is the one field the installer fully
 * controls, so it is where ownership lives.
 */
export function classifyHookInstallFileName(fileName: string): HookInstallFileClass {
  const owned = OWNED_FILE_PATTERN.exec(fileName);
  if (owned !== null) {
    // The capture is `\d+`, so this parses; a PID far beyond the platform's range still simply
    // probes as dead, which is the safe direction anyway.
    return { kind: "owned", ownerPid: Number(owned[1]), role: owned[2] as HookInstallFileKind };
  }
  const legacy = LEGACY_FILE_PATTERN.exec(fileName);
  if (legacy !== null) {
    return { kind: "legacy", role: legacy[1] as HookInstallFileKind };
  }
  if (HOOK_TEMP_FILE_PATTERN.test(fileName)) {
    return { kind: "hook-temp" };
  }
  return { kind: "foreign" };
}

/** What one sweep did. Counts only — the sweep has nothing else to report and no one to report it to. */
export interface HookInstallSweepOutcome {
  /** Files deleted: dead-owner orphans, our own previous PID's leftovers, and aged-out legacy installs. */
  readonly reaped: number;
  /**
   * Every directory entry NOT deleted — live-owner installs, fresh legacy files, unrecognized
   * ("foreign") names, entries that are not regular files (subdirectories, symlinks), and any delete
   * that failed. Deliberately "everything else the listing held" rather than "retained installs", so
   * `reaped + retained` always equals the entry count and neither number can quietly omit a
   * population.
   */
  readonly retained: number;
}

/** Everything the sweep touches the outside world through — all injectable, so the logic is testable without a daemon. */
export interface HookInstallSweepOptions {
  /** Where to sweep. Defaults to the real hook state directory. */
  readonly stateDir?: string;
  /** This daemon's PID — its own leftovers are always reapable (see the module doc, population 2). */
  readonly ownPid?: number;
  /** How liveness is decided. Defaults to {@link isProcessAlive}. */
  readonly isAlive?: ProcessAlivenessProbe;
  /** "Now", for the legacy age floor. Defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * Delete `fileName` from `stateDir`, but ONLY if it genuinely resolves to a file directly inside
 * that directory (#275 AC3) — the same `realpathSync.native` idiom `worker-channel.ts` §
 * `consumeHookHandoffQuestions` applies before READING a handoff file, applied here before deleting
 * one. Resolve both the entry and the directory, and require the entry's resolved parent to equal
 * the resolved directory; anything that escapes is refused, not deleted.
 *
 * **Be precise about what actually stops what, because the labels are easy to get wrong.** The
 * blast-radius bound is achieved TWICE OVER, and the guard is the second layer, not the first. What
 * stops a planted symlink is the caller's `Dirent.isFile()` filter (a symlink reports
 * `isSymbolicLink()`, never `isFile()`, so it never reaches this function at all) plus the fact that
 * `unlink(2)` removes a link rather than following it. Given both, the refusal branch below is in
 * fact UNREACHABLE from {@link sweepOrphanedHookInstalls}'s own iteration: a regular file that is a
 * direct child of `stateDir` always resolves back into it.
 *
 * It is kept anyway, deliberately. #275 AC3 asks for this specific idiom, and it makes the bound a
 * property of THIS function rather than of its caller's filtering — so a future caller that iterates
 * differently (following symlinks, descending a subdirectory) cannot silently widen the blast radius
 * of the one operation here that destroys anything. Two `realpath` calls per reaped file is a cheap
 * price for that. What it must NOT do is let a test claim the guard is what saved the day when the
 * `isFile()` filter is what actually did — see `hook-install-sweep.test.ts`, which credits each to
 * the layer that genuinely performs it.
 *
 * Returns whether the file was actually removed, so a refusal counts as retained rather than
 * silently inflating the reaped tally.
 */
function unlinkWithinStateDir(stateDir: string, fileName: string): boolean {
  const path = join(stateDir, fileName);
  let resolvedPath: string;
  let resolvedDir: string;
  try {
    resolvedPath = realpathSync.native(path);
    resolvedDir = realpathSync.native(stateDir);
  } catch {
    return false;
  }
  if (dirname(resolvedPath) !== resolvedDir) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Already gone (a concurrent daemon's own cleanup got there first), or not ours to remove.
    return false;
  }
}

/** Whether an UNOWNED file (pre-#275 install, or a hook temp) has sat unmodified past {@link LEGACY_HOOK_INSTALL_GRACE_MS}. */
function isUnownedFileAgedOut(stateDir: string, fileName: string, now: number): boolean {
  try {
    return now - statSync(join(stateDir, fileName)).mtimeMs >= LEGACY_HOOK_INSTALL_GRACE_MS;
  } catch {
    // Cannot age it → cannot justify deleting it.
    return false;
  }
}

/** Decide one classified entry's fate. Every branch that is not a proven orphan retains. */
function shouldReap(
  classified: HookInstallFileClass,
  fileName: string,
  options: Required<HookInstallSweepOptions>,
): boolean {
  switch (classified.kind) {
    case "owned":
      // Our own PID: a previous daemon that held it before us. We hold no installs yet (the sweep is
      // sequenced ahead of the listener), so there is nothing of ours to destroy.
      return classified.ownerPid === options.ownPid || !options.isAlive(classified.ownerPid);
    // Both unowned classes share one rule, because they share one problem: no owner to probe.
    case "legacy":
    case "hook-temp":
      return isUnownedFileAgedOut(options.stateDir, fileName, options.now);
    case "foreign":
      return false;
  }
}

/**
 * Sweep the hook state directory once, reaping only files that provably belong to no running daemon
 * (see the module doc for the three reaped populations and the two race legs they close).
 *
 * **PRECONDITION — the caller must hold no installs of its own.** Population 2 reaps `ownPid`'s files
 * unconditionally, which is safe only because `startServer` runs this in its prologue, before the
 * listener opens and therefore before any launch of its own could have installed anything. A caller
 * that installed a hook and THEN swept would delete its own live install. This is one reason the
 * function stays internal to the package (`index.ts` § the sweep's export note): the precondition is
 * `startServer`'s to guarantee, and it cannot be enforced from in here.
 *
 * Best-effort by contract: a missing directory (the ordinary case on a fresh install — nothing has
 * ever launched), an unreadable one, or an individual delete that fails are all NON-ERRORS. The
 * caller is a daemon starting up, and a few KB of stale state is never worth refusing to boot over.
 */
export function sweepOrphanedHookInstalls(options: HookInstallSweepOptions = {}): HookInstallSweepOutcome {
  const resolved = {
    stateDir: options.stateDir ?? resolveHookStateDir(),
    ownPid: options.ownPid ?? process.pid,
    isAlive: options.isAlive ?? isProcessAlive,
    now: options.now ?? Date.now(),
  };

  let entries;
  try {
    entries = readdirSync(resolved.stateDir, { withFileTypes: true });
  } catch {
    return { reaped: 0, retained: 0 };
  }

  let reaped = 0;
  let retained = 0;
  for (const entry of entries) {
    // Regular files only. A `Dirent` reports a symlink as `isSymbolicLink()`, so this alone excludes
    // one — and a subdirectory is never descended into, because the installer creates none and a
    // reaper that recurses is a reaper whose blast radius is no longer stated by its own directory.
    if (!entry.isFile() || !shouldReap(classifyHookInstallFileName(entry.name), entry.name, resolved)) {
      retained += 1;
      continue;
    }
    if (unlinkWithinStateDir(resolved.stateDir, entry.name)) {
      reaped += 1;
    } else {
      retained += 1;
    }
  }
  return { reaped, retained };
}
