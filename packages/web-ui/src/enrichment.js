// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — AskUserQuestion enrichment rendering decisions (pure, DOM-free).
 *
 * The client half of the #78 "decide with a tap" surface. When a session blocks on an
 * `AskUserQuestion`, the worker's question + options ride the SERVER-served enrichment relay (#264):
 * `@ccctl/server` buffers the `input_request` decoration (#261) and re-serves it on the
 * `GET /api/sessions` list as `SessionSummaryWire.enrichment`, present ONLY while the session is
 * blocking on `requires_action`. This module owns the decisions that turn that relayed shape into a
 * tappable decision — decode, the join-on-`sequence_num` guard, and the {@link AnswerEnvelope} an
 * option tap builds — so they are unit-testable without a browser; `app.js` is the thin shell that
 * renders the buttons and POSTs the answer {@link answerCommand} builds.
 *
 * The `@ccctl/core` shapes are MIRRORED here as a doc constant, deliberately NOT imported (this module
 * is served to the browser as-is — no bundler — so it stays dependency-free vanilla ESM), the same
 * tradeoff `transcript.js` / `needs-you.js` / `sessions.js` make for the wire shapes:
 *
 *   RequiresActionEnrichment = { sequenceNum: number, questions: EnrichmentQuestion[] }
 *   EnrichmentQuestion       = { questionId: string, prompt: string, header?: string,
 *                                options: EnrichmentOption[], multiSelect: boolean }
 *   EnrichmentOption         = { label: string, description?: string }
 *   sequenceNum — the #201 stamp of the `worker_status` frame the enrichment decorates. The JOIN key
 *                 (AC5): the block's own `sequence_num` rides the live SSE `worker_status` frame
 *                 (`transcript.js`), and {@link enrichmentMatchesBlock} renders the options ONLY when
 *                 the two agree — so turn-N's options are never rendered against turn-N+1's block.
 *   questionId  — the {@link AnswerEnvelope} key core minted positionally (`q0`, `q1`, …). Forwarded
 *                 verbatim; the answer echoes it back.
 *   label       — the option's display text AND its answer token (#86 — "carries the selected
 *                 label(s)"). Forwarded VERBATIM into the answer, never re-normalized: `@ccctl/core`
 *                 already normalized it server-side, and re-normalizing here would risk diverging from
 *                 that one authority (the same stance `command.js`'s {@link answerCommand} takes).
 *
 * **Fail-closed, all-or-nothing** — the same posture `@ccctl/core`'s `requiresActionEnrichmentFromValue`
 * takes and for the same reason: a half-parsed question set is a "phantom decision" (#86), and dropping a
 * malformed question mid-list would RENUMBER the positional `questionId`s after it, routing an answer to a
 * question the operator never saw. So {@link decodeEnrichment} drops the WHOLE enrichment on any
 * malformation (the surface falls back to the bare `requires_action` block, still steerable by free text)
 * rather than serve a censored or renumbered choice. The server already validated what it serves; this
 * decode is the defensive second half over a value crossing the tunnel, mirroring how `sessions.js` reads
 * `payload?.sessions`.
 */

/**
 * Hard ceiling on the number of questions one enrichment may carry — mirrors `@ccctl/core`'s
 * `MAX_ENRICHMENT_QUESTIONS`. A wire value over the cap fails the whole enrichment closed (the server
 * bounds it, so an over-long list is drift, not a payload).
 */
export const MAX_ENRICHMENT_QUESTIONS = 16;

/**
 * Hard ceiling on the number of options one question may offer — mirrors `@ccctl/core`'s
 * `MAX_ENRICHMENT_OPTIONS`. Same fail-closed treatment as {@link MAX_ENRICHMENT_QUESTIONS}.
 */
export const MAX_ENRICHMENT_OPTIONS = 32;

/**
 * The default shortcut-phrase chips (#87 AC3) — a tappable row of common steering replies that insert
 * their phrase into the free-text steer input, so a routine "carry on" / "hold up" is a tap rather than
 * a typed sentence on a phone keyboard. Exported as a plain editable constant because the zero-build UI
 * has no config system: "configurable" here means this one list is the single place to change the set,
 * the same stance `app.js` takes for the poll interval. The phrases are the issue's own examples; they
 * feed the EXISTING free-text `prompt` steer (`inputCommand`), so they add a fast path without a new
 * verb — and free text stays available beside them (AC4).
 */
export const SHORTCUT_CHIPS = ["continue", "yes, proceed", "stop and explain"];

/** A non-empty trimmed string, or `undefined` when the value is not one. */
function displayString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Decode one wire value into a well-formed option, or `null` when it is not one. Fail-closed over a value
 * off the wire: a non-object, or a `label` that is absent or blank, yields `null` (an option with no
 * label is untappable and its answer token is empty). A `description` that is absent or blank is simply
 * omitted — it is decoration on decoration. Returns a FRESH object (no aliasing of the wire value).
 *
 * @param {unknown} value
 * @returns {{ label: string, description?: string } | null}
 */
export function decodeEnrichmentOption(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const label = displayString(value.label);
  if (label === undefined) {
    return null;
  }
  const description = displayString(value.description);
  return description === undefined ? { label } : { label, description };
}

/**
 * Decode one wire value into a well-formed question, or `null` when it is not one. Fail-closed: a
 * non-object, a blank `questionId` / `prompt`, a non-boolean `multiSelect`, a non-array / EMPTY /
 * over-long ({@link MAX_ENRICHMENT_OPTIONS}) `options`, or any single malformed option all yield `null`.
 * Options are all-or-nothing for the reason `@ccctl/core` pins: serving a SUBSET presents a
 * complete-looking choice the operator cannot actually make. `header` is optional and dropped when
 * blank. Returns a FRESH object; `options` is a fresh array of fresh options.
 *
 * @param {unknown} value
 * @returns {{ questionId: string, prompt: string, header?: string, options: Array<{ label: string, description?: string }>, multiSelect: boolean } | null}
 */
export function decodeEnrichmentQuestion(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const questionId = displayString(value.questionId);
  const prompt = displayString(value.prompt);
  const { options, multiSelect } = value;
  if (
    questionId === undefined ||
    prompt === undefined ||
    typeof multiSelect !== "boolean" ||
    !Array.isArray(options) ||
    options.length === 0 ||
    options.length > MAX_ENRICHMENT_OPTIONS
  ) {
    return null;
  }
  const parsed = [];
  for (const option of options) {
    const decoded = decodeEnrichmentOption(option);
    if (decoded === null) {
      return null;
    }
    parsed.push(decoded);
  }
  const header = displayString(value.header);
  const base = { questionId, prompt, options: parsed, multiSelect };
  return header === undefined ? base : { ...base, header };
}

/**
 * Decode a `SessionSummaryWire.enrichment` wire value (#264) into a well-formed enrichment, or `null`
 * when it is not one. The single fail-closed seam for the informational class on the client, mirroring
 * `@ccctl/core`'s `requiresActionEnrichmentFromValue`: a non-object, a `sequenceNum` that is not a
 * non-negative safe integer, a non-array / EMPTY / over-long ({@link MAX_ENRICHMENT_QUESTIONS})
 * `questions`, or any single malformed question all yield `null` rather than a half-typed enrichment
 * (see the all-or-nothing note in the module doc). Defensive over an absent field, so `undefined`
 * (a session with no outstanding block) reads as `null`, never a throw.
 *
 * @param {unknown} value - a `SessionSummaryWire.enrichment`, or any value.
 * @returns {{ sequenceNum: number, questions: Array<{ questionId: string, prompt: string, header?: string, options: Array<{ label: string, description?: string }>, multiSelect: boolean }> } | null}
 */
export function decodeEnrichment(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { sequenceNum, questions } = value;
  if (
    !Number.isSafeInteger(sequenceNum) ||
    sequenceNum < 0 ||
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > MAX_ENRICHMENT_QUESTIONS
  ) {
    return null;
  }
  const parsed = [];
  for (const question of questions) {
    const decoded = decodeEnrichmentQuestion(question);
    if (decoded === null) {
      return null;
    }
    parsed.push(decoded);
  }
  return { sequenceNum, questions: parsed };
}

/**
 * The join-on-`sequence_num` guard (#87 AC5): whether a decoded enrichment decorates the CURRENT block.
 * `true` only when the enrichment's `sequenceNum` equals the live block's `sequence_num` (the #201 stamp
 * the `worker_status` frame carries, surfaced by `transcript.js`). Everything else — a `null` enrichment,
 * an unknown block sequence (`null`, e.g. a worker that stamps no sequence, or before the SSE has
 * delivered the block frame), or a genuine MISMATCH — is `false`, so the stale turn-N options are
 * DISCARDED and the surface falls back to the bare block (fail-safe toward blocking, never a phantom
 * decision). The server serves the enrichment on blocking-PRESENCE only and explicitly defers this
 * per-block correlation to the client (`@ccctl/server` `ui-sessions.ts`); this is that correlation.
 *
 * @param {{ sequenceNum: number } | null | undefined} enrichment - a {@link decodeEnrichment} result.
 * @param {number | null | undefined} blockSequenceNum - the live block's `sequence_num`, or null when unknown.
 * @returns {boolean}
 */
export function enrichmentMatchesBlock(enrichment, blockSequenceNum) {
  return (
    enrichment !== null &&
    enrichment !== undefined &&
    typeof blockSequenceNum === "number" &&
    enrichment.sequenceNum === blockSequenceNum
  );
}

/**
 * Whether an enrichment is answered by a SINGLE option tap (#87 AC1's "tapping one sends that
 * selection") — true exactly for ONE single-select question, where one tap fully determines the answer.
 * Any other shape (a multi-select question, or more than one question) needs the operator to assemble a
 * selection across toggles and press a submit, because a single tap would answer only PART of the
 * envelope — and the server consumes the whole enrichment on the first accepted answer (#86), so a
 * partial answer would strand the unanswered questions. Defensive over a malformed enrichment (`null`).
 *
 * @param {{ questions: Array<{ multiSelect: boolean }> } | null | undefined} enrichment
 * @returns {boolean}
 */
export function submitsOnTap(enrichment) {
  return (
    enrichment !== null &&
    enrichment !== undefined &&
    enrichment.questions.length === 1 &&
    enrichment.questions[0].multiSelect === false
  );
}

/**
 * Build the {@link answerCommand} `answers` map from the operator's per-question selections, or `null`
 * when the selection is not yet a COMPLETE, valid answer to the whole enrichment — so the shell can gate
 * a submit on a non-null result and never POST a doomed answer.
 *
 * `selections` is `{ [questionId]: string[] }` — the labels the operator chose per question. The answer
 * must cover EVERY question the enrichment asks (the server consumes the enrichment whole, so an
 * unanswered question can never be answered later, #86), and each selection must be one the server will
 * accept ({@link validateAnswerAgainstEnrichment}): a single-select question answered with EXACTLY one
 * label, a multi-select with at least one, every label one the question OFFERED, and no label repeated.
 * Any violation → `null`. Labels are forwarded VERBATIM (already-normalized by core; re-normalizing risks
 * diverging from the answer token, per the module doc). Returns a FRESH map keyed only by the enrichment's
 * own question ids (an extra key in `selections` is ignored — the enrichment defines the questions).
 *
 * @param {{ questions: Array<{ questionId: string, options: Array<{ label: string }>, multiSelect: boolean }> } | null | undefined} enrichment
 * @param {Record<string, string[]> | null | undefined} selections
 * @returns {Record<string, string[]> | null}
 */
export function answerFromSelections(enrichment, selections) {
  if (enrichment === null || enrichment === undefined) {
    return null;
  }
  if (typeof selections !== "object" || selections === null || Array.isArray(selections)) {
    return null;
  }
  const answers = {};
  for (const question of enrichment.questions) {
    const chosen = selections[question.questionId];
    if (!Array.isArray(chosen) || chosen.length === 0) {
      return null;
    }
    if (!question.multiSelect && chosen.length !== 1) {
      return null;
    }
    const offered = new Set(question.options.map((option) => option.label));
    const seen = new Set();
    for (const label of chosen) {
      if (typeof label !== "string" || !offered.has(label) || seen.has(label)) {
        return null;
      }
      seen.add(label);
    }
    answers[question.questionId] = [...chosen];
  }
  return answers;
}
