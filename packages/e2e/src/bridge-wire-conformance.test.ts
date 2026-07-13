// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  assertEnvironmentRegisterResponseWire,
  assertRegisterStatus,
  assertSessionCreateResponseWire,
  assertWorkItemWire,
  assertWorkerStateRestoreStatus,
  assertWorkLifecycleStatus,
  BRIDGE_SESSION_CREATE_BODY,
  BRIDGE_SESSION_CREATE_SUPERSEDED_BODY,
  decodeWorkSecret,
  WORK_LIFECYCLE_VERBS,
} from "./bridge-wire-conformance.js";

// Unit coverage of the wire-conformance oracle's PURE per-leg shape assertions,
// conformed to the worker's observed wire (#130/#131). Each pins the current
// environments-bridge flow's snake_case response face INDEPENDENTLY of the server's
// serializer, so these specs pin BOTH directions — the assertion ACCEPTS the pinned
// shape and, crucially, REJECTS a camelCase / reordered / drifted / resurrected-legacy
// shape — so a conformance run cannot silently agree with a wrong contract (the
// Self-Confirming Mock gap). Exercised live against the real server in
// `wire-conformance.e2e.test.ts`; driven directly here so the shape gate is verified on
// every `test` run without a live server.

/** Encode a work-secret the way the server mints it: `base64url(JSON(WorkSecret))`. */
function encodeSecret(secret: unknown): string {
  return Buffer.from(JSON.stringify(secret), "utf8").toString("base64url");
}

const VALID_SECRET = { version: 1, session_ingress_token: "ingress-token-1", api_base_url: "http://127.0.0.1:8787" };

describe("assertEnvironmentRegisterResponseWire — §1 { environment_id } (no work-poll token, #130)", () => {
  const PINNED = JSON.stringify({ environment_id: "env-1" });

  it("accepts the pinned snake_case wire body and returns it typed", () => {
    expect(assertEnvironmentRegisterResponseWire(PINNED)).toEqual({ environment_id: "env-1" });
  });

  it("rejects the camelCase shape — the Self-Confirming Mock a wrong casing would be", () => {
    expect(() => assertEnvironmentRegisterResponseWire(JSON.stringify({ environmentId: "env-1" }))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects a RESURRECTED work_poll_token (the retired legacy field, #130)", () => {
    const resurrected = JSON.stringify({ environment_id: "env-1", work_poll_token: "tok-1" });
    expect(() => assertEnvironmentRegisterResponseWire(resurrected)).toThrow(/does not match the pinned contract/);
  });

  it("rejects a stray extra key and a missing key", () => {
    expect(() => assertEnvironmentRegisterResponseWire(JSON.stringify({ environment_id: "e", extra: 1 }))).toThrow(
      /does not match the pinned contract/,
    );
    expect(() => assertEnvironmentRegisterResponseWire(JSON.stringify({}))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects a non-string or empty field value", () => {
    expect(() => assertEnvironmentRegisterResponseWire(JSON.stringify({ environment_id: "" }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertEnvironmentRegisterResponseWire(JSON.stringify({ environment_id: 1 }))).toThrow(
      /must be a non-empty string/,
    );
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => assertEnvironmentRegisterResponseWire("not json")).toThrow(/not valid JSON/);
    expect(() => assertEnvironmentRegisterResponseWire("[]")).toThrow(/not a JSON object/);
    expect(() => assertEnvironmentRegisterResponseWire("null")).toThrow(/not a JSON object/);
  });
});

describe("assertSessionCreateResponseWire — §2 { session_id } (no ws_url, #130)", () => {
  const PINNED = JSON.stringify({ session_id: "sess-1" });

  it("accepts the pinned snake_case wire body and returns it typed", () => {
    expect(assertSessionCreateResponseWire(PINNED)).toEqual({ session_id: "sess-1" });
  });

  it("rejects the camelCase shape", () => {
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ sessionId: "sess-1" }))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects a RESURRECTED ws_url — the SSE control path never reads one (#130)", () => {
    const resurrected = JSON.stringify({ session_id: "sess-1", ws_url: "ws://127.0.0.1:8787/v1/sessions/sess-1/ws" });
    expect(() => assertSessionCreateResponseWire(resurrected)).toThrow(/does not match the pinned contract/);
  });

  it("rejects an extra or missing key", () => {
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: "s", extra: "nope" }))).toThrow(
      /does not match the pinned contract/,
    );
    expect(() => assertSessionCreateResponseWire(JSON.stringify({}))).toThrow(/does not match the pinned contract/);
  });

  it("rejects a non-string or empty field value", () => {
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: "" }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertSessionCreateResponseWire(JSON.stringify({ session_id: 1 }))).toThrow(
      /must be a non-empty string/,
    );
  });
});

