// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  formatArmingReport,
  isExecutable,
  prebuildDirName,
  probeArmingState,
  realProbeIo,
  type ArmingProbeIo,
} from "./arm-pty.js";
import { CANONICAL_HOME } from "./pty-chain-census.js";

// The #235 arming PREFLIGHT, proven credential-free. Every verdict is driven through the injected
// {@link ArmingProbeIo}, which is what makes the LINUX legs provable on a darwin box (and vice
// versa) — the platform is an input here, not an ambient fact. That matters more than usual: the
// Linux leg of the arming chain is explicitly UNVERIFIED end-to-end (no Linux box was available),
// so the least this package can do is prove the preflight BRANCHES correctly for it.
//
// What these tests do NOT claim: that the printed lever WORKS. `chmod +x` fixing a darwin box is the
// canonical account's claim, not the preflight's — the preflight only reports what it read and which
// lever the state implies. The distinction is the whole reason the script exists: it OBSERVES rather
// than asserts.

const NODE_PTY_ROOT = "/repo/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty";

/** A probe io with nothing present; each test adds only what its own leg needs. */
function io(overrides: Partial<ArmingProbeIo> = {}): ArmingProbeIo {
  return {
    platform: "darwin",
    arch: "arm64",
    packageRoot: () => NODE_PTY_ROOT,
    modeOf: () => undefined,
    isDir: () => false,
    entriesOf: () => [],
    ...overrides,
  };
}

describe("prebuildDirName", () => {
  it("joins platform and arch the way node-pty names its prebuild dirs", () => {
    expect(prebuildDirName("darwin", "arm64")).toBe("darwin-arm64");
    expect(prebuildDirName("darwin", "x64")).toBe("darwin-x64");
  });

  it("uses node's `x64`, not uname's `x86_64` — the rename the old shell runbook had to sed", () => {
    // The README's runbook carried `sed 's/^x86_64$/x64/'`; process.arch already reports `x64`, so
    // the translation the operator used to perform by hand is not a step here at all.
    expect(prebuildDirName("darwin", process.arch)).not.toContain("x86_64");
  });
});

describe("isExecutable", () => {
  it("reads the owner-execute bit, which is the whole darwin question", () => {
    expect(isExecutable(0o644)).toBe(false);
    expect(isExecutable(0o755)).toBe(true);
  });

  it("is not fooled by the group/other execute bits alone", () => {
    // 0o611: owner rw-, group --x, other --x. posix_spawn runs as the owner; the owner bit decides.
    expect(isExecutable(0o611)).toBe(false);
  });
});

