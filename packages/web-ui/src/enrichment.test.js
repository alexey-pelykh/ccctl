// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  MAX_ENRICHMENT_QUESTIONS,
  MAX_ENRICHMENT_OPTIONS,
  SHORTCUT_CHIPS,
  decodeEnrichmentOption,
  decodeEnrichmentQuestion,
  decodeEnrichment,
  enrichmentMatchesBlock,
  submitsOnTap,
  answerFromSelections,
} from "./enrichment.js";

/** A well-formed option fixture. */
function option({ label = "Yes", description = "Proceed with the plan" } = {}) {
  return { label, description };
}

/** A well-formed question fixture (single-select by default). */
function question({
  questionId = "q0",
  prompt = "Proceed?",
  header = "Confirm",
  options = [option(), option({ label: "No", description: "Stop here" })],
  multiSelect = false,
} = {}) {
  return { questionId, prompt, header, options, multiSelect };
}

/** A well-formed enrichment fixture (the `SessionSummaryWire.enrichment` wire shape). */
function enrichment({ sequenceNum = 7, questions = [question()] } = {}) {
  return { sequenceNum, questions };
}

describe("mirrored constants", () => {
  it("MAX_ENRICHMENT_QUESTIONS mirrors @ccctl/core's cap", () => {
    expect(MAX_ENRICHMENT_QUESTIONS).toBe(16);
  });

  it("MAX_ENRICHMENT_OPTIONS mirrors @ccctl/core's cap", () => {
    expect(MAX_ENRICHMENT_OPTIONS).toBe(32);
  });

  it("SHORTCUT_CHIPS carries the issue's default steering phrases (AC3)", () => {
    expect(SHORTCUT_CHIPS).toEqual(["continue", "yes, proceed", "stop and explain"]);
  });
});

describe("decodeEnrichmentOption", () => {
  it("accepts a well-formed option and returns a fresh copy", () => {
    const wire = option();
    const decoded = decodeEnrichmentOption(wire);
    expect(decoded).toEqual({ label: "Yes", description: "Proceed with the plan" });
    expect(decoded).not.toBe(wire);
  });

  it("omits a blank / absent description (decoration on decoration)", () => {
    expect(decodeEnrichmentOption({ label: "Yes" })).toEqual({ label: "Yes" });
    expect(decodeEnrichmentOption({ label: "Yes", description: "   " })).toEqual({ label: "Yes" });
  });

  it("rejects a non-object / null / array", () => {
    expect(decodeEnrichmentOption(null)).toBeNull();
    expect(decodeEnrichmentOption(undefined)).toBeNull();
    expect(decodeEnrichmentOption("Yes")).toBeNull();
    expect(decodeEnrichmentOption([option()])).toBeNull();
  });

  it("rejects an absent / blank / non-string label (untappable, empty answer token)", () => {
    expect(decodeEnrichmentOption({ description: "x" })).toBeNull();
    expect(decodeEnrichmentOption({ label: "" })).toBeNull();
    expect(decodeEnrichmentOption({ label: "   " })).toBeNull();
    expect(decodeEnrichmentOption({ label: 42 })).toBeNull();
  });
});