describe("assertWorkItemWire — §3 a SINGLE { id, secret, data } item (not a { work: [...] } envelope, #130)", () => {
  it("accepts a well-formed session item and returns it typed alongside its decoded secret", () => {
    const body = JSON.stringify({
      id: "work-1",
      secret: encodeSecret(VALID_SECRET),
      data: { type: "session", id: "sess-1" },
    });
    const { item, secret } = assertWorkItemWire(body);
    expect(item).toEqual({ id: "work-1", secret: encodeSecret(VALID_SECRET), data: { type: "session", id: "sess-1" } });
    expect(secret).toEqual({
      version: 1,
      session_ingress_token: "ingress-token-1",
      api_base_url: "http://127.0.0.1:8787",
    });
  });

  it("accepts a healthcheck item (no data.id)", () => {
    const body = JSON.stringify({ id: "work-2", secret: encodeSecret(VALID_SECRET), data: { type: "healthcheck" } });
    expect(assertWorkItemWire(body).item.data).toEqual({ type: "healthcheck" });
  });

  it("rejects a { work: [...] } envelope — the defining §3 regression (#130)", () => {
    const envelope = JSON.stringify({
      work: [{ id: "w1", secret: encodeSecret(VALID_SECRET), data: { type: "session", id: "s1" } }],
    });
    expect(() => assertWorkItemWire(envelope)).toThrow(/expected a single item/);
  });

  it("rejects a reordered, extra, or missing top-level key", () => {
    expect(() =>
      assertWorkItemWire(`{"secret":"${encodeSecret(VALID_SECRET)}","id":"w1","data":{"type":"healthcheck"}}`),
    ).toThrow(/does not match the pinned contract/);
    expect(() =>
      assertWorkItemWire(
        JSON.stringify({ id: "w1", secret: encodeSecret(VALID_SECRET), data: { type: "healthcheck" }, extra: 1 }),
      ),
    ).toThrow(/does not match the pinned contract/);
    expect(() => assertWorkItemWire(JSON.stringify({ id: "w1", secret: encodeSecret(VALID_SECRET) }))).toThrow(
      /does not match the pinned contract/,
    );
  });

  it("rejects an unknown data.type and a session item missing its data.id — fail closed", () => {
    expect(() =>
      assertWorkItemWire(JSON.stringify({ id: "w1", secret: encodeSecret(VALID_SECRET), data: { type: "bogus" } })),
    ).toThrow(/is not one of session\|healthcheck/);
    expect(() =>
      assertWorkItemWire(JSON.stringify({ id: "w1", secret: encodeSecret(VALID_SECRET), data: { type: "session" } })),
    ).toThrow(/must be a non-empty string/);
  });

  it("rejects a missing/blank secret or a non-object data", () => {
    expect(() => assertWorkItemWire(JSON.stringify({ id: "w1", secret: "", data: { type: "healthcheck" } }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() =>
      assertWorkItemWire(JSON.stringify({ id: "w1", secret: encodeSecret(VALID_SECRET), data: [] })),
    ).toThrow(/is not an object/);
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => assertWorkItemWire("not json")).toThrow(/not valid JSON/);
    expect(() => assertWorkItemWire("[]")).toThrow(/not a JSON object/);
  });
});

describe("decodeWorkSecret — base64url(JSON(WorkSecret)) with both inner fields (#130)", () => {
  it("decodes a well-formed secret", () => {
    expect(decodeWorkSecret(encodeSecret(VALID_SECRET))).toEqual({
      version: 1,
      session_ingress_token: "ingress-token-1",
      api_base_url: "http://127.0.0.1:8787",
    });
  });

  it("rejects a secret that is not base64url(JSON)", () => {
    expect(() => decodeWorkSecret(Buffer.from("not json", "utf8").toString("base64url"))).toThrow(
      /not base64url\(JSON\)/,
    );
  });

  it("rejects a decoded value that is not a JSON object", () => {
    expect(() => decodeWorkSecret(encodeSecret([1, 2, 3]))).toThrow(/not a JSON object/);
  });

  it("rejects a non-number version", () => {
    expect(() => decodeWorkSecret(encodeSecret({ ...VALID_SECRET, version: "1" }))).toThrow(/must be a number/);
  });

  it("rejects a missing or blank inner field (both are load-bearing)", () => {
    expect(() => decodeWorkSecret(encodeSecret({ version: 1, api_base_url: "http://127.0.0.1:1" }))).toThrow(
      /must be a non-empty string/,
    );
    expect(() => decodeWorkSecret(encodeSecret({ version: 1, session_ingress_token: "t", api_base_url: "" }))).toThrow(
      /must be a non-empty string/,
    );
  });
});

// The four residual legs #154 conformed, pinned fail-closed here (#155). Each pure status
// assertion ACCEPTS the conformant value and REJECTS the pre-#154 divergence — the "fails
// on the divergence" direction proven credential-free, alongside the shape assertions
// above; the "passes on the conformant server" direction is proven live in
// `wire-conformance.e2e.test.ts` (which drives `assertServerSpeaksBridgeContract`).

describe("assertRegisterStatus — §1 register status is the pinned 200, not the pre-#154 201 (#154/#155)", () => {
  it("accepts the pinned 200", () => {
    expect(() => assertRegisterStatus(200)).not.toThrow();
  });

  it("rejects the pre-#154 201 — the status the observed worker rejects", () => {
    expect(() => assertRegisterStatus(201)).toThrow(/expected status 200, got 201/);
  });

  it("rejects any other non-200 status", () => {
    expect(() => assertRegisterStatus(400)).toThrow(/expected status 200, got 400/);
    expect(() => assertRegisterStatus(500)).toThrow(/expected status 200/);
  });
});

describe("assertWorkLifecycleStatus — §3/§4 lifecycle verbs are routed 200, not the pre-#154 404 (#154/#155)", () => {
  it("accepts the routed 200 for each verb", () => {
    for (const verb of WORK_LIFECYCLE_VERBS) {
      expect(() => assertWorkLifecycleStatus(verb, 200)).not.toThrow();
    }
  });

  it("rejects the pre-#154 404 — the unrouted divergence — naming the verb", () => {
    expect(() => assertWorkLifecycleStatus("ack", 404)).toThrow(/work\/ack expected status 200, got 404/);
    expect(() => assertWorkLifecycleStatus("heartbeat", 404)).toThrow(/work\/heartbeat expected status 200, got 404/);
    expect(() => assertWorkLifecycleStatus("stop", 404)).toThrow(/work\/stop expected status 200, got 404/);
  });

  it("pins exactly the three sibling verbs the worker drives after delivery", () => {
    expect([...WORK_LIFECYCLE_VERBS]).toEqual(["ack", "heartbeat", "stop"]);
  });
});

describe("assertWorkerStateRestoreStatus — §4 GET …/worker is 200, not the pre-#154 405 (#154/#155)", () => {
  it("accepts the empty 200 (the method-multiplexed restore)", () => {
    expect(() => assertWorkerStateRestoreStatus(200)).not.toThrow();
  });

  it("rejects the pre-#154 405 — the PUT-only divergence that looped the child", () => {
    expect(() => assertWorkerStateRestoreStatus(405)).toThrow(/405 is the pre-#154 PUT-only divergence/);
  });
});

describe("BRIDGE_SESSION_CREATE_BODY — the §2 request carries session_context, not the superseded context (#154/#155)", () => {
  it("sends the context under `session_context` and NOT a top-level `context`", () => {
    expect(BRIDGE_SESSION_CREATE_BODY).toHaveProperty("session_context");
    expect(BRIDGE_SESSION_CREATE_BODY).not.toHaveProperty("context");
  });

  it("carries the worker's observed extras the server accepts and ignores (#154)", () => {
    expect(BRIDGE_SESSION_CREATE_BODY.session_context).toHaveProperty("sources");
    expect(BRIDGE_SESSION_CREATE_BODY.session_context).toHaveProperty("outcomes");
    expect(BRIDGE_SESSION_CREATE_BODY.session_context).toHaveProperty("reuse_outcome_branches");
    expect(BRIDGE_SESSION_CREATE_BODY).toHaveProperty("environment_id");
  });

  it("keeps the superseded probe body on the old top-level `context` (the negative probe that must 400)", () => {
    expect(BRIDGE_SESSION_CREATE_SUPERSEDED_BODY).toHaveProperty("context");
    expect(BRIDGE_SESSION_CREATE_SUPERSEDED_BODY).not.toHaveProperty("session_context");
  });
});
