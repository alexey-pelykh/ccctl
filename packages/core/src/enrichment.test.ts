// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  answerEnvelopeFromValue,
  applyWorkerStatusFrame,
  createSession,
  enrichmentQuestionId,
  isEnrichmentQuestionId,
  isInputAwaited,
  isInputRequestEvent,
  MAX_ENRICHMENT_OPTIONS,
  MAX_ENRICHMENT_QUESTIONS,
  MAX_ENRICHMENT_TEXT_LENGTH,
  MAX_REQUIRES_ACTION_DETAIL_LENGTH,
  requiresActionEnrichmentFromFrame,
  requiresActionEnrichmentFromValue,
  sessionActivityFromFrame,
  type ControlFrame,
} from "./index.js";

// A fixed epoch so every assertion is deterministic — the injectable `now` seam
// means no test ever reads a real clock (mirrors `session-model.test.ts`).
const T0 = 1_000_000;

// The payload shape ADR-005 (the #263 spike) observed on `tool_input`, verbatim:
// `{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }`,
// plus the `sequence_num` the emitter stamps (#201). Every fixture builds off this so the
// tests track the real wire, not a convenient invention.
function wireQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Which database should the migration target?",
    header: "Migration target",
    options: [
      { label: "Postgres", description: "The production default." },
      { label: "SQLite", description: "Local development only." },
    ],
    multiSelect: false,
    ...overrides,
  };
}

function wirePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sequence_num: 7, questions: [wireQuestion()], ...overrides };
}

describe("requiresActionEnrichmentFromValue (AC: the informational-class carrier, fail-closed)", () => {
  it("parses the observed AskUserQuestion payload into the domain shape", () => {
    const enrichment = requiresActionEnrichmentFromValue(wirePayload());
    expect(enrichment).toEqual({
      sequenceNum: 7,
      questions: [
        {
          questionId: "q0",
          prompt: "Which database should the migration target?",
          header: "Migration target",
          options: [
            { label: "Postgres", description: "The production default." },
            { label: "SQLite", description: "Local development only." },
          ],
          multiSelect: false,
        },
      ],
    });
  });

  it("assigns positional, frame-scoped ids across several questions", () => {
    const enrichment = requiresActionEnrichmentFromValue(
      wirePayload({ questions: [wireQuestion(), wireQuestion(), wireQuestion({ multiSelect: true })] }),
    );
    expect(enrichment?.questions.map((q) => q.questionId)).toEqual([
      enrichmentQuestionId(0),
      enrichmentQuestionId(1),
      enrichmentQuestionId(2),
    ]);
    expect(enrichment?.questions.map((q) => q.questionId)).toEqual(["q0", "q1", "q2"]);
    expect(enrichment?.questions[2]?.multiSelect).toBe(true);
  });

  it("omits header and description when absent — they are decoration on decoration", () => {
    const q = wireQuestion({ header: undefined, options: [{ label: "Yes" }] });
    const enrichment = requiresActionEnrichmentFromValue(wirePayload({ questions: [q] }));
    expect(enrichment?.questions[0]).toEqual({
      questionId: "q0",
      prompt: "Which database should the migration target?",
      options: [{ label: "Yes" }],
      multiSelect: false,
    });
    expect(enrichment?.questions[0] && "header" in enrichment.questions[0]).toBe(false);
  });

  it("fails closed (null) on a non-object, null, or array", () => {
    expect(requiresActionEnrichmentFromValue(undefined)).toBeNull();
    expect(requiresActionEnrichmentFromValue(null)).toBeNull();
    expect(requiresActionEnrichmentFromValue("nope")).toBeNull();
    expect(requiresActionEnrichmentFromValue([wireQuestion()])).toBeNull();
  });

  it("fails closed on a missing or malformed sequence_num — the correlation is required (#201)", () => {
    // A required, usable #201 stamp (the same guard both worker_status legs read it through):
    // absent, malformed, negative, and non-integer all collapse to the same refusal.
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: undefined }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: "7" }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: -1 }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: 1.5 }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: Number.NaN }))).toBeNull();
  });

  it("accepts sequence_num zero — the counter starts at a valid stamp", () => {
    expect(requiresActionEnrichmentFromValue(wirePayload({ sequence_num: 0 }))?.sequenceNum).toBe(0);
  });

  it("fails closed on a missing, non-array, or EMPTY questions list", () => {
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: undefined }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: "one" }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [] }))).toBeNull();
  });

  it("fails closed on a question missing its text or carrying a present non-boolean multiSelect", () => {
    // (An ABSENT multiSelect is NOT a failure — it defaults to false per the source schema; see the
    // dedicated `multiSelect absence` describe block below.)
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ question: undefined })] })),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ question: "   " })] })),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: "false" })] })),
    ).toBeNull();
  });

  it("fails closed on a question with a missing, non-array, or EMPTY options list", () => {
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ options: undefined })] })),
    ).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ options: {} })] }))).toBeNull();
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ options: [] })] }))).toBeNull();
  });

  it("fails closed on an option with no usable label", () => {
    expect(
      requiresActionEnrichmentFromValue(
        wirePayload({ questions: [wireQuestion({ options: [{ description: "no label" }] })] }),
      ),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ options: [{ label: "   " }] })] })),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ options: ["Postgres"] })] })),
    ).toBeNull();
  });

  it("drops the WHOLE enrichment when any single question is malformed — positional ids must not renumber", () => {
    // The load-bearing all-or-nothing case: silently dropping question index 1 would make the
    // real q2 answer as q1, routing an answer to a question the operator never saw (#86 phantom).
    const withHole = wirePayload({
      questions: [wireQuestion(), wireQuestion({ options: [] }), wireQuestion()],
    });
    expect(requiresActionEnrichmentFromValue(withHole)).toBeNull();
  });

  it("drops the WHOLE question when any single option is malformed — options are all-or-nothing too", () => {
    const withHole = wireQuestion({ options: [{ label: "Postgres" }, { description: "no label" }] });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [withHole] }))).toBeNull();
  });
});