describe("decodeEnrichmentQuestion", () => {
  it("accepts a well-formed question and returns a fresh copy with fresh options", () => {
    const wire = question();
    const decoded = decodeEnrichmentQuestion(wire);
    expect(decoded).toEqual({
      questionId: "q0",
      prompt: "Proceed?",
      header: "Confirm",
      options: [
        { label: "Yes", description: "Proceed with the plan" },
        { label: "No", description: "Stop here" },
      ],
      multiSelect: false,
    });
    expect(decoded).not.toBe(wire);
    expect(decoded.options).not.toBe(wire.options);
  });

  it("omits a blank / absent header", () => {
    expect(decodeEnrichmentQuestion(question({ header: "" })).header).toBeUndefined();
    // Absent: build directly — the fixture's `= "Confirm"` default would mask an omitted header.
    expect(
      decodeEnrichmentQuestion({ questionId: "q0", prompt: "Proceed?", options: [option()], multiSelect: false })
        .header,
    ).toBeUndefined();
  });

  it("carries multiSelect true through", () => {
    expect(decodeEnrichmentQuestion(question({ multiSelect: true })).multiSelect).toBe(true);
  });

  it("rejects a non-object / null / array", () => {
    expect(decodeEnrichmentQuestion(null)).toBeNull();
    expect(decodeEnrichmentQuestion("q")).toBeNull();
    expect(decodeEnrichmentQuestion([question()])).toBeNull();
  });

  it("rejects a blank questionId or prompt", () => {
    expect(decodeEnrichmentQuestion(question({ questionId: "" }))).toBeNull();
    expect(decodeEnrichmentQuestion(question({ prompt: "  " }))).toBeNull();
  });

  it("rejects a non-boolean multiSelect (absent or a string is drift, not a default here)", () => {
    // Absent: build the object directly — the fixture's `= false` default would mask an omitted field.
    // The summary wire is already core-normalized, so multiSelect is always a present boolean; requiring
    // it (unlike core, which defaults an absent one) is the correct client-side defensiveness.
    expect(decodeEnrichmentQuestion({ questionId: "q0", prompt: "Proceed?", options: [option()] })).toBeNull();
    expect(decodeEnrichmentQuestion(question({ multiSelect: "false" }))).toBeNull();
  });

  it("rejects a non-array / empty / over-long options list", () => {
    expect(decodeEnrichmentQuestion(question({ options: "x" }))).toBeNull();
    expect(decodeEnrichmentQuestion(question({ options: [] }))).toBeNull();
    const tooMany = Array.from({ length: MAX_ENRICHMENT_OPTIONS + 1 }, (_, i) => option({ label: `o${i}` }));
    expect(decodeEnrichmentQuestion(question({ options: tooMany }))).toBeNull();
  });

  it("accepts exactly MAX_ENRICHMENT_OPTIONS options (boundary)", () => {
    const atCap = Array.from({ length: MAX_ENRICHMENT_OPTIONS }, (_, i) => option({ label: `o${i}` }));
    expect(decodeEnrichmentQuestion(question({ options: atCap })).options).toHaveLength(MAX_ENRICHMENT_OPTIONS);
  });

  it("fails the whole question closed on any single malformed option (all-or-nothing)", () => {
    expect(decodeEnrichmentQuestion(question({ options: [option(), { description: "no label" }] }))).toBeNull();
  });
});

