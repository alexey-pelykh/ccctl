// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The node-pty ARMING-CHAIN CENSUS (#235) — the mechanical gate that keeps the ~10-link causal
 * account of *why a default checkout cannot spawn a pty* in exactly ONE home, and FAILS the build
 * when any other tracked file restates it.
 *
 * **Why this is a gate and not a convention.** The chain was hand-synced across four sites and the
 * duplication was the DEFECT GENERATOR: #68 produced three instances of the same failure in one
 * branch — each a causal mechanism asserted from inference and hardened into a copy. The fix for
 * the third was a PROSE CONVENTION ("don't restate; point at the canonical account") — the same
 * class of unenforced intention that produced all three. This census exists because the convention
 * is what failed. So does the count: #68's own commit message said "five copies become
 * three" (true within `packages/e2e`, wrong repo-wide: six → four), dropping `pnpm-workspace.yaml`
 * from the tally TWICE — which is precisely the copy a hand-synced mental model fails to hold. A
 * hand-maintained tally is therefore NOT the remedy; the tally is the thing that drifted.
 *
 * **What it polices, and what it explicitly does NOT.** This gate polices the doc CENSUS — *how
 * many places state the chain* — never the chain's TRUTH. A false mechanism claim written INSIDE
 * {@link CANONICAL_HOME} passes this gate untouched; catching that is a reviewer's job (and was,
 * three times). What the gate buys is that there is exactly one place a reviewer must look, and
 * that a fourth copy cannot appear silently. Those are different guarantees and only the second one
 * is mechanizable.
 *
 * **Why a token census rather than prose analysis, and what that CANNOT buy.** "Is this paragraph a
 * restatement of the causal chain?" is a judgment; a gate cannot make it. What a gate can decide is
 * whether a file names node-pty's own implementation internals — and every restatement of this chain
 * in this repo's history has, including all three of #68's wrong ones. Those nouns are the chain's
 * fingerprint ({@link CHAIN_TOKENS}); they are distinctive enough that no unrelated file names them,
 * and banning them outside the canonical home is mechanically decidable.
 *
 * So this gate is a PROXY, and the proxy has a known hole: a sufficiently vague paraphrase — "the
 * prebuilt helper ships without the execute bit; flipping the workspace build flag fixes both
 * platforms" — restates the chain, is WRONG in exactly instance 3's way, and passes green, because
 * it names none of the fingerprint. Do not read a green census as "no copy exists"; read it as "no
 * copy that talks like the previous four exists" — closing that hole needs a judgment the gate does
 * not have, so it NARROWS the reviewer's job rather than replacing it.
 *
 * **Ambiguous tokens carry a proximity window rather than a file-wide co-occurrence rule.** `644`
 * is the crispest single fact of the darwin half, but it is also a plain POSIX file mode: three
 * unrelated server files use `0o644` for their own fixtures. Requiring a companion token
 * ({@link ChainToken.onlyWith}) disambiguates — but requiring it merely SOMEWHERE IN THE SAME FILE
 * does not: `session-launcher-tmux.test.ts` names node-pty in a passing comparison at one end and
 * writes an unrelated `0o644` fixture 500 lines later. So the companion must appear WITHIN
 * {@link PROXIMITY_WINDOW_LINES} lines. Every real restatement puts them on the SAME line; the
 * window is slack, not a guess.
 *
 * **The false positives this proxy costs, and how to pay them.** A file that restates NOTHING can
 * still name a token — a troubleshooting doc listing `posix_spawnp failed` (the string an operator
 * greps for) is the obvious one. That is a real cost, not a bug: prefer
 * {@link ChainToken.structuralIn} on the ONE token in the ONE file, which leaves every other token
 * there policed. Reach for {@link EXEMPT_FILES} only when a file must name the tokens broadly — it
 * unpolices ALL of them for that path.
 *
 * **Scope: tracked files only.** `git ls-files` is the subject list, so a brand-new untracked doc
 * gets a green locally until it is `git add`ed. That boundary is where it matters — a PR's files are
 * committed, so CI scans everything — but a local pre-commit run can mislead.
 *
 * @see {@link EXEMPT_FILES} for the files allowed to name the tokens, and why each one is.
 */

/**
 * The ONE file allowed to carry the causal account. Every other site must point HERE rather than
 * restate it. Chosen (per #235) because it is the de-facto canonical copy already: it sits next to
 * the oracle whose fence the chain explains, so it is the copy a reader reaches for and the one a
 * change to the oracle's arming would touch first.
 */
export const CANONICAL_HOME = "packages/e2e/src/pty-handle-residual.ts";

