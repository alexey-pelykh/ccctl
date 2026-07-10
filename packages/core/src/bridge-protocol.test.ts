// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  AccountBearer,
  decodeControlFrame,
  encodeControlFrame,
  isWorkerStatus,
  isWorkerStatusEvent,
  loggableRegisterRequest,
  loggableWorkerChannelConnect,
  sessionIngressToken,
  SESSIONS_CREATE_PATH,
  workerStatusFromFrame,
  type ControlEvent,
  type ControlFrame,
  type RegisterRequest,
  type RegisterResponse,
  type WorkerChannelConnect,
  type WorkerStatus,
  type WorkerStatusEvent,
} from "./index.js";

describe("SESSIONS_CREATE_PATH", () => {
  it("pins the build-specific, versioned session-create path", () => {
    expect(SESSIONS_CREATE_PATH).toBe("/v1/code/sessions");
  });
});

describe("AccountBearer", () => {
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

describe("register (session create)", () => {
  it("loggable projection drops the Bearer and keeps the JSON body", () => {
    const request: RegisterRequest = {
      authorization: new AccountBearer("oauth-account-secret-xyz"),
      body: { sessionIngressToken: sessionIngressToken("ingress-token-1") },
    };
    const loggable = loggableRegisterRequest(request);
    expect(loggable).toEqual({ sessionIngressToken: "ingress-token-1" });
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-xyz");
  });

  it("response round-trips as plain JSON (session id + ws_url)", () => {
    const response: RegisterResponse = {
      sessionId: "sess-1",
      wsUrl: "wss://127.0.0.1:8787/v1/code/sessions/sess-1/ws",
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });
});

describe("worker channel connect", () => {
  it("loggable projection keeps the ws_url and drops the Bearer", () => {
    const connect: WorkerChannelConnect = {
      wsUrl: "wss://127.0.0.1:8787/v1/code/sessions/sess-1/ws",
      authorization: new AccountBearer("oauth-account-secret-ws"),
    };
    const loggable = loggableWorkerChannelConnect(connect);
    expect(loggable).toEqual({ wsUrl: connect.wsUrl });
    expect("authorization" in loggable).toBe(false);
    expect(JSON.stringify(loggable)).not.toContain("oauth-account-secret-ws");
  });
});

describe("worker_status frames", () => {
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
