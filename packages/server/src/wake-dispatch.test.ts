// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAKE_TTL_SECONDS,
  dispatchWake,
  VAPID_PRIVATE_KEY_BYTES,
  VAPID_PUBLIC_KEY_BYTES,
  validateVapidKeys,
  WAKE_SUBSCRIPTION_EXPIRED_STATUSES,
  type VapidKeys,
  type WebPushMessage,
  type WebPushSend,
  type WebPushSubscription,
} from "./wake-dispatch.js";
import { PUSH_URGENCY_HIGH, toPushPayload, toPushReliability, type NeedsInputNotification } from "./push-payload.js";
import { NOTIFICATION_CLASS_BLOCKING } from "./worker-channel.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** A blocking needs-input notification carrying a SENSITIVE `detail` — the firewall's adversarial input. */
const SENSITIVE_DETAIL = "Allow Bash(rm -rf /tmp/secret-project) — delete the staging DB?";
const richNeedsInput: NeedsInputNotification & { readonly detail: string; readonly type: string } = {
  type: "ccctl_session_needs_input",
  session_id: SESSION_ID,
  detail: SENSITIVE_DETAIL,
  notification_class: NOTIFICATION_CLASS_BLOCKING,
};
const payload = toPushPayload(richNeedsInput);

const SUBSCRIPTION: WebPushSubscription = {
  endpoint: "https://push.example.com/sub/abc123",
  keys: { p256dh: "BClientP256dhPublicKeyBase64url", auth: "clientAuthSecretBase64url" },
};

// Valid P-256 VAPID keys — built to the exact byte lengths so validation passes. The public key is the
// 65-byte uncompressed point (`0x04` prefix + 64 bytes); the private key is the 32-byte scalar.
const VALID_PUBLIC_KEY = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 9)]).toString("base64url");
const VALID_PRIVATE_KEY = Buffer.alloc(VAPID_PRIVATE_KEY_BYTES, 7).toString("base64url");
const VAPID: VapidKeys = {
  subject: "mailto:ops@example.com",
  publicKey: VALID_PUBLIC_KEY,
  privateKey: VALID_PRIVATE_KEY,
};

/**
 * A fake transmit that records the wakes it is handed and answers a fixed status. Exposes the capture via a
 * guarded `lastMessage()` (throws if nothing was dispatched) rather than an index-asserted `calls[0]!`, so
 * the tests read the assembled wake without a forbidden non-null assertion.
 */
function recordingSend(statusCode: number): {
  readonly send: WebPushSend;
  callCount(): number;
  lastMessage(): WebPushMessage;
} {
  const calls: WebPushMessage[] = [];
  const send: WebPushSend = (message) => {
    calls.push(message);
    return Promise.resolve({ statusCode });
  };
  return {
    send,
    callCount: () => calls.length,
    lastMessage: () => {
      const message = calls.at(-1);
      if (message === undefined) {
        throw new Error("no wake was dispatched");
      }
      return message;
    },
  };
}

describe("wake dispatch — AC1/AC2: one function assembles and sends a single Web-Push wake", () => {
  it("invokes the injected transmit EXACTLY ONCE with a fully-assembled Web-Push message", async () => {
    const { send, callCount, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    expect(callCount()).toBe(1);
    const message = lastMessage();
    expect(message.subscription).toBe(SUBSCRIPTION);
    expect(message.vapid).toBe(VAPID);
    // The body is the pointer-only payload serialized — the RFC 8291-encrypted body input.
    expect(message.payload).toBe(JSON.stringify(payload));
    // Exactly the Web-Push request fields — no stray keys.
    expect(Object.keys(message).sort()).toEqual(["payload", "subscription", "topic", "ttlSeconds", "urgency", "vapid"]);
  });

  it("the assembled message is frozen — it cannot be tampered between assembly and transmit", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const message = lastMessage();
    expect(Object.isFrozen(message)).toBe(true);
    expect(() => {
      (message as unknown as { payload: string }).payload = JSON.stringify({ content: SENSITIVE_DETAIL });
    }).toThrow();
  });
});

describe("wake dispatch — AC1: the #46 reliability directives are stamped on every send (never a caller job)", () => {
  it("stamps Urgency: high and the opaque collapse Topic derived from the payload, not from any param", async () => {
    const { send, lastMessage } = recordingSend(201);
    // Note: DispatchWakeParams has no urgency/topic field — they are DERIVED, so a caller cannot forget or
    // mis-stamp them. That is the AC1 "all dispatch through one function" guarantee in code.
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const message = lastMessage();
    const reliability = toPushReliability(payload);
    expect(message.urgency).toBe(PUSH_URGENCY_HIGH);
    expect(message.urgency).toBe("high");
    expect(message.topic).toBe(reliability.collapse_id);
    expect(message.topic.length).toBeGreaterThan(0);
  });
});

describe("wake dispatch — the #45/#46 firewall holds in the actual send", () => {
  it("the cleartext Topic is the opaque digest — not the session pointer, and does not contain it", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const message = lastMessage();
    // The Topic rides as a cleartext header a gateway reads (#45 firewall) — it must be the opaque collapse
    // id, never the session pointer or its hyphen-stripped form.
    expect(message.topic).not.toBe(SESSION_ID);
    expect(message.topic).not.toContain(SESSION_ID);
    expect(message.topic).not.toBe(SESSION_ID.replace(/-/g, ""));
  });

  it("the sensitive detail never appears anywhere in the assembled wake — headers or body", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const serialized = JSON.stringify(lastMessage());
    expect(serialized).not.toContain(SENSITIVE_DETAIL);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("staging DB");
    expect(serialized).not.toContain("detail");
  });

  it("the session pointer rides ONLY the (to-be-encrypted) body, never a cleartext header", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const message = lastMessage();
    // Present in the body (the deep-link pointer, encrypted for the device on the wire)…
    expect(message.payload).toContain(SESSION_ID);
    // …and absent from every cleartext field the gateway reads.
    expect(message.topic).not.toContain(SESSION_ID);
    expect(String(message.ttlSeconds)).not.toContain(SESSION_ID);
    expect(message.urgency).not.toContain(SESSION_ID);
  });

  it("the body is the pointer-only payload — nothing but the opaque id, generic text, and blocking class", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    const body = JSON.parse(lastMessage().payload) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["notification_class", "session_id", "text"]);
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("content");
  });
});

