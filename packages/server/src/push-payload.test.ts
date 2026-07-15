// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  type NeedsInputNotification,
  type PushGatewayView,
  type PushPayload,
  PUSH_WAKE_TEXT,
  toPushGatewayView,
  toPushPayload,
} from "./push-payload.js";
import { NOTIFICATION_CLASS_BLOCKING, NOTIFICATION_CLASS_INFORMATIONAL } from "./worker-channel.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/**
 * A realistic blocking needs-input notification (#43/#44) carrying a SENSITIVE `detail` — the same shape
 * `needsInputEvent` emits (session_id + detail + the spread blocking policy). The `detail` is exactly what
 * a pointer-only push must never carry, so it is the firewall's adversarial input.
 */
const SENSITIVE_DETAIL = "Allow Bash(rm -rf /tmp/secret-project) — delete the staging DB?";
const richNeedsInput: NeedsInputNotification & {
  readonly type: string;
  readonly detail: string;
  readonly urgency: string;
  readonly renudge: boolean;
  readonly batchable: boolean;
} = {
  type: "ccctl_session_needs_input",
  session_id: SESSION_ID,
  detail: SENSITIVE_DETAIL,
  notification_class: NOTIFICATION_CLASS_BLOCKING,
  urgency: "high",
  renudge: true,
  batchable: false,
};

describe("push payload — AC1: pointer-only (opaque id + minimal text, never content)", () => {
  it("carries EXACTLY the opaque session pointer, the generic text, and the blocking class — nothing else", () => {
    const payload = toPushPayload(richNeedsInput);
    expect(Object.keys(payload).sort()).toEqual(["notification_class", "session_id", "text"]);
    expect(payload.session_id).toBe(SESSION_ID);
    expect(payload.text).toBe(PUSH_WAKE_TEXT);
    expect(payload.notification_class).toBe(NOTIFICATION_CLASS_BLOCKING);
  });

  it("the text is a generic, content-free constant — not the requires_action detail", () => {
    const payload = toPushPayload(richNeedsInput);
    expect(payload.text).toBe(PUSH_WAKE_TEXT);
    expect(PUSH_WAKE_TEXT).toBe("A session needs your input");
    // The generic line names neither the session nor what it awaits.
    expect(payload.text).not.toContain(SESSION_ID);
    expect(payload.text).not.toContain("rm -rf");
  });

  it("FIREWALL — the source detail (and every other rich field) cannot appear in the payload", () => {
    const payload = toPushPayload(richNeedsInput);
    const serialized = JSON.stringify(payload);
    // The detail substring never leaks…
    expect(serialized).not.toContain(SENSITIVE_DETAIL);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("staging DB");
    // …nor does a `detail` key, nor any of the notification's other non-pointer fields.
    expect(serialized).not.toContain("detail");
    expect(payload).not.toHaveProperty("detail");
    expect(payload).not.toHaveProperty("type");
    expect(payload).not.toHaveProperty("urgency");
    expect(payload).not.toHaveProperty("renudge");
    expect(payload).not.toHaveProperty("batchable");
  });

  it("is frozen — the pointer-only guarantee holds at runtime, a consumer cannot mutate content back in", () => {
    const payload = toPushPayload(richNeedsInput);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(() => {
      (payload as unknown as { detail: string }).detail = SENSITIVE_DETAIL;
    }).toThrow();
    expect(payload).not.toHaveProperty("detail");
  });
});

describe("push payload — AC3: opaque pointer forces the content fetch over the tunnel", () => {
  it("carries the session pointer as the deep-link target and NO content field", () => {
    const payload: PushPayload = toPushPayload(richNeedsInput);
    // The pointer is present (the client's deep-link → GET /api/sessions/{id}/events over the tunnel)…
    expect(payload.session_id).toBe(SESSION_ID);
    // …and there is no content field, so content can ONLY be fetched over the tunnel on tap, never read
    // off the push payload.
    expect(payload).not.toHaveProperty("detail");
    expect(payload).not.toHaveProperty("transcript");
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("messages");
  });
});

describe("push gateway view — AC2: bounded metadata + stable subscription id, never content or the session pointer", () => {
  const view: PushGatewayView = toPushGatewayView("sub-abc-123", 7, 1_700_000_000_000);

  it("carries EXACTLY a stable subscription id, the cadence ordinal, and the send timing — nothing else", () => {
    expect(Object.keys(view).sort()).toEqual(["sent_at_ms", "subscription_id", "wake_seq"]);
    expect(view.subscription_id).toBe("sub-abc-123");
    expect(view.wake_seq).toBe(7);
    expect(view.sent_at_ms).toBe(1_700_000_000_000);
  });

  it("FIREWALL — the gateway sees no session pointer and no content", () => {
    const serialized = JSON.stringify(view);
    // No session pointer — in Web-Push the pointer rides the encrypted payload, opaque to the relay.
    expect(serialized).not.toContain(SESSION_ID);
    expect(view).not.toHaveProperty("session_id");
    // No content of any kind.
    expect(view).not.toHaveProperty("text");
    expect(view).not.toHaveProperty("detail");
    expect(serialized).not.toContain(SENSITIVE_DETAIL);
    expect(serialized).not.toContain(PUSH_WAKE_TEXT);
  });

  it("is frozen — the bounded shape holds at runtime", () => {
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view as unknown as { session_id: string }).session_id = SESSION_ID;
    }).toThrow();
    expect(view).not.toHaveProperty("session_id");
  });
});

describe("push payload — the blocking class is the one that is push-woken", () => {
  it("carries the blocking class forward (reused, not re-derived), never the informational one", () => {
    const payload = toPushPayload(richNeedsInput);
    expect(payload.notification_class).toBe(NOTIFICATION_CLASS_BLOCKING);
    expect(payload.notification_class).not.toBe(NOTIFICATION_CLASS_INFORMATIONAL);
  });
});
