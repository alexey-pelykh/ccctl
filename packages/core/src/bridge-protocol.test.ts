// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  AccountBearer,
  applyWorkerStatus,
  BRIDGE_PROTOCOL_API_VERSION,
  createSession,
  decodeControlFrame,
  encodeControlFrame,
  environmentWorkPollPath,
  ENVIRONMENTS_BRIDGE_PATH,
  isPermissionMode,
  isWorkerStatus,
  isWorkerStatusEvent,
  isWorkItemType,
  loggableEnvironmentRegisterRequest,
  loggableSessionCreateRequest,
  parseWorkSecret,
  PERMISSION_MODES,
  sessionActivityFromStatus,
  sessionIngressToken,
  SESSIONS_PATH,
  WORK_ITEM_TYPES,
  WORK_SECRET_VERSION,
  workerChannelPath,
  workerEventsDeliveryPath,
  workerEventsPath,
  workerEventsStreamPath,
  workerHeartbeatPath,
  workerRegisterPath,
  workItemFromValue,
  workerStatusFromFrame,
  type ControlEvent,
  type ControlFrame,
  type EnvironmentRegisterRequest,
  type EnvironmentRegisterResponse,
  type SessionCreateRequest,
  type SessionCreateResponse,
  type WorkerStatus,
  type WorkerStatusEvent,
  type WorkItem,
  type WorkItemType,
  type WorkSecret,
} from "./index.js";

