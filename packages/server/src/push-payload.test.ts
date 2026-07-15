// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  type NeedsInputNotification,
  type PushGatewayView,
  type PushPayload,
  type PushReliability,
  PUSH_COLLAPSE_ID_MAX_LENGTH,
  PUSH_URGENCY_HIGH,
  PUSH_WAKE_TEXT,
  toPushGatewayView,
  toPushPayload,
  toPushReliability,
} from "./push-payload.js";
import { NOTIFICATION_CLASS_BLOCKING, NOTIFICATION_CLASS_INFORMATIONAL } from "./worker-channel.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
/** A second, distinct blocked session — used to prove two sessions' wakes get DIFFERENT collapse ids. */
const OTHER_SESSION_ID = "99999999-8888-7777-6666-555544443333";

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

describe("push reliability — AC3: a high-urgency marker + a collapse id so repeats coalesce (do not stack)", () => {
  const payload = toPushPayload(richNeedsInput);

  it("carries EXACTLY the high-urgency marker and a collapse id — nothing else", () => {
    const reliability = toPushReliability(payload);
    expect(Object.keys(reliability).sort()).toEqual(["collapse_id", "urgency"]);
    expect(reliability.urgency).toBe(PUSH_URGENCY_HIGH);
    expect(reliability.urgency).toBe("high");
  });

  it("the urgency is derived from the blocking class the payload carries forward, mapped to high", () => {
    // Only the blocking class is push-woken; #45's payload pins `notification_class` to blocking, and the
    // reliability derivation maps that class to Urgency: high (keying on the class, per #44/#45) — never a
    // per-wake value.
    const reliability = toPushReliability(payload);
    expect(payload.notification_class).toBe(NOTIFICATION_CLASS_BLOCKING);
    expect(reliability.urgency).toBe(PUSH_URGENCY_HIGH);
  });

  it("the collapse id is a valid Web-Push Topic — ≤ 32 chars from the RFC 4648 §5 / RFC 8030 §5.4 alphabet", () => {
    const { collapse_id } = toPushReliability(payload);
    expect(collapse_id.length).toBeGreaterThan(0);
    expect(collapse_id.length).toBeLessThanOrEqual(PUSH_COLLAPSE_ID_MAX_LENGTH);
    expect(PUSH_COLLAPSE_ID_MAX_LENGTH).toBe(32);
    // URL- and filename-safe Base64 alphabet ONLY — a Topic outside it is rejected by the push service and
    // coalescing silently stops.
    expect(collapse_id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("coalesce — repeated wakes for the SAME session share one collapse id", () => {
    // Two independent wakes for the one blocked session — e.g. the first needs-input and a later re-nudge
    // (#48). Same session ⇒ same Topic ⇒ the push service replaces the undelivered one, so the client sees
    // a single notification, never two for the same event.
    const first = toPushReliability(toPushPayload(richNeedsInput));
    const second = toPushReliability(toPushPayload({ ...richNeedsInput }));
    expect(second.collapse_id).toBe(first.collapse_id);
  });

  it("distinct across sessions — two different blocked sessions get different collapse ids (never collapse into one)", () => {
    const a = toPushReliability(toPushPayload({ ...richNeedsInput, session_id: SESSION_ID }));
    const b = toPushReliability(toPushPayload({ ...richNeedsInput, session_id: OTHER_SESSION_ID }));
    expect(b.collapse_id).not.toBe(a.collapse_id);
  });

  it("is a determinism anchor — the derivation is stable across builds, so a silent change breaks loudly", () => {
    // Pins the exact SHA-256 → base64url → 32-char output for a known session id.
    expect(toPushReliability(toPushPayload({ ...richNeedsInput, session_id: SESSION_ID })).collapse_id).toBe(
      "Zm_2zKpbPAf-qjqV06S9LEasnpq9sJyp",
    );
  });

  it("is frozen — a downstream dispatcher cannot mutate the urgency down or swap a collapse id back in", () => {
    const reliability: PushReliability = toPushReliability(payload);
    expect(Object.isFrozen(reliability)).toBe(true);
    expect(() => {
      (reliability as unknown as { urgency: string }).urgency = "low";
    }).toThrow();
    expect(reliability.urgency).toBe(PUSH_URGENCY_HIGH);
  });
});

describe("push reliability — FIREWALL: the gateway-visible collapse id reveals neither the session pointer nor content", () => {
  it("the collapse id is OPAQUE — not the session pointer, not its hyphen-stripped form, and does not contain it", () => {
    // The Topic rides as a CLEARTEXT HTTP header the external push gateway reads (#45 firewall), so it must
    // not BE or CONTAIN the session pointer — a one-way digest, never the id itself.
    const { collapse_id } = toPushReliability(toPushPayload({ ...richNeedsInput, session_id: SESSION_ID }));
    expect(collapse_id).not.toBe(SESSION_ID);
    expect(collapse_id).not.toBe(SESSION_ID.replace(/-/g, ""));
    expect(collapse_id).not.toContain(SESSION_ID);
  });

  it("no session pointer and no content appear anywhere in the reliability directives", () => {
    // Derived from a detail-bearing source notification, yet the directives carry only urgency + an opaque
    // collapse id: the source `detail` (already firewalled out at the payload layer) never reappears, and
    // the session pointer never leaks into the gateway-visible shape.
    const reliability = toPushReliability(toPushPayload(richNeedsInput));
    const serialized = JSON.stringify(reliability);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(SESSION_ID.replace(/-/g, ""));
    expect(serialized).not.toContain(SENSITIVE_DETAIL);
    expect(serialized).not.toContain("rm -rf");
    expect(reliability).not.toHaveProperty("session_id");
    expect(reliability).not.toHaveProperty("detail");
    expect(reliability).not.toHaveProperty("text");
  });
});
