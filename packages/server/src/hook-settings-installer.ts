// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The launch-time settings installer (#262, #78 Option A) — wires the `AskUserQuestion`
 * `PreToolUse` hook into ONE launched session, without touching the operator's own project
 * `.claude/settings.json`.
 *
 * **This is the repo's first hook and first settings installer.** No prior settings/hook
 * infrastructure exists anywhere in this codebase (confirmed by an exhaustive sweep before this
 * issue). Two established conventions are reused rather than invented fresh:
 *
 *   - The XDG *state* directory layout `session-store-file.ts` established
 *     (`$XDG_STATE_HOME/ccctl/`, falling back to `~/.local/state/ccctl/`), extended with a
 *     `hooks/` subdirectory — `0700`, matching {@link SESSION_STORE_DIR_MODE} /
 *     {@link DEVICE_STORE_DIR_MODE} — so a `0600` file inside it is not reachable through a
 *     traversable parent.
 *   - `--settings <file-or-json>` — a real, currently-shipping Claude Code CLI flag ("Path to a
 *     settings JSON file … to load additional settings from") — confirmed via `claude --help`
 *     against the locally-installed binary. Using it means this installer writes to a
 *     DAEMON-OWNED file, never into the operator's own project directory, and needs no change to
 *     {@link ISessionLauncher} or either launcher backend: it only ADDS a value {@link
 *     buildWorkerCommand} appends to argv when present.
 *
 * **Per-launch, not per-session.** The install happens BEFORE {@link ISessionLauncher.launch}
 * runs, using a fresh random token — NOT the eventual ccctl session id, which `launchSession`
 * (`ui-session-launch.ts`) mints only AFTER a launch succeeds, specifically so a FAILED launch
 * touches no session-registry state. Keying the install files by their own token means a failed
 * launch leaves at most a pair of harmless orphaned files (best-effort cleaned up by the caller),
 * never a half-registered session.
 *
 * **Ownership is in the filename, because the map is not durable (#275, ADR-008).** Both files an
 * install produces are named `{ownerPid}_{token}.{kind}.json`. The two cleanup paths that normally
 * remove them — a graceful close (`session-close.ts`) and a failed launch (below) — both read
 * `ServerState.hookInstalls`, an in-memory map a `SIGKILL`/OOM/restart erases outright, taking with
 * it any knowledge that these files exist. The PID stamp is what survives that: it lets a LATER
 * daemon's startup sweep (`hook-install-sweep.ts`) tell a dead daemon's leftovers from a
 * concurrently-running one's live installs, using nothing but a directory listing.
 *
 * **What the installed settings say, and don't.** The hook is enrich-only (ADR-005): it must
 * NEVER return `permissionDecision: "ask"` (that would stack a redundant prompt in front of the
 * native block), so nothing in this installed settings file grants it that power — the hook
 * SCRIPT itself (`ask-user-question-hook.ts`) always answers with an empty decision regardless of
 * what the settings say, and this installer only supplies the `matcher` + `command` wiring.
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCCTL_STATE_DIR, XDG_STATE_HOME_ENV } from "./session-store-file.js";

/** The subdirectory (under the ccctl state dir) holding per-launch hook settings + handoff files. */
export const HOOK_STATE_SUBDIR = "hooks";

/** Owner-only (`0700`) — the hook state directory's permission bits, matching {@link SESSION_STORE_DIR_MODE}. */
export const HOOK_STATE_DIR_MODE = 0o700;

/** Owner-read/write-only (`0600`) — every file this installer writes, forced regardless of umask. */
export const HOOK_STATE_FILE_MODE = 0o600;

/**
 * The separator between a hook install's OWNER PID and its token in the on-disk filename (#275,
 * ADR-008) — `_`, deliberately a character a `randomUUID()` token can never contain (`[0-9a-f-]`
 * only). That is what makes the prefix unambiguously parseable: a legacy pre-#275 file is named for
 * its bare token, and a UUID whose first group happens to be all digits (`12345678-…`) would be
 * indistinguishable from a PID prefix under a `-` separator. With `_`, "has an owner" and "is a
 * legacy orphan" are decidable from the name alone — which is exactly what
 * `hook-install-sweep.ts` has to decide, with nothing but a directory listing to go on.
 */
export const HOOK_INSTALL_OWNER_SEPARATOR = "_";

/** The two files one install produces, by role — `{ownerPid}_{token}.{kind}.json`. */
export type HookInstallFileKind = "settings" | "handoff";

/**
 * Compose one install file's name: `{ownerPid}_{token}.{kind}.json`. The SINGLE source of truth for
 * the on-disk naming, shared with `hook-install-sweep.ts` § `classifyHookInstallFileName` — the
 * writer and the reaper must agree on the format or the reaper either misses real orphans or, worse,
 * fails to recognize a LIVE daemon's file as owned.
 */
export function hookInstallFileName(ownerPid: number, token: string, kind: HookInstallFileKind): string {
  return `${String(ownerPid)}${HOOK_INSTALL_OWNER_SEPARATOR}${token}.${kind}.json`;
}

/**
 * Resolve the hook state directory: `$XDG_STATE_HOME/ccctl/hooks`, falling back to
 * `~/.local/state/ccctl/hooks` — the same XDG resolution `resolveSessionStorePath` uses (honoring
 * `$XDG_STATE_HOME` only when it is an ABSOLUTE path), sibling to the session/device store files
 * rather than nested under them, since these are per-launch artifacts with their own lifecycle
 * (deleted on consumption or launch failure), not a durable snapshot.
 */
export function resolveHookStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env[XDG_STATE_HOME_ENV]?.trim();
  const stateHome =
    configured !== undefined && configured !== "" && isAbsolute(configured)
      ? configured
      : join(home, ".local", "state");
  return join(stateHome, CCCTL_STATE_DIR, HOOK_STATE_SUBDIR);
}