describe("enrichment text normalization (AC: untrusted worker-supplied display, ≤200 code points, no active content)", () => {
  // Hostile characters are spelled by escape so NO raw control/format byte sits in this source —
  // the repo's `no-control-regex` stance (see CONTROL_CHARACTERS in index.ts), applied to string
  // literals too.
  const ESC = "\u001B"; // C0 control — opens an ANSI/CSI escape.
  const BIDI_OVERRIDE = "\u202E"; // Cf format — reorders the text after it.

  // This case and the clamp below pin the BOUND — that enrichment text is clamped to this many code
  // points, and that the value is derived from the detail bound. They deliberately do NOT claim to
  // pin the WIRING (that `enrichmentText` passes this constant rather than letting the default
  // apply): because the two constants are equal by derivation, threading it is behaviourally a
  // no-op, so no black-box test can tell the two apart. The wiring is a readability property,
  // enforced by review; a test named for it would be theatre that goes green either way.
  it("shares the requires_action detail bound — the same untrusted text, one ceiling", () => {
    expect(MAX_ENRICHMENT_TEXT_LENGTH).toBe(MAX_REQUIRES_ACTION_DETAIL_LENGTH);
    expect(MAX_ENRICHMENT_TEXT_LENGTH).toBe(200);
  });

  it("strips control characters and a bidi override from a label — no active content survives", () => {
    // A forged newline (would forge a row), an ESC (would repaint the terminal), a U+202E bidi
    // override (would reorder the rest of the line): all neutralized at the boundary.
    const hostile = wireQuestion({
      options: [{ label: `Yes\n${ESC}[31mrm -rf${BIDI_OVERRIDE} evil` }],
    });
    const label = requiresActionEnrichmentFromValue(wirePayload({ questions: [hostile] }))?.questions[0]?.options[0]
      ?.label;
    expect(label).toBeDefined();
    // No Cc (control) or Cf (format) code point survives normalization — asserted via property
    // escapes, not a control-character class (which `no-control-regex` rightly rejects).
    expect(Array.from(label ?? "").some((ch) => /\p{Cc}|\p{Cf}/u.test(ch))).toBe(false);
    // \n and ESC became spaces (then collapsed to one); the bidi override was dropped outright.
    expect(label).toBe("Yes [31mrm -rf evil");
  });

  it("clamps an over-long prompt to 200 code points, counting by code point not UTF-16 unit", () => {
    // Astral characters are 2 UTF-16 units each; a naive slice would cut a surrogate pair in half.
    const longPrompt = "😀".repeat(300);
    const prompt = requiresActionEnrichmentFromValue(
      wirePayload({ questions: [wireQuestion({ question: longPrompt })] }),
    )?.questions[0]?.prompt;
    expect(prompt).toBeDefined();
    expect(Array.from(prompt ?? "")).toHaveLength(MAX_ENRICHMENT_TEXT_LENGTH);
    expect((prompt ?? "").endsWith("…")).toBe(true);
  });
});

