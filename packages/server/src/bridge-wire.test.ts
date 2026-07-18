// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { PERMISSION_MODES, type WorkItem } from "@ccctl/core";
import {
  parseEnvironmentRegisterBody,
  parseSessionCreateBody,
  toEnvironmentRegisterResponseWire,
  toWorkItemWire,
} from "./bridge-wire.js";

describe("parseEnvironmentRegisterBody (§1 request, snake_case → core, fail closed)", () => {
  const wire = {
    machine_name: "dev-laptop",
    directory: "/home/dev/proj",
    branch: "main",
    git_repo_url: "https://github.com/owner/repo.git",
    max_sessions: 4,
    metadata: { worker_type: "claude_code" },
  };

  it("maps a well-formed snake_case body to core's camelCase shape", () => {
    expect(parseEnvironmentRegisterBody(wire)).toEqual({
      machineName: "dev-laptop",
      directory: "/home/dev/proj",
      branch: "main",
      gitRepoUrl: "https://github.com/owner/repo.git",
      maxSessions: 4,
      metadata: { worker_type: "claude_code" },
    });
  });

  it("accepts a null git_repo_url (the field is nullable, #130)", () => {
    expect(parseEnvironmentRegisterBody({ ...wire, git_repo_url: null })?.gitRepoUrl).toBeNull();
  });

  it("fails closed (null) on a non-object", () => {
    expect(parseEnvironmentRegisterBody(null)).toBeNull();
    expect(parseEnvironmentRegisterBody("nope")).toBeNull();
    expect(parseEnvironmentRegisterBody([])).toBeNull();
  });

  it("fails closed on a missing or mistyped required string field", () => {
    for (const key of ["machine_name", "directory", "branch"]) {
      expect(parseEnvironmentRegisterBody({ ...wire, [key]: undefined })).toBeNull();
      expect(parseEnvironmentRegisterBody({ ...wire, [key]: 42 })).toBeNull();
    }
    // machine_name must be non-empty (it keys the environment for a human).
    expect(parseEnvironmentRegisterBody({ ...wire, machine_name: "" })).toBeNull();
  });

  it("fails closed on a git_repo_url that is neither a string nor null", () => {
    expect(parseEnvironmentRegisterBody({ ...wire, git_repo_url: 42 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, git_repo_url: undefined })).toBeNull();
  });

  it("fails closed on a metadata that is not a JSON object", () => {
    expect(parseEnvironmentRegisterBody({ ...wire, metadata: null })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, metadata: [] })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, metadata: "x" })).toBeNull();
  });

  it("fails closed on a max_sessions that is not a positive integer", () => {
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: 0 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: -1 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: 1.5 })).toBeNull();
    expect(parseEnvironmentRegisterBody({ ...wire, max_sessions: "4" })).toBeNull();
  });
});

describe("toEnvironmentRegisterResponseWire (§1 response, core → snake_case)", () => {
  it("serializes an environment id to the exact snake_case body (no work-poll token, #130)", () => {
    const wire = toEnvironmentRegisterResponseWire("env-1");
    expect(wire).toEqual({ environment_id: "env-1" });
    expect(Object.keys(wire)).toEqual(["environment_id"]);
    expect(wire).not.toHaveProperty("work_poll_token");
  });
});

describe("parseSessionCreateBody (§2 request, snake_case → core, fail closed)", () => {
  // The context is carried under `session_context` — the field the observed worker
  // actually sends (issue #154); the mapper still projects it to core's internal `context`.
  const wire = {
    session_context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
    source: "ui",
    permission_mode: "default",
  };

  it("maps a well-formed body to core's camelCase shape (session_context → context, permission_mode → permissionMode)", () => {
    expect(parseSessionCreateBody(wire)).toEqual({
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permissionMode: "default",
    });
  });

  it("accepts every pinned permission mode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(parseSessionCreateBody({ ...wire, permission_mode: mode })?.permissionMode).toBe(mode);
    }
  });

  it("reads session_context and IGNORES the worker's extra keys — sources / outcomes / reuse_outcome_branches inside it, and a top-level environment_id (#154)", () => {
    const observed = {
      session_context: {
        model: "claude-opus-4-8",
        cwd: "/home/dev/proj",
        sources: [{ kind: "git", url: "https://example.test/repo.git" }],
        outcomes: ["merge"],
        reuse_outcome_branches: true,
      },
      environment_id: "env-abc",
      source: "ui",
      permission_mode: "default",
    };
    // Only model + cwd are load-bearing; every extra key is accepted and dropped.
    expect(parseSessionCreateBody(observed)).toEqual({
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permissionMode: "default",
    });
  });

  it("fails closed on the SUPERSEDED `context` field — the worker sends `session_context` now (#154)", () => {
    // A body carrying the old top-level `context` but no `session_context` is drift → null.
    const superseded = {
      context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
      source: "ui",
      permission_mode: "default",
    };
    expect(parseSessionCreateBody(superseded)).toBeNull();
  });

  it("fails closed on an unknown permission_mode (drift)", () => {
    expect(parseSessionCreateBody({ ...wire, permission_mode: "yolo" })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, permission_mode: undefined })).toBeNull();
  });

  it("fails closed on a missing/blank source or a malformed session_context", () => {
    expect(parseSessionCreateBody({ ...wire, source: "" })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, source: 1 })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, session_context: null })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, session_context: { model: "m" } })).toBeNull();
    expect(parseSessionCreateBody({ ...wire, session_context: { model: "", cwd: "/x" } })).toBeNull();
  });

  it("fails closed on a non-object", () => {
    expect(parseSessionCreateBody(null)).toBeNull();
    expect(parseSessionCreateBody([])).toBeNull();
  });
});

describe("toWorkItemWire (§3 single-item delivery, #130)", () => {
  it("serializes a session item carrying its session id in data.id", () => {
    const item: WorkItem = { id: "w-1", secret: "base64url-secret", data: { type: "session", id: "sess-1" } };
    expect(toWorkItemWire(item)).toEqual({
      id: "w-1",
      secret: "base64url-secret",
      data: { type: "session", id: "sess-1" },
    });
  });

  it("serializes a healthcheck item with no data.id", () => {
    const item: WorkItem = { id: "w-2", secret: "base64url-secret", data: { type: "healthcheck" } };
    const wire = toWorkItemWire(item);
    expect(wire).toEqual({ id: "w-2", secret: "base64url-secret", data: { type: "healthcheck" } });
    expect(wire.data).not.toHaveProperty("id");
  });

  it("is a single object, never a { work: [...] } envelope (#130)", () => {
    const wire = toWorkItemWire({ id: "w-1", secret: "s", data: { type: "session", id: "sess-1" } });
    expect(wire).not.toHaveProperty("work");
    expect(Object.keys(wire)).toEqual(["id", "secret", "data"]);
  });
});