/**
 * How near an {@link ChainToken.onlyWith} companion must sit for an ambiguous token to count as a
 * restatement. Every genuine restatement in the repo's history put the pair on the SAME line; the
 * nearest FALSE pair sits ~500 lines apart. Any window in between works — this one is slack.
 */
export const PROXIMITY_WINDOW_LINES = 5;

/** A noun that only a restatement of the arming chain has a reason to write. */
export interface ChainToken {
  /** The literal substring searched for. Matched case-insensitively. */
  readonly token: string;
  /** Why naming this outside {@link CANONICAL_HOME} is a restatement. Shown in the failure. */
  readonly why: string;
  /**
   * When set, the token counts ONLY if this companion appears within
   * {@link PROXIMITY_WINDOW_LINES} lines. For tokens that are ALSO ordinary vocabulary.
   */
  readonly onlyWith?: string;
  /**
   * Files where this token is STRUCTURE rather than prose — a config's own key cannot be a
   * restatement of anything. Narrower than {@link EXEMPT_FILES}: it exempts ONE token in ONE file,
   * leaving every other token in that file policed.
   */
  readonly structuralIn?: readonly string[];
}

/**
 * The chain's fingerprint: node-pty's implementation internals. A file that names one of these is
 * explaining node-pty's internal mechanics — which is the canonical home's job, and only its job.
 *
 * Membership test: could a file legitimately name this WITHOUT explaining why a default checkout
 * cannot spawn a pty? If yes it needs an {@link ChainToken.onlyWith} companion (or does not belong
 * here at all — `node-pty` itself is an ordinary noun that a dozen files legitimately reference,
 * and is deliberately ABSENT from this list).
 */
export const CHAIN_TOKENS: readonly ChainToken[] = [
  {
    token: "spawn-helper",
    why: "the shipped darwin binary whose mode bit is the whole darwin half of the chain",
  },
  {
    token: "posix_spawnp",
    why: "the failure string an unarmed darwin spawn dies with",
  },
  {
    token: "prebuild.js",
    why: "node-pty's install script — its probe/exit semantics are a chain link",
  },
  {
    token: "post-install.js",
    why: "node-pty's other install script — what it does NOT chmod is a chain link",
  },
  {
    token: "binding.gyp",
    why: "node-pty's build config — its OS gating is the Linux half's mechanism",
  },
  {
    token: "loadNativeModule",
    why: "node-pty's binding resolver — its search order is the chain's first link",
  },
  {
    token: "forkpty",
    why: "the syscall the Linux path uses INSTEAD of a helper — a chain link, and the one instance 2 got wrong",
  },
  {
    token: "conpty.dll",
    why: "the win32 artifact named only when enumerating what post-install touches",
  },
  {
    token: "npm_config_build_from_source",
    why: "the env lever that changes prebuild.js's behavior — a chain link",
  },
  {
    token: "644",
    why: "the helper's mode bit — the single crispest fact of the darwin half",
    // A plain POSIX mode: device-store-file, session-store-file and heap-snapshot all use `0o644`
    // for their own unrelated fixtures. Only a `644` written NEAR node-pty is about the helper.
    onlyWith: "node-pty",
  },
  {
    token: "allowBuilds",
    why: "the Linux lever — and the token instance 3 mis-linked to the darwin mechanism, twice",
    // `allowBuilds` also gates esbuild; a doc about THAT is not this chain.
    onlyWith: "node-pty",
    // The workspace manifest must NAME its own key to set it. The key is structure; the chain that
    // used to surround it in comments is not, and stays policed there.
    structuralIn: ["pnpm-workspace.yaml"],
  },
];

/** A file allowed to name {@link CHAIN_TOKENS}, and the reason it must be. */
export interface ExemptFile {
  readonly path: string;
  readonly why: string;
}

/**
 * The ONLY files allowed to name the tokens: the canonical ACCOUNT, plus the small tooling cluster
 * that enforces and executes it. {@link EXEMPT_FILES} is itself pinned by a test — so a NEW entry is
 * a deliberate, reviewed act rather than a quiet edit.
 *
 * **These are not copies of the chain.** Exactly ONE of them (the canonical home) states the causal
 * account. In the rest the tokens are CODE, not prose — a path the preflight opens, a mode it
 * compares, a token this census searches for, a fixture proving the search fires. The
 * distinction is load-bearing and it is what keeps the gate honest: prose asserting a wrong
 * mechanism misleads a reader indefinitely (three times, in #68), whereas a wrong path or a wrong
 * mode bit here fails a test on the next run. The gate bans tokens as a PROXY for the account; this
 * list is where the proxy's false positives are paid for, explicitly and reviewably.
 *
 * This is also NOT the "hand-maintained tally" #235 rules out. That tally counted COPIES of the
 * chain, lived in a commit message and a reader's head, and drifted silently (twice). This one lists
 * EXEMPT HOMES, is executable, and is asserted: get it wrong and the suite goes red.
 */
