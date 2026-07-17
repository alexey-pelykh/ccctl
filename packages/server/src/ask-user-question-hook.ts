// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The `PreToolUse` hook script (#262, #78 Option A) that captures an `AskUserQuestion` tool
 * call's question + options and hands them off to the ccctl server — WITHOUT the hook itself
 * ever emitting anything over the network.
 *
 * **Why a hook cannot emit (ADR-005, decision 3 / SD-1).** The blocking "needs you" signal must
 * stay single-sourced from the worker's own `worker_status` reporting (#40) — a hook that POSTed
 * an enrichment frame directly would be a second, unauthenticated source of that signal. The hook
 * also has no credential to do so: the per-session `session_ingress_token` is pulled by the WORKER
 * over its own §3 work-poll after it starts, never exposed to a hook subprocess via env, argv, or
 * file. So this hook's entire job is CAPTURE-AND-HAND-OFF: read the payload, write it somewhere
 * the ccctl server (which spawned this whole process tree and is therefore always on the SAME
 * host) can find it, and never touch the block itself.
 *
 * **The hand-off is a same-host file, not a network call (empirically the only option left).**
 * `AskUserQuestion` blocks NATIVELY in bypass mode (ADR-005) — no `ask` decision needed to force
 * it — and a `PreToolUse` hook's own return schema (`hookSpecificOutput`) offers no field that
 * relays data anywhere except back into the model's own context (`additionalContext`) or the
 * permission decision itself; there is no generic "attach telemetry" channel Claude Code exposes.
 * So this hook ALWAYS returns an empty decision (never `ask`, per ADR-005's "no hook must force a
 * redundant double-prompt" warning) and separately writes the captured payload to a local file —
 * a same-host hand-off that needs no credential and crosses no network boundary, unlike the
 * rejected alternative of the hook POSTing to the server directly.
 *
 * **Fail-open toward NOT disturbing the tool call.** Whatever this hook reads, parses, or writes
 * — success or failure — it MUST NOT change whether `AskUserQuestion` proceeds. A malformed stdin
 * payload, an unwritable handoff path, or any thrown error all resolve the same way: print `{}`
 * (no permission decision — an implicit allow that leaves the native block untouched) and exit 0.
 * Losing the enrichment costs display fidelity; disturbing the block would cost correctness, and
 * this hook is not in the business of the latter (mirrors `@ccctl/core`'s "fails closed to `null`,
 * never toward blocking" stance on the enrichment contract itself).
 *
 * **The write is atomic and symlink-safe by construction.** The payload is written to a fresh
 * temp file IN THE SAME DIRECTORY as the target (so the final `rename` is same-filesystem, hence
 * atomic) and then renamed onto the exact target path the settings installer baked into this
 * hook's own argv. `rename(2)` replaces whatever directory entry sits at the destination — it
 * does not dereference the destination as a symlink and write through it — so even if something
 * placed a symlink at the handoff path, the rename atomically replaces THAT symlink with the real
 * file rather than following it elsewhere. No explicit symlink check is needed on the write side
 * for this reason (the read side, in `worker-channel.ts`, still resolves the real path before
 * trusting it — a second, independent guard against a different threat: a symlink placed BEFORE
 * this hook ever runs).
 *
 * **No sequence_num is stamped here.** This hook fires `PreToolUse` — before the tool executes
 * and therefore before the corresponding `worker_status: requires_action` report even exists — so
 * it cannot know which #201 sequence number will end up decorating. The captured payload carries
 * only `{ questions }`; the server stamps `sequence_num` itself, at the exact moment it observes
 * the matching `requires_action` transition (`worker-channel.ts` § `reconcileHookHandoff`).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read all of stdin as a UTF-8 string. `readFileSync(0, ...)` reads the whole of fd 0 to EOF —
 * the same idiom Claude Code's own hook contract assumes (a hook is a short-lived process fed one
 * JSON document on stdin, synchronously, before it must answer).
 */
function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    // No stdin, or a read error — treated as "nothing captured", not a crash (fail-open, see module doc).
    return "";
  }
}

/**
 * The tool name this hook matches. The settings installer ALSO scopes the hook's `matcher` to
 * this name (defense in depth: even if a settings drift ever wired this hook more broadly, this
 * check keeps it a no-op for every other tool).
 */
export const ASKUSERQUESTION_TOOL_NAME = "AskUserQuestion";

/**
 * Extract the raw, UNVALIDATED `questions` value from a decoded `PreToolUse` stdin payload, or
 * `undefined` when the payload does not match (wrong tool, not an object, no `tool_input`). This
 * is deliberately NOT validation — {@link requiresActionEnrichmentFromValue} in `@ccctl/core` is
 * the one place that shape is enforced, at CONSUMPTION time on the server. This hook forwards
 * verbatim rather than transcribing, exactly as `@ccctl/core`'s `InputRequestEvent` doc states the
 * emitter should.
 */
export function extractAskUserQuestionPayload(stdinValue: unknown): unknown {
  if (typeof stdinValue !== "object" || stdinValue === null || Array.isArray(stdinValue)) {
    return undefined;
  }
  const { tool_name: toolName, tool_input: toolInput } = stdinValue as Record<string, unknown>;
  if (toolName !== ASKUSERQUESTION_TOOL_NAME) {
    return undefined;
  }
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
    return undefined;
  }
  return (toolInput as { questions?: unknown }).questions;
}

/**
 * Write `questions` to `handoffPath` atomically: a fresh temp file in the SAME directory, then
 * `rename` onto the target (see module doc for why this is symlink-safe without an explicit
 * check). Best-effort — ANY failure (missing directory, permission, full disk) is swallowed, per
 * the module's fail-open stance: losing the hand-off loses only display data.
 */
export function writeHandoffFile(handoffPath: string, questions: unknown): void {
  const dir = dirname(handoffPath);
  const tempPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify({ questions }), { mode: 0o600 });
    // `writeFileSync`'s `mode` is umask-masked, so a pathological owner-clearing umask could leave
    // the temp file looser than 0600 — `chmod` FORCES it, mirroring `session-store-file.ts`'s save.
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, handoffPath);
  } catch {
    // Fail open — see module doc. Best-effort cleanup of the temp file if the rename itself is
    // what failed (e.g. a cross-device rename, which should not happen for a same-dir temp file,
    // but is cheap to guard).
    try {
      unlinkSync(tempPath);
    } catch {
      // Nothing to clean up, or already gone — either way, not this hook's problem to report.
    }
  }
}

/**
 * Run the hook once: read stdin, extract the `AskUserQuestion` payload (a no-op for any other
 * tool or malformed input), write it to `handoffPath` when present, and ALWAYS return the
 * empty-decision hook output (no `permissionDecision` — an implicit allow that leaves the native
 * block, proven by ADR-005, untouched).
 */
export function runHook(stdinText: string, handoffPath: string): Record<string, never> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return {};
  }
  const questions = extractAskUserQuestionPayload(parsed);
  if (questions !== undefined) {
    writeHandoffFile(handoffPath, questions);
  }
  return {};
}

/** Whether this module is being run as the process entry point (vs. imported for testing). */
function isEntryModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isEntryModule()) {
  const handoffPath = process.argv[2];
  const output = handoffPath === undefined ? {} : runHook(readStdinSync(), handoffPath);
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