describe("isInputRequestEvent / requiresActionEnrichmentFromFrame (AC: the new subtype)", () => {
  function frame(payload: unknown): ControlFrame {
    return { type: "control_event", subtype: "input_request", payload } as ControlFrame;
  }

  it("narrows a well-formed input_request frame", () => {
    expect(isInputRequestEvent(frame(wirePayload()))).toBe(true);
  });

  it("rejects any other frame by discriminant", () => {
    expect(
      isInputRequestEvent({ type: "control_event", subtype: "worker_status", payload: { status: "requires_action" } }),
    ).toBe(false);
    expect(isInputRequestEvent({ type: "control_event", subtype: "message", payload: {} })).toBe(false);
    expect(isInputRequestEvent({ type: "control_request", id: "r-1", subtype: "prompt" })).toBe(false);
  });

  it("derives the enrichment from a well-formed input_request frame", () => {
    expect(requiresActionEnrichmentFromFrame(frame(wirePayload()))?.sequenceNum).toBe(7);
  });

  it("returns null from a non-input_request frame — never an activity, by construction", () => {
    const workerStatus: ControlFrame = {
      type: "control_event",
      subtype: "worker_status",
      payload: { status: "requires_action" },
    };
    expect(requiresActionEnrichmentFromFrame(workerStatus)).toBeNull();
  });

  it("returns null from an input_request frame whose payload is malformed", () => {
    expect(requiresActionEnrichmentFromFrame(frame({ sequence_num: 1, questions: [] }))).toBeNull();
  });
});

describe("answerEnvelopeFromValue (AC: uniform array shape, single-select is length-1, never string | string[])", () => {
  it("parses a single-select answer as a length-1 array", () => {
    expect(answerEnvelopeFromValue({ answers: { q0: ["Postgres"] } })).toEqual({ answers: { q0: ["Postgres"] } });
  });

  it("round-trips all chosen labels for a multi-select question", () => {
    expect(answerEnvelopeFromValue({ answers: { q0: ["Postgres", "SQLite"] } })).toEqual({
      answers: { q0: ["Postgres", "SQLite"] },
    });
  });

  it("keys several answered questions independently", () => {
    expect(answerEnvelopeFromValue({ answers: { q0: ["Yes"], q1: ["A", "B"] } })).toEqual({
      answers: { q0: ["Yes"], q1: ["A", "B"] },
    });
  });

  it("REFUSES a bare string selection — never coerces it to characters", () => {
    // The whole reason the shape is uniform: a bare "Yes" iterated as a string answers Y/e/s.
    expect(answerEnvelopeFromValue({ answers: { q0: "Yes" } })).toBeNull();
  });

  it("fails closed on a non-object, a missing/non-object answers, or an EMPTY answers", () => {
    expect(answerEnvelopeFromValue(null)).toBeNull();
    expect(answerEnvelopeFromValue([])).toBeNull();
    expect(answerEnvelopeFromValue({})).toBeNull();
    expect(answerEnvelopeFromValue({ answers: null })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: ["Postgres"] })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: {} })).toBeNull();
  });

  it("fails closed on an empty selection array or a non-string label", () => {
    expect(answerEnvelopeFromValue({ answers: { q0: [] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { q0: [42] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { q0: ["Postgres", ""] } })).toBeNull();
  });

  it("normalizes labels on the way in — no control character rides an answer back to the worker", () => {
    expect(answerEnvelopeFromValue({ answers: { q0: ["Yes\u202E\n"] } })).toEqual({ answers: { q0: ["Yes"] } });
  });
});

