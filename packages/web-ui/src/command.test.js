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
  inputCommand,
  approveCommand,
  redirectCommand,
  describeCommand,
} from "./command.js";

describe("wire constants", () => {
  it("pins the sessions path and the three steer subtypes to the server contract", () => {
    expect(SESSIONS_PATH).toBe("/api/sessions");
    expect(INPUT_SUBTYPE).toBe("prompt");
    expect(APPROVE_SUBTYPE).toBe("approve");
    expect(REDIRECT_SUBTYPE).toBe("interrupt");
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

describe("describeCommand", () => {
  it("summarizes each verb by its salient payload field", () => {
    expect(describeCommand(inputCommand("hi there"))).toBe("hi there");
    expect(describeCommand(redirectCommand("halt"))).toBe("halt");
    expect(describeCommand(approveCommand("tool-9"))).toBe("tool-9");
  });

  it("summarizes a payload-less approve to the empty string", () => {
    expect(describeCommand(approveCommand())).toBe("");
  });
});
