// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The node-pty ARMING PREFLIGHT (#235) — `pnpm --filter @ccctl/e2e arm:pty`.
 *
 * Probes THIS box for a spawn-capable `node-pty` and prints the lever it actually needs. It is the
 * executable half of #235's remedy, and the reason the package README can be a POINTER rather than a
 * fifth copy of the arming chain: the README used to carry a `sh` runbook whose comments restated
 * the causal account, so the prose and the reality could drift apart silently — and did, three
 * times. A script cannot: it reads the real mode bit off the real file.
 *
 * **This file deliberately does NOT restate WHY.** That account has exactly one home —
 * {@link CANONICAL_HOME}'s module doc — and `pty-chain-census.ts` enforces it. What lives here is the
 * OBSERVATION (what is true on this box now) and the LEVER (what to type). It names the helper only to
 * stat it, which is why the census exempts it (`pty-chain-census.ts` § `EXEMPT_FILES`).
 *
 * **Why it probes rather than trusts `process.platform` alone**: the useful question is not "which
 * OS is this" but "can this checkout spawn", and only the filesystem knows. On darwin the answer is
 * a mode bit; on Linux it is whether a compiled binding exists at all. Both are read, never assumed.
 */

import { constants, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CANONICAL_HOME } from "./pty-chain-census.js";

/** Where node-pty's own resolver looks, in its own order — the two that imply a usable binding. */
const BUILD_DIRS = ["build/Release", "build/Debug"] as const;

/** What the preflight found. A verdict about THIS box, never a claim about the mechanism. */
export type ArmingState =
  /** node-pty is not installed / not resolvable — nothing to arm yet. */
  | { readonly kind: "not-installed" }
  /**
   * A binding is present and holds nothing to arm — a compiled build, or a prebuild that ships no
   * helper. The PATH says which; this probe read a directory, it did not watch anything get built.
   */
  | { readonly kind: "binding-present"; readonly binding: string }
  /** darwin, prebuild present, helper is executable. Armed. */
  | { readonly kind: "armed"; readonly helper: string; readonly mode: number }
  /** darwin, prebuild present, helper is not executable. One chmod away. */
  | { readonly kind: "helper-not-executable"; readonly helper: string; readonly mode: number }
  /** No prebuild for this platform and no compiled binding — the Linux default-checkout shape. */
  | { readonly kind: "no-binding"; readonly platform: string; readonly prebuildsSeen: readonly string[] };

/** The filesystem seam, so every branch above is unit-provable on one box. */
export interface ArmingProbeIo {
  readonly platform: string;
  readonly arch: string;
  /** node-pty's package root, or undefined when it does not resolve. */
  readonly packageRoot: () => string | undefined;
  /** Mode bits of `path`, or undefined when it does not exist. */
  readonly modeOf: (path: string) => number | undefined;
  /** Whether `path` is an existing directory. */
  readonly isDir: (path: string) => boolean;
  /** Directory entries of `path`, or [] when unreadable. */
  readonly entriesOf: (path: string) => readonly string[];
}