describe("wake dispatch — outcome mapping (push-service status → caller-meaningful outcome)", () => {
  it("maps any 2xx to `accepted` (the push service took the wake)", async () => {
    for (const status of [200, 201, 202]) {
      const { send } = recordingSend(status);
      expect(await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send })).toBe("accepted");
    }
  });

  it("maps 404 and 410 to `expired` — the subscription is gone and should be pruned", async () => {
    expect(WAKE_SUBSCRIPTION_EXPIRED_STATUSES).toEqual([404, 410]);
    for (const status of WAKE_SUBSCRIPTION_EXPIRED_STATUSES) {
      const { send } = recordingSend(status);
      expect(await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send })).toBe("expired");
    }
  });

  it("maps every other non-2xx to `failed` — transient/other, not pruned (the re-nudge ladder retries)", async () => {
    for (const status of [400, 413, 429, 500, 502, 503]) {
      const { send } = recordingSend(status);
      expect(await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send })).toBe("failed");
    }
  });

  it("propagates a transmit REJECTION (a network throw) rather than swallowing it", async () => {
    const send: WebPushSend = () => Promise.reject(new Error("network down"));
    await expect(dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send })).rejects.toThrow(
      "network down",
    );
  });
});

describe("wake dispatch — TTL", () => {
  it("defaults the TTL to DEFAULT_WAKE_TTL_SECONDS when not overridden", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send });
    expect(lastMessage().ttlSeconds).toBe(DEFAULT_WAKE_TTL_SECONDS);
    expect(DEFAULT_WAKE_TTL_SECONDS).toBe(300);
  });

  it("honors an explicit ttlSeconds override", async () => {
    const { send, lastMessage } = recordingSend(201);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: VAPID, send, ttlSeconds: 60 });
    expect(lastMessage().ttlSeconds).toBe(60);
  });
});

describe("wake dispatch — AC3: VAPID key handling", () => {
  it("the named P-256 byte lengths are the standard 65 (public) / 32 (private)", () => {
    expect(VAPID_PUBLIC_KEY_BYTES).toBe(65);
    expect(VAPID_PRIVATE_KEY_BYTES).toBe(32);
  });

  it("accepts a valid key pair and returns a FROZEN copy preserving the fields", () => {
    const validated = validateVapidKeys(VAPID);
    expect(validated).toEqual(VAPID);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => {
      (validated as unknown as { privateKey: string }).privateKey = "swapped";
    }).toThrow();
  });

  it("accepts both a mailto: and an https: subject (RFC 8292 §2.1)", () => {
    expect(() => validateVapidKeys({ ...VAPID, subject: "mailto:ops@example.com" })).not.toThrow();
    expect(() => validateVapidKeys({ ...VAPID, subject: "https://ccctl.example.com" })).not.toThrow();
  });

  it("rejects a subject that is not a mailto:/https: URI — fail closed, actionable message", () => {
    for (const subject of [
      "",
      "ops@example.com",
      "http://insecure.example.com",
      "tel:+15550100",
      "mailto:",
      "https://",
    ]) {
      expect(() => validateVapidKeys({ ...VAPID, subject })).toThrow(/VAPID subject must be/);
    }
  });

  it("rejects a public key that is not exactly 65 P-256 bytes", () => {
    const tooShort = Buffer.alloc(64, 9).toString("base64url");
    const tooLong = Buffer.alloc(66, 9).toString("base64url");
    expect(() => validateVapidKeys({ ...VAPID, publicKey: tooShort })).toThrow(/VAPID public key must be 65 bytes/);
    expect(() => validateVapidKeys({ ...VAPID, publicKey: tooLong })).toThrow(/VAPID public key must be 65 bytes/);
  });

  it("rejects a private key that is not exactly 32 P-256 bytes", () => {
    const tooShort = Buffer.alloc(31, 7).toString("base64url");
    expect(() => validateVapidKeys({ ...VAPID, privateKey: tooShort })).toThrow(/VAPID private key must be 32 bytes/);
  });

  it("rejects a non-base64url key (empty or with invalid characters)", () => {
    expect(() => validateVapidKeys({ ...VAPID, publicKey: "" })).toThrow(/base64url/);
    expect(() => validateVapidKeys({ ...VAPID, publicKey: "not+valid/base64url=" })).toThrow(/base64url/);
  });

  it("carries the VALIDATED VAPID identity into the assembled wake (so the transmit can sign with it)", async () => {
    const { send, lastMessage } = recordingSend(201);
    // The AC3 story: the identity the daemon VALIDATED (via the gate) is what reaches the wake — carried by
    // reference, so `toBe` is exact (a stronger, non-duplicative assertion than the raw-passthrough one above).
    const validated = validateVapidKeys(VAPID);
    await dispatchWake({ subscription: SUBSCRIPTION, payload, vapid: validated, send });
    expect(lastMessage().vapid).toBe(validated);
  });
});