describe("decodeEnrichment", () => {
  it("accepts a well-formed enrichment and returns a fresh copy with fresh questions", () => {
    const wire = enrichment();
    const decoded = decodeEnrichment(wire);
    expect(decoded).toEqual({
      sequenceNum: 7,
      questions: [
        {
          questionId: "q0",
          prompt: "Proceed?",
          header: "Confirm",
          options: [
            { label: "Yes", description: "Proceed with the plan" },
            { label: "No", description: "Stop here" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(decoded).not.toBe(wire);
    expect(decoded.questions).not.toBe(wire.questions);
  });

  it("reads an absent / undefined enrichment as null (a session with no outstanding block)", () => {
    expect(decodeEnrichment(undefined)).toBeNull();
    expect(decodeEnrichment(null)).toBeNull();
  });

  it("rejects a non-object / array", () => {
    expect(decodeEnrichment("x")).toBeNull();
    expect(decodeEnrichment([enrichment()])).toBeNull();
  });

  it("rejects a sequenceNum that is not a non-negative safe integer", () => {
    expect(decodeEnrichment(enrichment({ sequenceNum: -1 }))).toBeNull();
    expect(decodeEnrichment(enrichment({ sequenceNum: 1.5 }))).toBeNull();
    expect(decodeEnrichment(enrichment({ sequenceNum: "7" }))).toBeNull();
    expect(decodeEnrichment(enrichment({ sequenceNum: Number.NaN }))).toBeNull();
  });

  it("accepts sequenceNum 0 (the first stamp of an epoch)", () => {
    expect(decodeEnrichment(enrichment({ sequenceNum: 0 })).sequenceNum).toBe(0);
  });

  it("rejects a non-array / empty / over-long questions list", () => {
    expect(decodeEnrichment(enrichment({ questions: "x" }))).toBeNull();
    expect(decodeEnrichment(enrichment({ questions: [] }))).toBeNull();
    const tooMany = Array.from({ length: MAX_ENRICHMENT_QUESTIONS + 1 }, (_, i) => question({ questionId: `q${i}` }));
    expect(decodeEnrichment(enrichment({ questions: tooMany }))).toBeNull();
  });

  it("fails the whole enrichment closed on any single malformed question (no positional renumber)", () => {
    expect(decodeEnrichment(enrichment({ questions: [question(), { questionId: "q1" }] }))).toBeNull();
  });
});

describe("enrichmentMatchesBlock (join-on-sequence_num, AC5)", () => {
  it("matches when the enrichment's sequenceNum equals the live block's", () => {
    expect(enrichmentMatchesBlock(decodeEnrichment(enrichment({ sequenceNum: 7 })), 7)).toBe(true);
  });

  it("discards a mismatch — turn-N options against turn-N+1's block", () => {
    expect(enrichmentMatchesBlock(decodeEnrichment(enrichment({ sequenceNum: 7 })), 8)).toBe(false);
  });

  it("discards when the block sequence is unknown (null / non-number — fail-safe toward blocking)", () => {
    const decoded = decodeEnrichment(enrichment({ sequenceNum: 7 }));
    expect(enrichmentMatchesBlock(decoded, null)).toBe(false);
    expect(enrichmentMatchesBlock(decoded, undefined)).toBe(false);
    expect(enrichmentMatchesBlock(decoded, "7")).toBe(false);
  });

  it("discards a null / undefined enrichment", () => {
    expect(enrichmentMatchesBlock(null, 7)).toBe(false);
    expect(enrichmentMatchesBlock(undefined, 7)).toBe(false);
  });
});

describe("submitsOnTap", () => {
  it("is true for exactly one single-select question (one tap decides, AC1)", () => {
    expect(submitsOnTap(decodeEnrichment(enrichment({ questions: [question({ multiSelect: false })] })))).toBe(true);
  });

  it("is false for a multi-select question (toggle + submit, AC2)", () => {
    expect(submitsOnTap(decodeEnrichment(enrichment({ questions: [question({ multiSelect: true })] })))).toBe(false);
  });

  it("is false for more than one question (a tap would answer only part of the envelope)", () => {
    const two = enrichment({ questions: [question({ questionId: "q0" }), question({ questionId: "q1" })] });
    expect(submitsOnTap(decodeEnrichment(two))).toBe(false);
  });

  it("is false for a null enrichment", () => {
    expect(submitsOnTap(null)).toBe(false);
  });
});

describe("answerFromSelections", () => {
  const single = decodeEnrichment(enrichment());
  const multi = decodeEnrichment(
    enrichment({
      questions: [
        question({
          questionId: "q0",
          multiSelect: true,
          options: [option({ label: "A" }), option({ label: "B" }), option({ label: "C" })],
        }),
      ],
    }),
  );
  const twoQuestions = decodeEnrichment(
    enrichment({
      questions: [
        question({ questionId: "q0", options: [option({ label: "Yes" }), option({ label: "No" })] }),
        question({ questionId: "q1", options: [option({ label: "Left" }), option({ label: "Right" })] }),
      ],
    }),
  );

  it("builds the answers map for a valid single-select selection", () => {
    expect(answerFromSelections(single, { q0: ["Yes"] })).toEqual({ q0: ["Yes"] });
  });

  it("builds the answers map for a valid multi-select selection (>= 1 label)", () => {
    expect(answerFromSelections(multi, { q0: ["A", "C"] })).toEqual({ q0: ["A", "C"] });
    expect(answerFromSelections(multi, { q0: ["B"] })).toEqual({ q0: ["B"] });
  });

  it("requires every question answered (server consumes the enrichment whole, #86)", () => {
    expect(answerFromSelections(twoQuestions, { q0: ["Yes"] })).toBeNull();
    expect(answerFromSelections(twoQuestions, { q0: ["Yes"], q1: ["Left"] })).toEqual({ q0: ["Yes"], q1: ["Left"] });
  });

  it("rejects a single-select answered with other than exactly one label (cardinality)", () => {
    expect(answerFromSelections(single, { q0: [] })).toBeNull();
    expect(answerFromSelections(single, { q0: ["Yes", "No"] })).toBeNull();
  });

  it("rejects a multi-select answered with an empty selection", () => {
    expect(answerFromSelections(multi, { q0: [] })).toBeNull();
  });

  it("rejects a label the question never offered (bounded selection, #86)", () => {
    expect(answerFromSelections(single, { q0: ["Maybe"] })).toBeNull();
  });

  it("rejects a repeated label (a choice is a set)", () => {
    expect(answerFromSelections(multi, { q0: ["A", "A"] })).toBeNull();
  });

  it("ignores an extra selection key not in the enrichment (the enrichment defines the questions)", () => {
    expect(answerFromSelections(single, { q0: ["Yes"], q9: ["Nope"] })).toEqual({ q0: ["Yes"] });
  });

  it("returns fresh label arrays (no aliasing of the selection input)", () => {
    const selections = { q0: ["Yes"] };
    const answer = answerFromSelections(single, selections);
    expect(answer.q0).not.toBe(selections.q0);
  });

  it("rejects a null enrichment or a non-object selections", () => {
    expect(answerFromSelections(null, { q0: ["Yes"] })).toBeNull();
    expect(answerFromSelections(single, null)).toBeNull();
    expect(answerFromSelections(single, [["Yes"]])).toBeNull();
  });
});