describe("isInputAwaited vs. the enrichment class (#261 hard gate: an informational frame is a structural no-op)", () => {
  // The #40 invariant block — `session-model.test.ts:78-139` — ratifies that a HOOK cannot move
  // the blocking signal. #261 adds a SECOND informational subtype, `input_request`, so these cases
  // mirror that block's hook-no-op pair (`session-model.test.ts:116-138`) for the new frame.
  //
  // They live HERE, not beside the cases they mirror, deliberately: #261's hard gate pins
  // `session-model.test.ts:78-139` byte-for-byte, and that file's imports sit ABOVE line 78 — so
  // importing one enrichment symbol into it would shift the pinned block down a line and break the
  // gate on a technicality. Keeping that file at a ZERO diff makes the gate verifiable by a bare
  // `git diff` rather than by trusting a line-range check to have counted the offset correctly.
  //
  // Every case asserts the frame IS a well-formed enrichment BEFORE asserting the no-op. Without
  // that premise a typo'd fixture would pass for the wrong reason — "it no-ops because it is
  // garbage" is not the claim; "it no-ops because it is not a `worker_status`, however well-formed
  // it is" is.

  /** A well-formed `input_request` enrichment frame (ADR-005's observed payload shape). */
  function enrichmentFrame(): ControlFrame {
    return { type: "control_event", subtype: "input_request", payload: wirePayload() } as ControlFrame;
  }

  /** A `worker_status` frame — the ONLY class that may move the signal. */
  function statusFrame(status: string, detail?: string): ControlFrame {
    return { type: "control_event", subtype: "worker_status", payload: { status, detail } } as ControlFrame;
  }

  it("is a well-formed enrichment — the premise every no-op case below rests on", () => {
    const enrichment = requiresActionEnrichmentFromFrame(enrichmentFrame());
    expect(enrichment).not.toBeNull();
    expect(enrichment?.questions).toHaveLength(1);
  });

  it("an enrichment frame alone does not fire it — a non-worker_status event never transitions activity", () => {
    const idle = createSession("sess-1", "default", T0);
    const afterEnrichment = applyWorkerStatusFrame(idle, enrichmentFrame(), T0 + 10);
    expect(afterEnrichment).toBe(idle); // no-op: the enrichment cannot move the session.
    expect(isInputAwaited(afterEnrichment.activity)).toBe(false);
  });

  it("an enrichment cannot resurrect the signal after requires_action was cleared by idle", () => {
    // requires_action → idle → enrichment: the decoration must not re-raise the blocking signal.
    let session = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame("requires_action", "Approve?"),
      T0 + 10,
    );
    expect(isInputAwaited(session.activity)).toBe(true);
    session = applyWorkerStatusFrame(session, statusFrame("idle"), T0 + 20);
    expect(isInputAwaited(session.activity)).toBe(false);
    session = applyWorkerStatusFrame(session, enrichmentFrame(), T0 + 30);
    expect(isInputAwaited(session.activity)).toBe(false);
  });

  it("an enrichment cannot CLEAR a live requires_action either — it moves the signal in NEITHER direction", () => {
    // The half a "does not fire it" case cannot see: subordinate means it cannot UNBLOCK, either.
    const blocked = applyWorkerStatusFrame(
      createSession("sess-1", "default", T0),
      statusFrame("requires_action", "Approve the edit?"),
      T0 + 10,
    );
    const afterEnrichment = applyWorkerStatusFrame(blocked, enrichmentFrame(), T0 + 20);
    expect(afterEnrichment).toBe(blocked); // no-op: the same object, detail included.
    expect(isInputAwaited(afterEnrichment.activity)).toBe(true);
    expect(afterEnrichment.activity).toEqual({ kind: "requires_action", detail: "Approve the edit?" });
  });

  it("derives NO activity from an enrichment frame — the derivation itself fails closed", () => {
    // One level below the transition: the frame cannot even produce an activity to apply.
    expect(sessionActivityFromFrame(enrichmentFrame())).toBeNull();
  });
});