/**
 * The compiled hook script's absolute path — resolved relative to THIS module's own compiled
 * location (`import.meta.url`), so it is correct wherever `@ccctl/server` is installed, and does
 * not depend on the daemon's cwd (which a launched session's own `cwd` may differ from).
 */
export function resolveHookScriptPath(): string {
  return fileURLToPath(new URL("./ask-user-question-hook.js", import.meta.url));
}

/**
 * Build the settings JSON object wiring the `AskUserQuestion` `PreToolUse` hook — pure, so the
 * exact shape is unit-testable without touching a filesystem. `matcher` scopes the hook to
 * `AskUserQuestion` only (Claude Code's own hook-matching, ahead of the hook script's OWN
 * defense-in-depth check on `tool_name`); `command` is an argv-safe string (no shell
 * interpolation of untrusted data — both path segments are daemon-generated, never
 * operator/worker-supplied text).
 */
export function buildAskUserQuestionHookSettings(
  hookScriptPath: string,
  handoffPath: string,
): {
  readonly hooks: {
    readonly PreToolUse: readonly {
      readonly matcher: string;
      readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
    }[];
  };
} {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [
            { type: "command", command: `node ${JSON.stringify(hookScriptPath)} ${JSON.stringify(handoffPath)}` },
          ],
        },
      ],
    },
  };
}

/** What one successful install produced: where the settings file landed, and where the hook will write its capture. */
export interface HookInstall {
  /** The `--settings <path>` argv value — a daemon-owned settings JSON file wiring the hook. */
  readonly settingsPath: string;
  /** Where the hook writes its captured `AskUserQuestion` payload — read once, then deleted, by `worker-channel.ts`. */
  readonly handoffPath: string;
}

/** Atomically write `content` to `path` at {@link HOOK_STATE_FILE_MODE}: temp-in-same-dir + forced chmod + rename. */
function writeStateFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tempPath, content, { mode: HOOK_STATE_FILE_MODE });
  chmodSync(tempPath, HOOK_STATE_FILE_MODE);
  renameSync(tempPath, path);
}

/**
 * Install the hook for ONE launch attempt: ensure the (0700) state directory exists, write a
 * settings file wiring the hook at a fresh-token path, and return both that settings path (for
 * `--settings`) and the handoff path the hook will write to (for later server-side correlation).
 *
 * **Both files are STAMPED with the installing daemon's PID** (`{ownPid}_{token}.…`, #275 / ADR-008).
 * That stamp is the ONLY durable record of who owns an install: {@link HookInstall} itself lives in
 * `ServerState.hookInstalls`, an in-memory map a `SIGKILL`/OOM/restart erases completely — after
 * which nothing on disk would say whether a given file belongs to a daemon that is still running or
 * to one that died mid-session. The stamp lets a starting daemon's sweep
 * (`hook-install-sweep.ts`) tell those apart from a directory listing alone, and is deliberately
 * written by the INSTALLER rather than tracked separately, so an install and its ownership record
 * cannot drift apart: they are the same `rename(2)`.
 *
 * Deliberately synchronous — this runs once, briefly, ahead of a launcher call that is already
 * about to shell out (tmux) or fork (pty); adding an async boundary here buys nothing and would
 * only complicate `launchSession`'s existing synchronous-until-the-launcher-call reservation
 * window (`ui-session-launch.ts` § `launchSession`).
 */
export function installAskUserQuestionHookSettings(
  token: string,
  stateDir: string = resolveHookStateDir(),
  ownPid: number = process.pid,
): HookInstall {
  mkdirSync(stateDir, { recursive: true, mode: HOOK_STATE_DIR_MODE });
  const settingsPath = join(stateDir, hookInstallFileName(ownPid, token, "settings"));
  const handoffPath = join(stateDir, hookInstallFileName(ownPid, token, "handoff"));
  const settings = buildAskUserQuestionHookSettings(resolveHookScriptPath(), handoffPath);
  writeStateFileAtomic(settingsPath, JSON.stringify(settings));
  return { settingsPath, handoffPath };
}

/**
 * Best-effort remove both files an install produced — used when a launch FAILS (so a failed
 * attempt leaves no orphaned state; `ui-session-launch.ts` § `launchSession`) and on session close
 * (`session-close.ts`) for a session whose handoff was never consumed. Swallows any error: a
 * leftover few-KB file is inert clutter, never worth failing an unrelated caller over.
 */
export function cleanupHookInstall(install: HookInstall): void {
  for (const path of [install.settingsPath, install.handoffPath]) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or never written (e.g. the hook never fired) — either way, nothing to report.
    }
  }
}