describe("probeArmingState", () => {
  it("is NOT-INSTALLED when node-pty does not resolve", () => {
    expect(probeArmingState(io({ packageRoot: () => undefined }))).toEqual({ kind: "not-installed" });
  });

  it("is HELPER-NOT-EXECUTABLE on the real darwin default checkout: prebuild present, mode 644", () => {
    // The empirically-verified shape on this repo's own install (`-rw-r--r--`).
    const helper = `${NODE_PTY_ROOT}/prebuilds/darwin-arm64/spawn-helper`;
    const state = probeArmingState(
      io({
        isDir: (p) => p === `${NODE_PTY_ROOT}/prebuilds/darwin-arm64`,
        modeOf: (p) => (p === helper ? 0o100644 : undefined),
      }),
    );
    expect(state).toEqual({ kind: "helper-not-executable", helper, mode: 0o100644 });
  });

  it("is ARMED once that same helper carries the execute bit", () => {
    const helper = `${NODE_PTY_ROOT}/prebuilds/darwin-arm64/spawn-helper`;
    const state = probeArmingState(
      io({
        isDir: (p) => p === `${NODE_PTY_ROOT}/prebuilds/darwin-arm64`,
        modeOf: (p) => (p === helper ? 0o100755 : undefined),
      }),
    );
    expect(state).toMatchObject({ kind: "armed", helper });
  });

  it("is NO-BINDING on the linux default checkout, and names what DID ship", () => {
    // The Linux leg: no prebuild for the platform and no compiled build. Provable here only because
    // the platform is injected.
    const state = probeArmingState(
      io({
        platform: "linux",
        arch: "x64",
        isDir: () => false,
        entriesOf: (p) => (p === `${NODE_PTY_ROOT}/prebuilds` ? ["darwin-arm64", "darwin-x64", "win32-x64"] : []),
      }),
    );
    expect(state).toEqual({
      kind: "no-binding",
      platform: "linux",
      prebuildsSeen: ["darwin-arm64", "darwin-x64", "win32-x64"],
    });
  });

  it("is BINDING-PRESENT when a compiled build exists — which node-pty's resolver prefers", () => {
    // The armed-Linux shape: allowBuilds flipped, node-gyp ran, build/Release exists.
    const state = probeArmingState(
      io({ platform: "linux", arch: "x64", isDir: (p) => p === `${NODE_PTY_ROOT}/build/Release` }),
    );
    expect(state).toEqual({ kind: "binding-present", binding: `${NODE_PTY_ROOT}/build/Release` });
  });

  it("prefers a compiled build over an unarmed prebuild — resolver order, not directory order", () => {
    // Both present, helper still 644: the build dir wins, so the box IS armed. Reporting
    // "not executable" here would send an operator chmod'ing a file nothing loads.
    const state = probeArmingState(
      io({
        isDir: (p) => p === `${NODE_PTY_ROOT}/build/Release` || p === `${NODE_PTY_ROOT}/prebuilds/darwin-arm64`,
        modeOf: () => 0o100644,
      }),
    );
    expect(state).toEqual({ kind: "binding-present", binding: `${NODE_PTY_ROOT}/build/Release` });
  });

  it("checks build/Debug too — node-pty's resolver falls back to it before any prebuild", () => {
    const state = probeArmingState(io({ isDir: (p) => p === `${NODE_PTY_ROOT}/build/Debug` }));
    expect(state).toEqual({ kind: "binding-present", binding: `${NODE_PTY_ROOT}/build/Debug` });
  });

  it("treats a prebuild with no helper as a present binding — win32 ships no spawn-helper", () => {
    // `binding-present` reports the PREBUILD dir here, not a build dir: the probe read a directory,
    // and calling this one `built-from-source` would tell a win32 operator it was compiled.
    const state = probeArmingState(
      io({ platform: "win32", arch: "x64", isDir: (p) => p === `${NODE_PTY_ROOT}/prebuilds/win32-x64` }),
    );
    expect(state).toEqual({ kind: "binding-present", binding: `${NODE_PTY_ROOT}/prebuilds/win32-x64` });
  });
});

describe("formatArmingReport", () => {
  it("prints the exact chmod for the real path, and the reinstall caveat", () => {
    const helper = `${NODE_PTY_ROOT}/prebuilds/darwin-arm64/spawn-helper`;
    const report = formatArmingReport({ kind: "helper-not-executable", helper, mode: 0o100644 });
    expect(report.armed).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain(`chmod +x '${helper}'`);
    expect(text).toContain("0644");
    expect(text).toContain("re-extracts");
  });

  it("prints the allowBuilds lever for a box with no binding", () => {
    const report = formatArmingReport({ kind: "no-binding", platform: "linux", prebuildsSeen: ["darwin-arm64"] });
    expect(report.armed).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain("allowBuilds");
    expect(text).toContain("pnpm install");
    expect(text).toContain("darwin-arm64");
  });

  it("reports armed states as armed, and offers no lever for them", () => {
    for (const state of [
      { kind: "armed", helper: "/x/spawn-helper", mode: 0o100755 },
      { kind: "binding-present", binding: "/x/build/Release" },
    ] as const) {
      const report = formatArmingReport(state);
      expect(report.armed).toBe(true);
      expect(report.lines.join("\n")).not.toContain("Lever");
    }
  });

  it("names a present binding by its PATH rather than calling it compiled — win32's is a prebuild", () => {
    // The state covers a compiled build AND a shipped prebuild, so the wording must be true of both.
    const text = formatArmingReport({ kind: "binding-present", binding: "/x/prebuilds/win32-x64" }).lines.join("\n");
    expect(text).toContain("/x/prebuilds/win32-x64");
    expect(text).not.toContain("compiled");
  });

  it("every state prints the run command, so the report is never a dead end", () => {
    for (const state of [
      { kind: "armed", helper: "/x/spawn-helper", mode: 0o100755 },
      { kind: "binding-present", binding: "/x/build/Release" },
      { kind: "helper-not-executable", helper: "/x/spawn-helper", mode: 0o100644 },
      { kind: "no-binding", platform: "linux", prebuildsSeen: [] },
    ] as const) {
      expect(formatArmingReport(state).lines.join("\n")).toContain("CCCTL_E2E_PTY=1");
    }
  });

  it("points at the canonical account rather than restating it — the #235 contract", () => {
    // CANONICAL_HOME, not a literal: the pointer and the gate must name the same file, and this test
    // is what proves the report tracks a move rather than rotting into a stale path.
    const report = formatArmingReport({ kind: "helper-not-executable", helper: "/x/spawn-helper", mode: 0o100644 });
    expect(report.lines.join("\n")).toContain(CANONICAL_HOME);
  });

  it("renders the mode as the octal an operator reads out of `ls -l`", () => {
    // statSync reports 0o100644 (S_IFREG | 0644); an operator sees `-rw-r--r--` and thinks "644".
    expect(
      formatArmingReport({ kind: "helper-not-executable", helper: "/x", mode: 0o100644 }).lines.join("\n"),
    ).toContain("0644");
  });
});