describe("fail-closed against a JSON-decoded hostile key (#261: the answer trust boundary)", () => {
  // `JSON.parse` makes `__proto__` an OWN ENUMERABLE property — an object literal does NOT — so it
  // survives `Object.entries`, and assigning it on a normal accumulator hits `Object.prototype`'s
  // SETTER instead of creating a key. The guard would then return a non-null envelope with the
  // entry vanished and the prototype corrupted: neither fail-closed nor all-or-nothing.
  const hostileKey = (body: string): unknown => JSON.parse(body) as unknown;

  it("REFUSES a __proto__ questionId outright — it is not an id core can mint", () => {
    expect(answerEnvelopeFromValue(hostileKey('{"answers":{"__proto__":["evil"]}}'))).toBeNull();
  });

  it("REFUSES a __proto__ entry even alongside a legitimate answer — all-or-nothing holds", () => {
    // The silent-drop shape: this must not return { answers: { q0: [...] } } with the hostile
    // entry quietly gone, which is exactly the "refuses to be clever" rule questions/options follow.
    expect(answerEnvelopeFromValue(hostileKey('{"answers":{"q0":["Postgres"],"__proto__":["evil"]}}'))).toBeNull();
  });

  it("REFUSES constructor / prototype keys — a whitelist needs no list of hostile names", () => {
    expect(answerEnvelopeFromValue(hostileKey('{"answers":{"constructor":["x"]}}'))).toBeNull();
    expect(answerEnvelopeFromValue(hostileKey('{"answers":{"prototype":["x"]}}'))).toBeNull();
  });

  it("REFUSES any key outside the minted grammar", () => {
    expect(answerEnvelopeFromValue({ answers: { notAnId: ["x"] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { q: ["x"] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { "q-1": ["x"] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { q1x: ["x"] } })).toBeNull();
    expect(answerEnvelopeFromValue({ answers: { q01: ["x"] } })).toBeNull(); // no leading zeros
  });

  it("never returns an object whose prototype a payload could corrupt", () => {
    const ok = answerEnvelopeFromValue({ answers: { q0: ["Postgres"] } });
    expect(ok).not.toBeNull();
    expect(ok && Object.getPrototypeOf(ok.answers)).toBeNull();
  });

  it("leaves the global Object.prototype untouched (it was never the target — this pins it)", () => {
    answerEnvelopeFromValue(hostileKey('{"answers":{"__proto__":["evil"]}}'));
    expect(({} as Record<string, unknown>)["0"]).toBeUndefined();
    expect(Object.prototype).toBe(Object.getPrototypeOf({}));
  });
});

describe("isEnrichmentQuestionId (the grammar core mints)", () => {
  it("accepts exactly what enrichmentQuestionId produces", () => {
    for (const i of [0, 1, 9, 10, 15]) {
      expect(isEnrichmentQuestionId(enrichmentQuestionId(i))).toBe(true);
    }
  });

  it("rejects non-strings and anything off-grammar", () => {
    expect(isEnrichmentQuestionId(0)).toBe(false);
    expect(isEnrichmentQuestionId(undefined)).toBe(false);
    expect(isEnrichmentQuestionId("__proto__")).toBe(false);
    expect(isEnrichmentQuestionId("q")).toBe(false);
    expect(isEnrichmentQuestionId("q01")).toBe(false);
    expect(isEnrichmentQuestionId(" q0")).toBe(false);
    expect(isEnrichmentQuestionId("q0\n")).toBe(false);
  });
});

describe("normalized-label collisions (#261: the label IS the answer token)", () => {
  // Normalization is many-to-one, so two DISTINCT wire labels can collapse to one token. Since the
  // label is the answer token, the collision does not fail to match — it matches AMBIGUOUSLY, and
  // an emitter taking the first match answers an option the operator did not tap (#86 phantom).
  it("REFUSES a question whose labels collide after whitespace normalization", () => {
    const collide = wireQuestion({ options: [{ label: "Yes  please" }, { label: "Yes\tplease" }] });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [collide] }))).toBeNull();
  });

  it("REFUSES a question whose labels collide after the 200-code-point clamp", () => {
    const base = "a".repeat(199);
    const collide = wireQuestion({ options: [{ label: `${base}FIRST` }, { label: `${base}SECOND` }] });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [collide] }))).toBeNull();
  });

  it("REFUSES exact duplicate labels", () => {
    const dupe = wireQuestion({ options: [{ label: "Yes" }, { label: "Yes" }] });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [dupe] }))).toBeNull();
  });

  it("allows the SAME label in DIFFERENT questions — the token is scoped to its question", () => {
    const q = wireQuestion({ options: [{ label: "Yes" }, { label: "No" }] });
    const enrichment = requiresActionEnrichmentFromValue(wirePayload({ questions: [q, q] }));
    expect(enrichment?.questions).toHaveLength(2);
    expect(enrichment?.questions[1]?.options[0]?.label).toBe("Yes");
  });

  it("does not confuse a colliding DESCRIPTION with a colliding label", () => {
    const q = wireQuestion({
      options: [
        { label: "Postgres", description: "same" },
        { label: "SQLite", description: "same" },
      ],
    });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [q] }))?.questions[0]?.options).toHaveLength(2);
  });
});