/** node-pty names its prebuild dirs `<platform>-<arch>`; darwin's x64 build is not `x86_64`. */
export function prebuildDirName(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Is the owner-execute bit set? That single bit is the difference between armed and not. */
export function isExecutable(mode: number): boolean {
  return (mode & constants.S_IXUSR) !== 0;
}

/**
 * Read this box's arming state. Pure with respect to {@link ArmingProbeIo}, so every verdict —
 * including the Linux ones, which cannot be produced on a darwin CI box — is unit-provable.
 */
export function probeArmingState(io: ArmingProbeIo): ArmingState {
  const root = io.packageRoot();
  if (root === undefined) return { kind: "not-installed" };

  // node-pty's resolver prefers a compiled binding over any prebuild, so a built checkout is armed
  // regardless of what the prebuilds dir holds.
  for (const dir of BUILD_DIRS) {
    const candidate = join(root, dir);
    if (io.isDir(candidate)) return { kind: "binding-present", binding: candidate };
  }

  const prebuilds = join(root, "prebuilds");
  const mine = join(prebuilds, prebuildDirName(io.platform, io.arch));
  if (!io.isDir(mine)) {
    return { kind: "no-binding", platform: io.platform, prebuildsSeen: io.entriesOf(prebuilds) };
  }

  // A prebuild exists. On darwin the helper's mode bit decides; elsewhere a present prebuild is
  // loadable and there is no helper to arm.
  const helper = join(mine, "spawn-helper");
  const mode = io.modeOf(helper);
  if (mode === undefined) return { kind: "binding-present", binding: mine };

  return isExecutable(mode) ? { kind: "armed", helper, mode } : { kind: "helper-not-executable", helper, mode };
}

/** A preflight report: what is true, what to do about it, and whether the box is ready. */
export interface ArmingReport {
  readonly armed: boolean;
  readonly lines: readonly string[];
}

/**
 * Where the report points for WHY. Composed from the census's {@link CANONICAL_HOME} rather than
 * spelled out again: this pointer and the gate that enforces it must name the same file, and a second
 * copy of that path is free to rot the moment the account moves — which is #235's whole subject.
 */
const CANONICAL_REF = `${CANONICAL_HOME} (module doc) — the single account of WHY`;
const RUN_LINE = "Then: CCCTL_E2E=1 CCCTL_E2E_PTY=1 pnpm --filter @ccctl/e2e test:e2e";

/** Render a state as the operator-facing report. Pure — the print seam stays in {@link runArmingPreflight}. */
export function formatArmingReport(state: ArmingState): ArmingReport {
  switch (state.kind) {
    case "armed":
      return {
        armed: true,
        lines: [
          "ARMED — node-pty can spawn on this box.",
          `  helper: ${state.helper}`,
          `  mode:   ${modeString(state.mode)} (executable)`,
          "",
          RUN_LINE,
        ],
      };

    case "binding-present":
      return {
        armed: true,
        lines: [
          "ARMED — a node-pty binding is present, with nothing to arm.",
          `  binding: ${state.binding}`,
          "",
          RUN_LINE,
        ],
      };

    case "helper-not-executable":
      return {
        armed: false,
        lines: [
          "NOT ARMED — the prebuilt helper is present but not executable.",
          `  helper: ${state.helper}`,
          `  mode:   ${modeString(state.mode)} (needs the owner-execute bit)`,
          "",
          "Lever — run this, then re-run the preflight:",
          `  chmod +x '${state.helper}'`,
          "",
          "Note: pnpm install re-extracts this file, so re-apply after every reinstall.",
          "",
          RUN_LINE,
          "",
          `Why: ${CANONICAL_REF}`,
        ],
      };

    case "no-binding":
      return {
        armed: false,
        lines: [
          `NOT ARMED — no node-pty binding for ${state.platform}: no compiled build, and no prebuild ships for it.`,
          state.prebuildsSeen.length > 0
            ? `  prebuilds shipped: ${state.prebuildsSeen.join(", ")}`
            : "  prebuilds shipped: (none found)",
          "",
          "Lever — build it from source, then re-run the preflight:",
          "  1. set `node-pty: true` under `allowBuilds` in pnpm-workspace.yaml",
          "  2. pnpm install",
          "",
          RUN_LINE,
          "",
          `Why: ${CANONICAL_REF}`,
        ],
      };

    case "not-installed":
      return {
        armed: false,
        lines: [
          "NOT ARMED — node-pty does not resolve from here.",
          "",
          "Lever:",
          "  pnpm install",
          "",
          `Why: ${CANONICAL_REF}`,
        ],
      };
  }
}

/** Mode as the octal an operator recognises from `ls -l`. */
function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/** The real filesystem. Every failure is absence — a probe must never throw on a missing path. */
export const realProbeIo: ArmingProbeIo = {
  platform: process.platform,
  arch: process.arch,
  packageRoot: () => {
    try {
      // Resolve the MANIFEST, never the binding: a default checkout cannot load the binding, which
      // is the very thing this preflight exists to report — importing it here would throw on
      // exactly the boxes that need the answer most.
      //
      // `@ccctl/e2e` declares node-pty itself, at the same range `@ccctl/server` does, so this
      // resolves through a DECLARED dependency. It previously resolved only through pnpm's hoisted
      // store — an accident of the runner's looser resolver, which would report "not installed" on
      // a fully-armed box under a stricter one. The copy it finds must be the copy the daemon's
      // launcher loads: pnpm dedupes them to one physical dir, and `arm-pty.test.ts` ASSERTS that
      // rather than trusting it, because the two ranges drifting apart is a silent, lockfile-only
      // event that would leave this probing the wrong install.
      const require = createRequire(import.meta.url);
      return dirname(require.resolve("node-pty/package.json"));
    } catch {
      return undefined;
    }
  },
  modeOf: (path) => {
    try {
      return statSync(path).mode;
    } catch {
      return undefined;
    }
  },
  isDir: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  entriesOf: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/**
 * Probe, print, and return the exit code — non-zero when this box cannot spawn, so a script can gate
 * on it. Named for what it is rather than `main`: this module is re-exported from the package index,
 * and `main` would squat a very generic name on `@ccctl/e2e`'s public surface.
 */
export function runArmingPreflight(io: ArmingProbeIo = realProbeIo): number {
  const report = formatArmingReport(probeArmingState(io));
  console.log(report.lines.join("\n"));
  return report.armed ? 0 : 1;
}

// Run only when invoked directly, never on import — the tests and the package index import this.
// `pathToFileURL` rather than a `file://` template: import.meta.url is percent-ENCODED, so the naive
// concatenation mis-compares under any checkout path holding a space (`/My Repos/…` → `/My%20Repos/…`)
// and the preflight would silently print nothing and exit 0 — a green on a box it never probed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runArmingPreflight();
}
