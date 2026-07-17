// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_HOME,
  CHAIN_TOKENS,
  EXEMPT_FILES,
  formatCensusFindings,
  PROXIMITY_WINDOW_LINES,
  scanForChainRestatement,
  type CensusSubject,
} from "./pty-chain-census.js";

// The #235 ARMING-CHAIN CENSUS gate. Two halves, and the second is the one that matters:
//
//   1. The PREDICATE, unit-proven over synthetic files — that it fires on every token, that the
//      ambiguous ones need their companion NEAR, that exemptions are scoped as narrowly as they
//      claim to be.
//   2. The REPO ASSERTION — the census run against every tracked file, which is the executable
//      encoding of #235's AC. This is a gate, not a report: a fourth copy of the chain turns the
//      suite red in the credential-free `test` lane, on every box, with no pty and no fenced env.
//
// It lives in the plain `test` lane deliberately. The chain it polices is about a fenced oracle, but
// policing the DOC CENSUS needs no node-pty at all — only the repo. Fencing this behind CCCTL_E2E_PTY
// would arm the gate exactly where it never runs (CI included), which is the failure mode #235 is
// about: an unenforced intention.
//
// `git ls-files` is the census's SUBJECT LIST, and the choice is load-bearing: node_modules holds
// node-pty ITSELF (every token, by definition) and a filesystem walk would drown in it. Tracked
// files are also exactly the right scope — the gate polices what the repo SAYS, and `pnpm-workspace.yaml`
// (outside packages/e2e, the file a Linux operator actually edits, and the copy dropped from #68's
// tally TWICE) is tracked.

/** Repo root, so the census's paths are repo-relative and match EXEMPT_FILES exactly. */
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();

/** Every tracked file, as census subjects. NUL-delimited so paths with spaces survive. */
function trackedSubjects(): CensusSubject[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  const paths = listing.split("\0").filter((path) => path.length > 0);

  const subjects: CensusSubject[] = [];
  for (const path of paths) {
    let contents: string;
    try {
      contents = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      // A tracked path that cannot be read as text (binary, or a submodule/symlink gap) cannot
      // restate the chain in prose. Skipping it is safe; failing on it would make the gate flaky.
      continue;
    }
    // A NUL byte means binary — same reasoning.
    if (contents.includes("\0")) continue;
    subjects.push({ path, contents });
  }
  return subjects;
}

describe("#235 arming-chain census — the REPO assertion (the AC)", () => {
  const subjects = trackedSubjects();

  it("scans a non-trivial, real subject list — a census of nothing would pass vacuously", () => {
    // The gate's own degenerate-subject guard: `git ls-files` returning empty (wrong cwd, no git)
    // would make every assertion below pass while checking NOTHING.
    expect(subjects.length).toBeGreaterThan(50);
    expect(subjects.map((s) => s.path)).toContain(CANONICAL_HOME);
    // The copy #68's tally dropped twice, and the reason #235 names it explicitly: it is outside
    // packages/e2e, so any gate scoped to the package would miss it.
    expect(subjects.map((s) => s.path)).toContain("pnpm-workspace.yaml");
  });

  it("finds the chain restated NOWHERE outside its canonical home", () => {
    const findings = scanForChainRestatement(subjects);
    // The report, not a bare count: a failure here must name every site and how to resolve it.
    expect(findings, formatCensusFindings(findings)).toEqual([]);
  });

  it("proves the canonical home still HAS the account it is canonical for", () => {
    // The census only bans tokens elsewhere; without this, deleting the canonical account entirely
    // would make the suite greener. The chain must live SOMEWHERE, and this is where.
    const canonical = subjects.find((s) => s.path === CANONICAL_HOME);
    if (canonical === undefined) throw new Error(`canonical home is not a tracked file: ${CANONICAL_HOME}`);
    const unambiguous = CHAIN_TOKENS.filter((t) => t.onlyWith === undefined);
    for (const token of unambiguous) {
      expect.soft(canonical.contents.toLowerCase()).toContain(token.token.toLowerCase());
    }
  });

  it("pins every exempt path to a file that actually exists", () => {
    // A stale exemption is a silent hole: it exempts nothing and hides that it is doing so.
    const tracked = new Set(subjects.map((s) => s.path));
    for (const exempt of EXEMPT_FILES) {
      expect.soft(tracked, `exempt path is not a tracked file: ${exempt.path}`).toContain(exempt.path);
    }
  });

  it("pins the exempt set itself — a NEW home must be a reviewed act, not a quiet edit", () => {
    // The canonical account, plus the tooling that enforces it and the tooling that executes it.
    // Exactly one of these STATES the chain; in the rest the tokens are code, not prose.
    expect(EXEMPT_FILES.map((e) => e.path)).toEqual([
      CANONICAL_HOME,
      "packages/e2e/src/pty-chain-census.ts",
      "packages/e2e/src/pty-chain-census.test.ts",
      "packages/e2e/src/arm-pty.ts",
      "packages/e2e/src/arm-pty.test.ts",
    ]);
    // Each exemption must carry its reason — that is what makes adding one reviewable.
    for (const exempt of EXEMPT_FILES) {
      expect.soft(exempt.why.length).toBeGreaterThan(20);
    }
  });
});