export const EXEMPT_FILES: readonly ExemptFile[] = [
  {
    path: CANONICAL_HOME,
    why: "the single canonical account — the whole point of the gate is that this file, and only this file, carries it",
  },
  {
    path: "packages/e2e/src/pty-chain-census.ts",
    why: "the gate itself: it must name the tokens to police them",
  },
  {
    path: "packages/e2e/src/pty-chain-census.test.ts",
    why: "the gate's own fixtures must name the tokens to prove it fires on them",
  },
  {
    path: "packages/e2e/src/arm-pty.ts",
    why: "the executable lever: it PROBES the mode bit rather than asserting it, so it cannot drift silently — a wrong path or a wrong mode fails at runtime, which prose cannot do",
  },
  {
    path: "packages/e2e/src/arm-pty.test.ts",
    why: "the preflight's own tests: they must name the helper it stats and the modes it branches on, and contorting them to dodge the census would trade a readable test for a token-free one",
  },
];

/** One restatement: a token found where it does not belong. */
export interface CensusFinding {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The offending token. */
  readonly token: string;
  /** Why that token is the chain's fingerprint — {@link ChainToken.why}. */
  readonly why: string;
  /** The offending line, trimmed. */
  readonly text: string;
}

/** A file to scan. Kept as plain data so the scan is pure and needs no repo to test. */
export interface CensusSubject {
  /** Repo-relative path — must match {@link EXEMPT_FILES} entries exactly. */
  readonly path: string;
  readonly contents: string;
}

/** Does `companion` appear within {@link PROXIMITY_WINDOW_LINES} lines of `lineIndex`? */
function hasCompanionNearby(lines: readonly string[], lineIndex: number, companion: string): boolean {
  const from = Math.max(0, lineIndex - PROXIMITY_WINDOW_LINES);
  const to = Math.min(lines.length, lineIndex + PROXIMITY_WINDOW_LINES + 1);
  const needle = companion.toLowerCase();
  return lines.slice(from, to).some((line) => line.toLowerCase().includes(needle));
}

/** Is `token` allowed in `path` — either as an exempt home, or as that file's own structure? */
function isAllowed(token: ChainToken, path: string): boolean {
  if (EXEMPT_FILES.some((exempt) => exempt.path === path)) return true;
  return token.structuralIn?.includes(path) ?? false;
}

/**
 * The census, as a pure function: every chain token named outside its allowed homes.
 *
 * Empty result = the chain has exactly one home. A non-empty result is not advice — each finding is
 * a site that must become a pointer at {@link CANONICAL_HOME}.
 */
export function scanForChainRestatement(subjects: Iterable<CensusSubject>): CensusFinding[] {
  const findings: CensusFinding[] = [];

  for (const subject of subjects) {
    const applicable = CHAIN_TOKENS.filter((token) => !isAllowed(token, subject.path));
    if (applicable.length === 0) continue;

    const lines = subject.contents.split("\n");
    lines.forEach((line, index) => {
      const haystack = line.toLowerCase();
      for (const token of applicable) {
        if (!haystack.includes(token.token.toLowerCase())) continue;
        if (token.onlyWith !== undefined && !hasCompanionNearby(lines, index, token.onlyWith)) continue;
        findings.push({
          file: subject.path,
          line: index + 1,
          token: token.token,
          why: token.why,
          text: line.trim(),
        });
      }
    });
  }

  return findings;
}

/** The failure message: every finding, why it is one, and the one move that resolves it. */
export function formatCensusFindings(findings: readonly CensusFinding[]): string {
  const lines = [
    `The node-pty arming chain is restated outside its canonical home (${findings.length} site${findings.length === 1 ? "" : "s"}).`,
    "",
    `Canonical home: ${CANONICAL_HOME}`,
    "",
  ];

  for (const finding of findings) {
    lines.push(`  ${finding.file}:${finding.line}  names \`${finding.token}\``);
    lines.push(`      ${finding.why}`);
    lines.push(`      > ${finding.text}`);
    lines.push("");
  }

  lines.push(
    "Each site above must POINT at the canonical home rather than restate it — #235: the",
    "duplication is the defect generator, and it produced three wrong causal claims in one branch.",
    "For the operator-facing lever, point at `pnpm --filter @ccctl/e2e arm:pty`, which probes this",
    "box rather than describing it.",
    "",
    "If a new file genuinely must name a token, add it to EXEMPT_FILES in",
    "packages/e2e/src/pty-chain-census.ts WITH a reason — that is a reviewed act, not a quiet one.",
  );

  return lines.join("\n");
}