describe("realProbeIo — the impure seam, on this actual box", () => {
  it("reports this box's real platform and arch", () => {
    expect(realProbeIo.platform).toBe(process.platform);
    expect(realProbeIo.arch).toBe(process.arch);
  });

  it("never throws on absent paths — a probe reports absence, it does not crash", () => {
    expect(realProbeIo.modeOf("/definitely/not/here")).toBeUndefined();
    expect(realProbeIo.isDir("/definitely/not/here")).toBe(false);
    expect(realProbeIo.entriesOf("/definitely/not/here")).toEqual([]);
  });

  it("probes the SAME physical node-pty the daemon's launcher will load", () => {
    // The preflight answers "can THIS box spawn a pty for #68's oracle?", and that oracle drives
    // @ccctl/server's launcher — so a verdict about any OTHER install is a wrong answer wearing a
    // right one. Both packages declare node-pty at the same range and pnpm dedupes them to one
    // physical dir; this asserts that rather than trusting it, because the two ranges drifting
    // apart is a silent, lockfile-only event that would leave the preflight probing e2e's copy
    // while the daemon loads the server's.
    const probed = realProbeIo.packageRoot();
    expect(probed).toBeDefined();
    // Rooted at the server's manifest PATH, not `require.resolve("@ccctl/server/package.json")` —
    // the server's `exports` map does not expose its manifest, so a specifier resolve throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. A path-rooted require answers what the server itself would.
    const serverManifest = join(import.meta.dirname, "../../server/package.json");
    const serverCopy = createRequire(serverManifest).resolve("node-pty/package.json");
    expect(probed === undefined ? undefined : realpathSync(probed)).toBe(realpathSync(dirname(serverCopy)));
  });

  it("resolves node-pty's package root without loading its native binding", () => {
    // The load is exactly what a default checkout cannot do; resolving the manifest must not need it.
    const root = realProbeIo.packageRoot();
    expect(root).toBeDefined();
    expect(root).toContain("node-pty");
  });

  it("agrees with the real filesystem about this checkout's arming state", () => {
    // The end-to-end check that the seam is wired to reality: whatever this box is, the verdict must
    // be one of the modelled states and must be self-consistent with a fresh stat of the helper.
    const state = probeArmingState(realProbeIo);
    expect(["armed", "helper-not-executable", "binding-present", "no-binding", "not-installed"]).toContain(state.kind);
    if (state.kind === "helper-not-executable" || state.kind === "armed") {
      const freshMode = realProbeIo.modeOf(state.helper);
      expect(freshMode, "the helper the probe just read must still be there").toBeDefined();
      expect(freshMode === undefined ? undefined : isExecutable(freshMode)).toBe(state.kind === "armed");
    }
  });
});