describe("version pin & pinned paths (AC: version-pinned)", () => {
  it("pins the bridge-protocol API version", () => {
    expect(BRIDGE_PROTOCOL_API_VERSION).toBe("v1");
  });

  it("pins the §1 environment-register and §2 session-create paths", () => {
    expect(ENVIRONMENTS_BRIDGE_PATH).toBe("/v1/environments/bridge");
    expect(SESSIONS_PATH).toBe("/v1/sessions");
  });

  it("builds the §3 work-poll path under the environment (no ack/stop — reclaim model)", () => {
    expect(environmentWorkPollPath("env-1")).toBe("/v1/environments/env-1/work/poll");
  });

  it("builds the §4/§5 per-session worker-channel paths under /v1/code/sessions/{id}/worker", () => {
    expect(workerChannelPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker");
    expect(workerRegisterPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker/register");
    expect(workerEventsStreamPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker/events/stream");
    expect(workerEventsPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker/events");
    expect(workerEventsDeliveryPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker/events/delivery");
    expect(workerHeartbeatPath("sess-1")).toBe("/v1/code/sessions/sess-1/worker/heartbeat");
  });
});

describe("AccountBearer (AC: account-Bearer credential class, omit-by-construction #60)", () => {
  const raw = "oauth-account-secret-abc123";

  it("yields the raw token only through reveal()", () => {
    expect(new AccountBearer(raw).reveal()).toBe(raw);
  });

  it("never serializes the token under JSON.stringify, even when nested", () => {
    const bearer = new AccountBearer(raw);
    expect(JSON.stringify(bearer)).not.toContain(raw);
    expect(JSON.stringify({ authorization: bearer })).not.toContain(raw);
    expect(JSON.parse(JSON.stringify({ authorization: bearer }))).toEqual({
      authorization: AccountBearer.REDACTED,
    });
  });

  it("redacts under string coercion and interpolation", () => {
    const bearer = new AccountBearer(raw);
    expect(String(bearer)).toBe(AccountBearer.REDACTED);
    expect(`${bearer}`).not.toContain(raw);
  });

  it("exposes no enumerable property carrying the token", () => {
    const bearer = new AccountBearer(raw);
    expect(Object.keys(bearer)).toHaveLength(0);
    expect(Object.values(bearer)).not.toContain(raw);
  });
});

describe("SessionIngressToken (AC: the §4/§5 credential is NOT the account Bearer)", () => {
  it("brands a raw string and keeps it a JSON-safe wire value", () => {
    const token = sessionIngressToken("ingress-secret-xyz");
    expect(token).toBe("ingress-secret-xyz");
    // Unlike the account Bearer, a session-scoped token legitimately travels on the wire.
    expect(JSON.stringify({ session_ingress_token: token })).toContain("ingress-secret-xyz");
  });
});

describe("§1 environment register", () => {
  it("loggable projection drops the Bearer and keeps the JSON body (machine_name, git_repo_url, metadata)", () => {
    const request: EnvironmentRegisterRequest = {
      authorization: new AccountBearer("oauth-account-secret-xyz"),
      body: {
        machineName: "machine-1",
        directory: "/home/dev/proj",
        branch: "main",
        gitRepoUrl: "git@github.com:acme/proj.git",
        maxSessions: 4,
        metadata: { worker_type: "claude_code" },
      },
    };
    const loggable = loggableEnvironmentRegisterRequest(request);
    expect(loggable).toEqual(request.body);
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-xyz");
  });

  it("accepts a null git_repo_url (no remote)", () => {
    const body = {
      machineName: "machine-2",
      directory: "/tmp/proj",
      branch: "wip",
      gitRepoUrl: null,
      maxSessions: 1,
      metadata: { worker_type: "claude_code" },
    };
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("response round-trips as plain JSON (an environment id, no token)", () => {
    const response: EnvironmentRegisterResponse = { environmentId: "env-1" };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(Object.keys(response)).toEqual(["environmentId"]);
  });
});

describe("§2 session create", () => {
  it("loggable projection drops the Bearer and keeps the JSON body", () => {
    const request: SessionCreateRequest = {
      authorization: new AccountBearer("oauth-account-secret-create"),
      body: {
        context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
        source: "ui",
        permissionMode: "default",
      },
    };
    const loggable = loggableSessionCreateRequest(request);
    expect(loggable).toEqual(request.body);
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-create");
  });

  it("response round-trips as plain JSON (session id ONLY — no ws_url)", () => {
    const response: SessionCreateResponse = { sessionId: "sess-1" };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(Object.keys(response)).toEqual(["sessionId"]);
  });

  it("isPermissionMode accepts exactly the pinned modes and fails closed on drift", () => {
    for (const mode of PERMISSION_MODES) {
      expect(isPermissionMode(mode)).toBe(true);
    }
    expect(PERMISSION_MODES).toEqual(["default", "acceptEdits", "bypassPermissions", "plan"]);
    expect(isPermissionMode("yolo")).toBe(false);
    expect(isPermissionMode(42)).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
  });
});

describe("§3 work poll — single item, secret, fail-closed drift", () => {
  const types: readonly WorkItemType[] = ["healthcheck", "session"];

  it("isWorkItemType accepts exactly the two types and fails closed on drift", () => {
    expect(WORK_ITEM_TYPES).toEqual(types);
    for (const type of types) {
      expect(isWorkItemType(type)).toBe(true);
    }
    expect(isWorkItemType("create_session")).toBe(false);
    expect(isWorkItemType(7)).toBe(false);
    expect(isWorkItemType(undefined)).toBe(false);
  });

  it("workItemFromValue parses a session item, preserving id, secret, and data.id", () => {
    const parsed = workItemFromValue({ id: "work-1", secret: "c2VjcmV0", data: { type: "session", id: "sess-1" } });
    expect(parsed).toEqual({ id: "work-1", secret: "c2VjcmV0", data: { type: "session", id: "sess-1" } });
  });

  it("workItemFromValue parses a healthcheck item (no session id)", () => {
    const parsed = workItemFromValue({ id: "work-2", secret: "c2VjcmV0", data: { type: "healthcheck" } });
    expect(parsed).toEqual({ id: "work-2", secret: "c2VjcmV0", data: { type: "healthcheck" } });
    expect(parsed !== null && "id" in parsed.data).toBe(false);
  });

  it("workItemFromValue fails closed (null) on a session item missing its data.id", () => {
    expect(workItemFromValue({ id: "w", secret: "s", data: { type: "session" } })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "s", data: { type: "session", id: "" } })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "s", data: { type: "session", id: 7 } })).toBeNull();
  });

  it("workItemFromValue fails closed (null) on an unknown data.type (drift)", () => {
    expect(workItemFromValue({ id: "w", secret: "s", data: { type: "create_session", id: "x" } })).toBeNull();
  });

  it("workItemFromValue fails closed (null) on a missing/blank id or secret, or a non-object data", () => {
    expect(workItemFromValue({ secret: "s", data: { type: "healthcheck" } })).toBeNull();
    expect(workItemFromValue({ id: "", secret: "s", data: { type: "healthcheck" } })).toBeNull();
    expect(workItemFromValue({ id: "w", data: { type: "healthcheck" } })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "", data: { type: "healthcheck" } })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "s" })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "s", data: null })).toBeNull();
    expect(workItemFromValue({ id: "w", secret: "s", data: [1] })).toBeNull();
  });

  it("workItemFromValue fails closed (null) on a non-object / array top level", () => {
    expect(workItemFromValue(null)).toBeNull();
    expect(workItemFromValue(undefined)).toBeNull();
    expect(workItemFromValue("session")).toBeNull();
    expect(workItemFromValue([{ id: "w", secret: "s", data: { type: "healthcheck" } }])).toBeNull();
  });

  it("a parsed work item's data.type narrows exhaustively (discriminated union)", () => {
    const parsed: WorkItem | null = workItemFromValue({
      id: "work-4",
      secret: "s",
      data: { type: "session", id: "sess-9" },
    });
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      let label: string;
      switch (parsed.data.type) {
        case "healthcheck":
          label = "health";
          break;
        case "session":
          label = "session";
          break;
        default: {
          const unreachable: never = parsed.data.type;
          label = unreachable;
        }
      }
      expect(label).toBe("session");
    }
  });

  it("parseWorkSecret accepts a well-formed secret (both inner fields present) and pins the version", () => {
    expect(WORK_SECRET_VERSION).toBe(1);
    const secret: WorkSecret = {
      version: 1,
      session_ingress_token: "ingress-secret",
      api_base_url: "http://127.0.0.1:8787",
    };
    expect(parseWorkSecret(secret)).toEqual(secret);
    // The exact JSON a base64url decode yields also parses.
    expect(parseWorkSecret(JSON.parse(JSON.stringify(secret)))).toEqual(secret);
  });

  it("parseWorkSecret fails closed (null) on a version drift or a missing inner field", () => {
    expect(parseWorkSecret({ version: 2, session_ingress_token: "t", api_base_url: "u" })).toBeNull();
    expect(parseWorkSecret({ version: 1, api_base_url: "u" })).toBeNull();
    expect(parseWorkSecret({ version: 1, session_ingress_token: "", api_base_url: "u" })).toBeNull();
    expect(parseWorkSecret({ version: 1, session_ingress_token: "t" })).toBeNull();
    expect(parseWorkSecret({ version: 1, session_ingress_token: "t", api_base_url: "" })).toBeNull();
    expect(parseWorkSecret(null)).toBeNull();
    expect(parseWorkSecret("secret")).toBeNull();
    expect(parseWorkSecret([1])).toBeNull();
  });
});

