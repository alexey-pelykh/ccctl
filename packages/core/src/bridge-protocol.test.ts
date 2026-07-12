// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  AccountBearer,
  BRIDGE_PROTOCOL_API_VERSION,
  decodeControlFrame,
  encodeControlFrame,
  environmentToken,
  environmentWorkPollPath,
  ENVIRONMENTS_BRIDGE_PATH,
  isPermissionMode,
  isWorkerStatus,
  isWorkerStatusEvent,
  isWorkItemKind,
  loggableEnvironmentRegisterRequest,
  loggableSessionCreateRequest,
  loggableWorkerChannelConnect,
  loggableWorkItemAction,
  loggableWorkPoll,
  PERMISSION_MODES,
  SESSIONS_PATH,
  workAckPath,
  WORK_ITEM_KINDS,
  workItemFromValue,
  workerStatusFromFrame,
  workStopPath,
  type ControlEvent,
  type ControlFrame,
  type EnvironmentRegisterRequest,
  type EnvironmentRegisterResponse,
  type SessionCreateRequest,
  type SessionCreateResponse,
  type WorkerChannelConnect,
  type WorkerStatus,
  type WorkerStatusEvent,
  type WorkItem,
  type WorkItemAction,
  type WorkItemKind,
  type WorkPollRequest,
} from "./index.js";

describe("version pin & pinned paths (AC: version-pinned)", () => {
  it("pins the bridge-protocol API version", () => {
    expect(BRIDGE_PROTOCOL_API_VERSION).toBe("v1");
  });

  it("pins the §1 environment-register and §2 session-create paths", () => {
    expect(ENVIRONMENTS_BRIDGE_PATH).toBe("/v1/environments/bridge");
    expect(SESSIONS_PATH).toBe("/v1/sessions");
  });

  it("builds the §3 work-poll / ack / stop paths under the environment", () => {
    expect(environmentWorkPollPath("env-1")).toBe("/v1/environments/env-1/work/poll");
    expect(workAckPath("env-1", "work-9")).toBe("/v1/environments/env-1/work/work-9/ack");
    expect(workStopPath("env-1", "work-9")).toBe("/v1/environments/env-1/work/work-9/stop");
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

describe("§1 environment register", () => {
  it("loggable projection drops the Bearer and keeps the JSON body", () => {
    const request: EnvironmentRegisterRequest = {
      authorization: new AccountBearer("oauth-account-secret-xyz"),
      body: {
        machineId: "machine-1",
        directory: "/home/dev/proj",
        branch: "main",
        repository: "acme/proj",
        maxSessions: 4,
      },
    };
    const loggable = loggableEnvironmentRegisterRequest(request);
    expect(loggable).toEqual(request.body);
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-xyz");
  });

  it("response round-trips as plain JSON (an environment id)", () => {
    const response: EnvironmentRegisterResponse = { environmentId: "env-1" };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
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

  it("response round-trips as plain JSON (session id + ws_url)", () => {
    const response: SessionCreateResponse = {
      sessionId: "sess-1",
      wsUrl: "wss://127.0.0.1:8787/v1/sessions/sess-1/ws",
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
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

describe("§3 work poll — credential class & fail-closed drift", () => {
  const kinds: readonly WorkItemKind[] = ["create_session", "resume_session", "user_turn", "steer"];

  it("isWorkItemKind accepts exactly the four kinds and fails closed on drift", () => {
    expect(WORK_ITEM_KINDS).toEqual(kinds);
    for (const kind of kinds) {
      expect(isWorkItemKind(kind)).toBe(true);
    }
    expect(isWorkItemKind("compact")).toBe(false);
    expect(isWorkItemKind(7)).toBe(false);
    expect(isWorkItemKind(undefined)).toBe(false);
  });

  it("workItemFromValue parses each well-formed kind, preserving id, kind, and payload", () => {
    for (const kind of kinds) {
      const parsed = workItemFromValue({ kind, id: "work-1", payload: { note: "x" } });
      expect(parsed).toEqual({ kind, id: "work-1", payload: { note: "x" } });
    }
  });

  it("workItemFromValue accepts a payload-less item and omits the key", () => {
    const parsed = workItemFromValue({ kind: "steer", id: "work-2" });
    expect(parsed).toEqual({ kind: "steer", id: "work-2" });
    expect(parsed !== null && "payload" in parsed).toBe(false);
  });

  it("workItemFromValue fails closed (null) on an unknown kind (drift)", () => {
    expect(workItemFromValue({ kind: "compact", id: "work-3" })).toBeNull();
  });

  it("workItemFromValue fails closed (null) on a missing/non-string id", () => {
    expect(workItemFromValue({ kind: "steer" })).toBeNull();
    expect(workItemFromValue({ kind: "steer", id: 7 })).toBeNull();
  });

  it("workItemFromValue fails closed (null) on a non-object / non-object payload", () => {
    expect(workItemFromValue(null)).toBeNull();
    expect(workItemFromValue(undefined)).toBeNull();
    expect(workItemFromValue("steer")).toBeNull();
    expect(workItemFromValue([{ kind: "steer", id: "w" }])).toBeNull();
    expect(workItemFromValue({ kind: "steer", id: "w", payload: [1, 2] })).toBeNull();
    expect(workItemFromValue({ kind: "steer", id: "w", payload: null })).toBeNull();
    expect(workItemFromValue({ kind: "steer", id: "w", payload: 5 })).toBeNull();
  });

  it("a parsed work item's kind narrows exhaustively (discriminated union)", () => {
    const parsed: WorkItem | null = workItemFromValue({ kind: "user_turn", id: "work-4" });
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      // An exhaustive `switch` over the union — the `never` default makes adding a
      // fifth kind a compile error here until it is handled (cf. sessionActivityFromFrame).
      let label: string;
      switch (parsed.kind) {
        case "create_session":
          label = "create";
          break;
        case "resume_session":
          label = "resume";
          break;
        case "user_turn":
          label = "turn";
          break;
        case "steer":
          label = "steer";
          break;
        default: {
          const unreachable: never = parsed;
          label = unreachable;
        }
      }
      expect(label).toBe("turn");
    }
  });

  it("work-poll carries the scoped per-environment token, and its loggable view drops it", () => {
    const request: WorkPollRequest = {
      environmentId: "env-1",
      authorization: environmentToken("scoped-env-token-secret"),
    };
    const loggable = loggableWorkPoll(request);
    expect(loggable).toEqual({ environmentId: "env-1" });
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("scoped-env-token-secret");
  });

  it("ack/stop carry the scoped token, and the loggable view drops it (keeps env + work id)", () => {
    const action: WorkItemAction = {
      environmentId: "env-1",
      workId: "work-9",
      authorization: environmentToken("scoped-env-token-secret-2"),
    };
    const loggable = loggableWorkItemAction(action);
    expect(loggable).toEqual({ environmentId: "env-1", workId: "work-9" });
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("scoped-env-token-secret-2");
  });
});

describe("§4 per-session worker channel connect", () => {
  it("loggable projection keeps the ws_url and drops the Bearer", () => {
    const connect: WorkerChannelConnect = {
      wsUrl: "wss://127.0.0.1:8787/v1/sessions/sess-1/ws",
      authorization: new AccountBearer("oauth-account-secret-ws"),
    };
    const loggable = loggableWorkerChannelConnect(connect);
    expect(loggable).toEqual({ wsUrl: connect.wsUrl });
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-ws");
  });
});

describe("worker_status frames (§4 per-session status)", () => {
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
});
