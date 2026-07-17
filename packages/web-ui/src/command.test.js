// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  SESSIONS_PATH,
  sessionEventsPath,
  sessionCommandPath,
  INPUT_SUBTYPE,
  APPROVE_SUBTYPE,
  REDIRECT_SUBTYPE,
  ANSWER_SUBTYPE,
  inputCommand,
  approveCommand,
  redirectCommand,
  answerCommand,
  describeCommand,
} from "./command.js";

describe("wire constants", () => {
  it("pins the sessions path and the three steer subtypes to the server contract", () => {
    expect(SESSIONS_PATH).toBe("/api/sessions");
    expect(INPUT_SUBTYPE).toBe("prompt");
    expect(APPROVE_SUBTYPE).toBe("approve");
    expect(REDIRECT_SUBTYPE).toBe("interrupt");
    expect(ANSWER_SUBTYPE).toBe("answer");
  });

  it("builds per-session view + steer paths that address exactly one session (#20)", () => {
    expect(sessionEventsPath("sess-42")).toBe("/api/sessions/sess-42/events");
    expect(sessionCommandPath("sess-42")).toBe("/api/sessions/sess-42/command");
  });
});

describe("inputCommand", () => {
  it("builds a prompt steer carrying the trimmed text", () => {
    expect(inputCommand("continue please")).toEqual({ subtype: "prompt", payload: { text: "continue please" } });
    expect(inputCommand("  keep going  ")).toEqual({ subtype: "prompt", payload: { text: "keep going" } });
  });

  it("returns null for blank or non-string text, so the caller no-ops", () => {
    expect(inputCommand("")).toBeNull();
    expect(inputCommand("   ")).toBeNull();
    expect(inputCommand(undefined)).toBeNull();
    expect(inputCommand(42)).toBeNull();
  });
});

describe("redirectCommand", () => {
  it("builds an interrupt steer carrying the trimmed reason", () => {
    expect(redirectCommand("stop, do X instead")).toEqual({
      subtype: "interrupt",
      payload: { reason: "stop, do X instead" },
    });
    expect(redirectCommand("  rethink  ")).toEqual({ subtype: "interrupt", payload: { reason: "rethink" } });
  });

  it("returns null for a blank or non-string reason", () => {
    expect(redirectCommand("")).toBeNull();
    expect(redirectCommand("   ")).toBeNull();
    expect(redirectCommand(null)).toBeNull();
  });
});

describe("approveCommand", () => {
  it("approves the pending action with no payload when no tool-use id is known", () => {
    expect(approveCommand()).toEqual({ subtype: "approve" });
    expect(approveCommand("")).toEqual({ subtype: "approve" });
    expect(approveCommand("   ")).toEqual({ subtype: "approve" });
  });

  it("carries the trimmed toolUseId when one is provided", () => {
    expect(approveCommand("tool-42")).toEqual({ subtype: "approve", payload: { toolUseId: "tool-42" } });
    expect(approveCommand("  tool-7 ")).toEqual({ subtype: "approve", payload: { toolUseId: "tool-7" } });
  });
});

describe("answerCommand (#86: the answer-envelope encode half)", () => {
  it("builds an answer carrying the selected labels keyed by question + the sequence_num decision-id", () => {
    expect(answerCommand(5, { q0: ["Yes"] })).toEqual({
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 5 },
    });
  });

  it("round-trips ALL labels of a multi-select selection (AC: multi-select)", () => {
    expect(answerCommand(2, { q0: ["lint", "build"], q1: ["fast"] })).toEqual({
      subtype: "answer",
      payload: { answers: { q0: ["lint", "build"], q1: ["fast"] }, sequence_num: 2 },
    });
  });

  it("accepts sequence_num 0 — a valid #201 stamp", () => {
    expect(answerCommand(0, { q0: ["Yes"] })).toEqual({
      subtype: "answer",
      payload: { answers: { q0: ["Yes"] }, sequence_num: 0 },
    });
  });

  it("returns null without a usable decision-id — a non-negative safe integer (the freshness token is required)", () => {
    expect(answerCommand(undefined, { q0: ["Yes"] })).toBeNull();
    expect(answerCommand(-1, { q0: ["Yes"] })).toBeNull();
    expect(answerCommand(1.5, { q0: ["Yes"] })).toBeNull();
    expect(answerCommand("5", { q0: ["Yes"] })).toBeNull();
  });

  it("returns null for an answers value that is not a non-empty map", () => {
    expect(answerCommand(5, null)).toBeNull();
    expect(answerCommand(5, [])).toBeNull();
    expect(answerCommand(5, {})).toBeNull();
    expect(answerCommand(5, "Yes")).toBeNull();
  });

  it("refuses a bare-string selection — the uniform array shape AnswerEnvelope demands (never coerced)", () => {
    expect(answerCommand(5, { q0: "Yes" })).toBeNull();
    expect(answerCommand(5, { q0: [] })).toBeNull();
    expect(answerCommand(5, { q0: ["", "  "] })).toBeNull();
    expect(answerCommand(5, { q0: [42] })).toBeNull();
  });
});

describe("describeCommand", () => {
  it("summarizes each verb by its salient payload field", () => {
    expect(describeCommand(inputCommand("hi there"))).toBe("hi there");
    expect(describeCommand(redirectCommand("halt"))).toBe("halt");
    expect(describeCommand(approveCommand("tool-9"))).toBe("tool-9");
  });

  it("summarizes an answer (#86) by its chosen labels, across questions", () => {
    expect(describeCommand(answerCommand(3, { q0: ["Yes"] }))).toBe("Yes");
    expect(describeCommand(answerCommand(3, { q0: ["A", "B"], q1: ["Left"] }))).toBe("A, B, Left");
  });

  it("summarizes a payload-less approve to the empty string", () => {
    expect(describeCommand(approveCommand())).toBe("");
  });
});