describe("cardinality bounds (#261: the text cap bounds each string; these bound the aggregate)", () => {
  const optionsOf = (n: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, i) => ({ label: `opt${i}` }));

  it("accepts questions and options exactly at the cap", () => {
    const atCap = wirePayload({
      questions: Array.from({ length: MAX_ENRICHMENT_QUESTIONS }, () =>
        wireQuestion({ options: optionsOf(MAX_ENRICHMENT_OPTIONS) }),
      ),
    });
    const enrichment = requiresActionEnrichmentFromValue(atCap);
    expect(enrichment?.questions).toHaveLength(MAX_ENRICHMENT_QUESTIONS);
    expect(enrichment?.questions[0]?.options).toHaveLength(MAX_ENRICHMENT_OPTIONS);
  });

  it("REFUSES one question past the cap", () => {
    const overCap = wirePayload({
      questions: Array.from({ length: MAX_ENRICHMENT_QUESTIONS + 1 }, () => wireQuestion()),
    });
    expect(requiresActionEnrichmentFromValue(overCap)).toBeNull();
  });

  it("REFUSES one option past the cap", () => {
    const overCap = wireQuestion({ options: optionsOf(MAX_ENRICHMENT_OPTIONS + 1) });
    expect(requiresActionEnrichmentFromValue(wirePayload({ questions: [overCap] }))).toBeNull();
  });

  it("REFUSES an unbounded payload outright — 5,000 questions is not a decoration", () => {
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: Array.from({ length: 5000 }, () => wireQuestion()) })),
    ).toBeNull();
  });

  it("bounds an AnswerEnvelope's keys and its per-question selections too", () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_ENRICHMENT_QUESTIONS + 1 }, (_, i) => [`q${i}`, ["x"]]),
    );
    expect(answerEnvelopeFromValue({ answers: tooManyKeys })).toBeNull();
    const tooManyLabels = Array.from({ length: MAX_ENRICHMENT_OPTIONS + 1 }, (_, i) => `opt${i}`);
    expect(answerEnvelopeFromValue({ answers: { q0: tooManyLabels } })).toBeNull();
  });
});

describe("multiSelect absence follows the source schema default (#261: not our guess to make)", () => {
  // The source tool's schema declares `multiSelect: v.boolean().default(false)`, so an absent
  // multiSelect is single-select by specification — a raw-forwarded `tool_input` (no default yet
  // applied) is a LEGAL AskUserQuestion, and failing it closed would drop a valid enrichment.
  it("defaults an absent multiSelect to false rather than dropping the enrichment", () => {
    const q = wireQuestion({ multiSelect: undefined });
    const enrichment = requiresActionEnrichmentFromValue(wirePayload({ questions: [q] }));
    expect(enrichment).not.toBeNull();
    expect(enrichment?.questions[0]?.multiSelect).toBe(false);
  });

  it("still carries an explicit true/false through unchanged", () => {
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: true })] }))?.questions[0]
        ?.multiSelect,
    ).toBe(true);
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: false })] }))
        ?.questions[0]?.multiSelect,
    ).toBe(false);
  });

  it("STILL fails closed on a present-but-non-boolean multiSelect — that is drift, not a default", () => {
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: "false" })] })),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: 0 })] })),
    ).toBeNull();
    expect(
      requiresActionEnrichmentFromValue(wirePayload({ questions: [wireQuestion({ multiSelect: null })] })),
    ).toBeNull();
  });
});