describe("worker_status frames + PUT status gate (§4/§5 per-session status)", () => {
  const statuses: readonly WorkerStatus[] = ["running", "requires_action", "idle"];

  it("isWorkerStatus accepts exactly the three derived states", () => {
    for (const status of statuses) {
      expect(isWorkerStatus(status)).toBe(true);
    }
    expect(isWorkerStatus("busy")).toBe(false);
    expect(isWorkerStatus(42)).toBe(false);
    expect(isWorkerStatus(undefined)).toBe(false);
    expect(isWorkerStatus(null)).toBe(false);
  });

  const statusEvent: WorkerStatusEvent = {
    type: "control_event",
    subtype: "worker_status",
    payload: { status: "requires_action" },
  };

  it("recognizes a worker_status event and derives its status", () => {
    expect(isWorkerStatusEvent(statusEvent)).toBe(true);
    expect(workerStatusFromFrame(statusEvent)).toBe("requires_action");
  });

  it("rejects other control frames", () => {
    const otherEvent: ControlEvent = { type: "control_event", subtype: "message", payload: {} };
    const request: ControlFrame = { type: "control_request", id: "r-1", subtype: "prompt" };
    expect(isWorkerStatusEvent(otherEvent)).toBe(false);
    expect(workerStatusFromFrame(otherEvent)).toBeNull();
    expect(workerStatusFromFrame(request)).toBeNull();
  });

  it("fails closed on a worker_status frame with an unknown or absent status", () => {
    const unknownStatus: ControlFrame = {
      type: "control_event",
      subtype: "worker_status",
      payload: { status: "paused" },
    };
    const noPayload: ControlFrame = { type: "control_event", subtype: "worker_status" };
    expect(isWorkerStatusEvent(unknownStatus)).toBe(false);
    expect(workerStatusFromFrame(unknownStatus)).toBeNull();
    expect(isWorkerStatusEvent(noPayload)).toBe(false);
    expect(workerStatusFromFrame(noPayload)).toBeNull();
  });

  it("rides the existing NDJSON codec unchanged (round-trips through encode/decode)", () => {
    const decoded = decodeControlFrame(encodeControlFrame(statusEvent));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(isWorkerStatusEvent(decoded.frame)).toBe(true);
      expect(workerStatusFromFrame(decoded.frame)).toBe("requires_action");
    }
  });

  it("sessionActivityFromStatus derives the activity the PUT status gate folds in", () => {
    expect(sessionActivityFromStatus("running")).toEqual({ kind: "running" });
    expect(sessionActivityFromStatus("idle")).toEqual({ kind: "idle" });
    expect(sessionActivityFromStatus("requires_action")).toEqual({
      kind: "requires_action",
      detail: "Awaiting input.",
    });
    expect(sessionActivityFromStatus("requires_action", "Approve the edit?")).toEqual({
      kind: "requires_action",
      detail: "Approve the edit?",
    });
  });

  it("applyWorkerStatus folds a PUT status into a NEW session (idle = ready for a turn), never mutating the input", () => {
    const session = createSession("sess-1", 1_000);
    const running = applyWorkerStatus(session, "running", undefined, 2_000);
    expect(running).not.toBe(session);
    expect(session.activity).toEqual({ kind: "idle" }); // input untouched
    expect(running.activity).toEqual({ kind: "running" });
    expect(running.lastActivityAt).toBe(2_000);

    const idle = applyWorkerStatus(running, "idle", undefined, 3_000);
    expect(idle.activity).toEqual({ kind: "idle" });
    expect(idle.lastActivityAt).toBe(3_000);
  });
});
