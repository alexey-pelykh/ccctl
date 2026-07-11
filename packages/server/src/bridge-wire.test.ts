// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { WorkItem } from "@ccctl/core";
import {
  parseEnvironmentRegisterBody,
  parseSessionCreateBody,
  toEnvironmentRegisterResponseWire,
  toWorkPollResponseWire,
} from "./bridge-wire.js";

describe("parseEnvironmentRegisterBody (§1 request, snake_case → core, fail closed)", () => {
  const wire = {
    machine_id: "machine-1",
    directory: "/home/dev/proj",
    branch: "main",
    repository: "owner/repo",
    max_sessions: 4,
  };

  it("maps a well-formed snake_case body to core's camelCase shape", () => {
    expect(parseEnvironmentRegisterBody(wire)).toEqual({
      machineId: "machine-1",
      directory: "/home/dev/proj",
      branch: "main",
      repository: "owner/repo",
      maxSessions: 4,
    });
  });

  it("fails closed (null) on a non-object", () => {
    expect(parseEnvironmentRegisterBody(null)).toBeNull();
    expect(parseEnvironmentRegisterBody("nope")).toBeNull();
    expect(parseEnvironmentRegisterBody([])).toBeNull();
  });

  it("fails closed on a missing or mistyped string field", () => {
    for (const key of ["machine_id", "directory", "branch", "repository"]) {
      expect(parseEnvironmentRegisterBody({ ...wire, [key]: undefined })).toBeNull();
      expect(parseEnvironmentRegisterBody({ ...wire, [key]: 42 })).toBeNull();
    }
  });

  it("fails closed on a max_sessions that is not a positive integer", () => {
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: 0 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: -1 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: 1.5 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: "4" })).toBeNull();
  });
});

describe("toEnvironmentRegisterResponseWire (§1 response, core → snake_case)", () => {
  it("serializes an environment id + scoped token to the exact snake_case body", () => {
    const wire = toEnvironmentRegisterResponseWire("env-1", "scoped-token-xyz");
    expect(wire).toEqual({ environment_id: "env-1", work_poll_token: "scoped-token-xyz" });
    expect(Object.keys(wire)).toEqual(["environment_id", "work_poll_token"]);
  });
});

describe("parseSessionCreateBody (§2 request, snake_case → core, fail closed)", () => {
  const wire = {
    context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
    source: "ui",
    permission_mode: "default",
  };

  it("maps a well-formed body to core's camelCase shape (permission_mode → permissionMode)", () => {
    expect(parseSessionCreateBody(wire)).toEqual({
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permissionMode: "default",
    });
  });

  it("accepts every pinned permission mode", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"]) {
      expect(parseSessionCreateBody({ ...wire, permission_mode: mode })?.permissionMode).toBe(mode);
    }
  });

  it("fails closed on an unknown permission_mode (drift)", () => {
    expect(parseSessionCreateBody({ ...wire, permission_mode: "yolo" })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, permission_mode: undefined })).toBeNull();
  });

  it("fails closed on a missing/blank source or a malformed context", () => {
    expect(parseSessionCreateBody({ ...wire, source: "" })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, source: 1 })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, context: null })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, context: { model: "m" } })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, context: { model: "", cwd: "/x" } })).toBeNull();
  });

  it("fails closed on a non-object", () => {
    expect(parseSessionCreateBody(null)).toBeNull();
    expect(parseSessionCreateBody([])).toBeNull();
  });
});

describe("toWorkPollResponseWire (§3 delivery)", () => {
  it("wraps a work batch in { work } (work-item fields are already the wire shape)", () => {
    const items: WorkItem[] = [
      { kind: "user_turn", id: "w-1", payload: { text: "hello" } },
      { kind: "steer", id: "w-2" },
    ];
    expect(toWorkPollResponseWire(items)).toEqual({ work: items });
    expect(toWorkPollResponseWire([])).toEqual({ work: [] });
  });
});