describe("#235 arming-chain census — the predicate", () => {
  // Built from the exported token set rather than literals, so a token added to CHAIN_TOKENS gets
  // its firing test for free and cannot be added without one.
  it.each(CHAIN_TOKENS.map((token) => [token.token, token] as const))(
    "fires on `%s` restated outside the canonical home",
    (_name, token) => {
      // The companion sits on the same line for ambiguous tokens — as every real restatement does.
      const contents = `prose about ${token.token} ${token.onlyWith ?? ""} prose`;
      const findings = scanForChainRestatement([{ path: "docs/some-new-file.md", contents }]);
      expect(findings.map((f) => f.token)).toContain(token.token);
    },
  );

  it("stays silent on the canonical home, which is the one file that must carry every token", () => {
    const contents = CHAIN_TOKENS.map((t) => `${t.token} ${t.onlyWith ?? ""}`).join("\n");
    expect(scanForChainRestatement([{ path: CANONICAL_HOME, contents }])).toEqual([]);
  });

  it("reports the site precisely enough to fix: path, 1-based line, token, and the line itself", () => {
    const findings = scanForChainRestatement([
      { path: "docs/x.md", contents: "clean\nclean\nthe spawn-helper is the thing\nclean" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "docs/x.md",
      line: 3,
      token: "spawn-helper",
      text: "the spawn-helper is the thing",
      // Every finding carries WHY that token is the chain's fingerprint — a bare hit is not fixable.
      why: expect.stringContaining("darwin"),
    });
  });

  it("matches case-insensitively — a restatement is not laundered by capitalisation", () => {
    const findings = scanForChainRestatement([{ path: "docs/x.md", contents: "The SPAWN-Helper binary" }]);
    expect(findings.map((f) => f.token)).toContain("spawn-helper");
  });

  describe("ambiguous tokens need their companion NEAR, not merely somewhere in the file", () => {
    it("does NOT fire on a bare POSIX mode — the real `0o644` fixtures in @ccctl/server", () => {
      const contents = `await writeFile(filePath, "stale", { mode: 0o644 });\nexpect(await fileMode(filePath)).toBe(0o644);`;
      expect(scanForChainRestatement([{ path: "packages/server/src/session-store-file.test.ts", contents }])).toEqual(
        [],
      );
    });

    it("does NOT fire when the companion is far away — the real session-launcher-tmux.test.ts shape", () => {
      // Its `node-pty` comparison comment sits ~500 lines from an unrelated `0o644` fixture. This is
      // the exact false positive that a file-wide co-occurrence rule produces.
      const lines = Array.from({ length: 600 }, (_, i) => {
        if (i === 10) return "// a tmux launcher needs no node-pty and no platform-specific script";
        if (i === 510) return `writeFileSync(path, "#!/bin/sh\\n", { mode: 0o644 });`;
        return "// filler";
      });
      expect(
        scanForChainRestatement([
          { path: "packages/server/src/session-launcher-tmux.test.ts", contents: lines.join("\n") },
        ]),
      ).toEqual([]);
    });

    it("DOES fire when the companion is within the window — which is where a restatement puts it", () => {
      const contents = "the shipped helper is mode 644 and no node-pty script chmods it";
      const findings = scanForChainRestatement([{ path: "docs/x.md", contents }]);
      expect(findings.map((f) => f.token)).toContain("644");
    });

    it("respects the window's edges exactly", () => {
      const atEdge = ["node-pty", ...Array.from({ length: PROXIMITY_WINDOW_LINES - 1 }, () => "filler"), "mode 644"];
      expect(
        scanForChainRestatement([{ path: "docs/x.md", contents: atEdge.join("\n") }]).map((f) => f.token),
      ).toContain("644");

      const pastEdge = ["node-pty", ...Array.from({ length: PROXIMITY_WINDOW_LINES }, () => "filler"), "mode 644"];
      expect(scanForChainRestatement([{ path: "docs/x.md", contents: pastEdge.join("\n") }])).toEqual([]);
    });
  });

  describe("structural exemptions are per-token and per-file, not a blanket pass", () => {
    it("lets pnpm-workspace.yaml name its OWN key — a config key restates nothing", () => {
      const contents = "allowBuilds:\n  esbuild: true\n  # see the canonical account\n  node-pty: false";
      expect(scanForChainRestatement([{ path: "pnpm-workspace.yaml", contents }])).toEqual([]);
    });

    it("still polices the MECHANISM in that same file — the structural pass covers one token only", () => {
      // The exact shape #235 is about: the workspace manifest's comment block restating the chain.
      const contents = "allowBuilds:\n  # spawn-helper is mode 644 and nothing chmods it\n  node-pty: false";
      const findings = scanForChainRestatement([{ path: "pnpm-workspace.yaml", contents }]);
      expect(findings.map((f) => f.token)).toContain("spawn-helper");
      expect(findings.map((f) => f.token)).toContain("644");
    });

    it("does NOT let another file borrow that structural pass", () => {
      const contents = "flip allowBuilds for node-pty to build it";
      const findings = scanForChainRestatement([{ path: "packages/e2e/README.md", contents }]);
      expect(findings.map((f) => f.token)).toContain("allowBuilds");
    });

    it("does NOT fire on allowBuilds absent node-pty — a doc about esbuild's build gating is not this chain", () => {
      expect(scanForChainRestatement([{ path: "docs/builds.md", contents: "allowBuilds gates esbuild" }])).toEqual([]);
    });
  });

  it("treats `node-pty` itself as ordinary vocabulary — a dozen files reference it legitimately", () => {
    // Deliberately NOT a chain token: banning it would fire on every file that merely names the
    // dependency, and the fingerprint of a RESTATEMENT is the internals, not the package.
    const contents = "#68 needs a spawn-capable node-pty on this box; the fence is CCCTL_E2E_PTY";
    expect(scanForChainRestatement([{ path: "packages/e2e/src/daemon-soak.ts", contents }])).toEqual([]);
  });

  it("scans every subject rather than stopping at the first offender", () => {
    const findings = scanForChainRestatement([
      { path: "docs/a.md", contents: "posix_spawnp" },
      { path: "docs/b.md", contents: "binding.gyp" },
    ]);
    expect(findings.map((f) => f.file)).toEqual(["docs/a.md", "docs/b.md"]);
  });
});

describe("formatCensusFindings", () => {
  it("names every site, its reason, and the move that resolves it", () => {
    const report = formatCensusFindings(
      scanForChainRestatement([{ path: "docs/x.md", contents: "the spawn-helper thing" }]),
    );
    expect(report).toContain("docs/x.md:1");
    expect(report).toContain("spawn-helper");
    expect(report).toContain(CANONICAL_HOME);
    expect(report).toContain("arm:pty");
    expect(report).toContain("EXEMPT_FILES");
  });

  it("counts sites in singular/plural so the message never reads as a template", () => {
    expect(formatCensusFindings(scanForChainRestatement([{ path: "a.md", contents: "posix_spawnp" }]))).toContain(
      "(1 site)",
    );
    expect(
      formatCensusFindings(
        scanForChainRestatement([
          { path: "a.md", contents: "posix_spawnp" },
          { path: "b.md", contents: "forkpty" },
        ]),
      ),
    ).toContain("(2 sites)");
  });
});
