// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  PUSH_VAPID_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_PATH,
  PUSH_NOTIFICATION_TITLE,
  PUSH_WAKE_TEXT,
  urlBase64ToUint8Array,
  pushSubscribeOptions,
  vapidPublicKeyFromResponse,
  toServerSubscription,
  notificationContent,
} from "./push.js";

/** base64url-encode bytes (the inverse of {@link urlBase64ToUint8Array}) so the decode can be round-tripped. */
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A browser `PushSubscription.toJSON()` fixture — the shape `toServerSubscription` consumes. */
function subscriptionJson({
  endpoint = "https://push.example.com/ep/abc123",
  p256dh = "BExamplePublicKeyBytesBase64Url",
  auth = "AuthSecretBase64Url",
  expirationTime = null,
} = {}) {
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

/** A #45 `PushPayload` fixture — the decrypted body the service worker's `push` handler receives. */
function pushPayload({ session_id = "11111111-2222-3333-4444-555555555555", text = PUSH_WAKE_TEXT } = {}) {
  return { session_id, text, notification_class: "blocking" };
}

describe("mirrored routes", () => {
  it("PUSH_VAPID_PUBLIC_KEY_PATH mirrors the server's VAPID-public-key route", () => {
    expect(PUSH_VAPID_PUBLIC_KEY_PATH).toBe("/api/push/vapid-public-key");
  });

  it("PUSH_SUBSCRIPTION_PATH mirrors the server's subscription-upload route", () => {
    expect(PUSH_SUBSCRIPTION_PATH).toBe("/api/push/subscription");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("round-trips a 65-byte uncompressed P-256 key (the VAPID public-key length)", () => {
    // 0x04 || X(32) || Y(32) — the shape a real VAPID public key decodes to.
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let i = 1; i < 65; i += 1) {
      bytes[i] = (i * 7) % 256;
    }
    const decoded = urlBase64ToUint8Array(toBase64Url(bytes));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBe(65);
    expect([...decoded]).toEqual([...bytes]);
  });

  it("round-trips across all base64 padding remainders (1, 2, 3, 0 trailing bytes)", () => {
    for (const length of [1, 2, 3, 4, 5, 6]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (i * 37 + 11) % 256;
      }
      expect([...urlBase64ToUint8Array(toBase64Url(bytes))], `length ${length}`).toEqual([...bytes]);
    }
  });

  it("maps the URL-safe alphabet (- and _) back to standard base64 (+ and /)", () => {
    // 0xFF bytes force the 62/63 sextets that base64 renders as + and /, base64url as - and _.
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);
    expect(toBase64Url(bytes)).toBe("____");
    expect([...urlBase64ToUint8Array("____")]).toEqual([0xff, 0xff, 0xff]);
  });

  it("fails closed on a non-string or blank key rather than yielding a garbage applicationServerKey", () => {
    expect(() => urlBase64ToUint8Array("")).toThrow(/non-empty base64url/);
    expect(() => urlBase64ToUint8Array("   ")).toThrow(/non-empty base64url/);
    expect(() => urlBase64ToUint8Array(undefined)).toThrow(/non-empty base64url/);
    expect(() => urlBase64ToUint8Array(null)).toThrow(/non-empty base64url/);
    expect(() => urlBase64ToUint8Array(42)).toThrow(/non-empty base64url/);
  });
});

describe("pushSubscribeOptions", () => {
  it("always sets userVisibleOnly true — the 'no silent push' contract at subscribe (AC2)", () => {
    expect(pushSubscribeOptions(new Uint8Array([0x04])).userVisibleOnly).toBe(true);
    // No input shapes it off: there is no silent-subscription path.
    expect(pushSubscribeOptions(new Uint8Array()).userVisibleOnly).toBe(true);
  });

  it("passes the applicationServerKey through unchanged", () => {
    const key = urlBase64ToUint8Array("____");
    expect(pushSubscribeOptions(key).applicationServerKey).toBe(key);
  });
});

describe("vapidPublicKeyFromResponse", () => {
  it("extracts a non-blank publicKey string", () => {
    expect(vapidPublicKeyFromResponse({ publicKey: "BFooBarBaz" })).toBe("BFooBarBaz");
  });

  it("reads a missing / blank / shapeless / non-string body as null (route not wired, tunnel error page)", () => {
    expect(vapidPublicKeyFromResponse(null)).toBeNull();
    expect(vapidPublicKeyFromResponse(undefined)).toBeNull();
    expect(vapidPublicKeyFromResponse({})).toBeNull();
    expect(vapidPublicKeyFromResponse({ publicKey: "" })).toBeNull();
    expect(vapidPublicKeyFromResponse({ publicKey: "   " })).toBeNull();
    expect(vapidPublicKeyFromResponse({ publicKey: 42 })).toBeNull();
    expect(vapidPublicKeyFromResponse("BFoo")).toBeNull();
  });
});

describe("toServerSubscription", () => {
  it("shapes a PushSubscription into exactly the server's WebPushSubscription contract (AC3)", () => {
    const result = toServerSubscription(subscriptionJson());
    // The exact shape #50's dispatchWake consumes — endpoint + keys.{p256dh,auth}, nothing else.
    expect(result).toEqual({
      endpoint: "https://push.example.com/ep/abc123",
      keys: { p256dh: "BExamplePublicKeyBytesBase64Url", auth: "AuthSecretBase64Url" },
    });
    expect(Object.keys(result)).toEqual(["endpoint", "keys"]);
    expect(Object.keys(result.keys)).toEqual(["p256dh", "auth"]);
  });

  it("drops expirationTime — the server contract has no such field", () => {
    const result = toServerSubscription(subscriptionJson({ expirationTime: 1234567890 }));
    expect(result).not.toHaveProperty("expirationTime");
  });

  it("returns a fresh object, not an alias of the browser subscription", () => {
    const input = subscriptionJson();
    const result = toServerSubscription(input);
    expect(result).not.toBe(input);
    expect(result.keys).not.toBe(input.keys);
  });

  it("returns null on a malformed subscription rather than uploading an unsendable one", () => {
    expect(toServerSubscription(null)).toBeNull();
    expect(toServerSubscription(undefined)).toBeNull();
    expect(toServerSubscription({})).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x" })).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x", keys: {} })).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x", keys: { p256dh: "k" } })).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x", keys: { auth: "a" } })).toBeNull();
    expect(toServerSubscription({ endpoint: "", keys: { p256dh: "k", auth: "a" } })).toBeNull();
    expect(toServerSubscription({ endpoint: "   ", keys: { p256dh: "k", auth: "a" } })).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x", keys: { p256dh: "", auth: "a" } })).toBeNull();
    expect(toServerSubscription({ endpoint: "https://p/x", keys: { p256dh: "k", auth: "  " } })).toBeNull();
  });
});

describe("notificationContent", () => {
  it("renders the generic wake as a full visible notification (AC2)", () => {
    const content = notificationContent(pushPayload());
    expect(content.title).toBe(PUSH_NOTIFICATION_TITLE);
    expect(content.body).toBe(PUSH_WAKE_TEXT);
    // Coalescing tag keyed on the opaque pointer — repeats for one session replace, not stack (#46).
    expect(content.tag).toBe("ccctl-session-11111111-2222-3333-4444-555555555555");
    // The opaque pointer for the tap → deep-link resolve (#52).
    expect(content.data).toEqual({ session_id: "11111111-2222-3333-4444-555555555555" });
  });

  it("ALWAYS returns a renderable notification — the 'no silent push' render half (AC2)", () => {
    // Any input the decrypted body could be — absent, non-object, wrong-typed — still shows something.
    for (const bad of [null, undefined, 42, "a string", [], true, {}]) {
      const content = notificationContent(bad);
      expect(content.title, `input ${JSON.stringify(bad)}`).toBe(PUSH_NOTIFICATION_TITLE);
      expect(content.body.trim(), `input ${JSON.stringify(bad)}`).not.toBe("");
      expect(content.tag, `input ${JSON.stringify(bad)}`).toBe("ccctl-wake");
      expect(content.data, `input ${JSON.stringify(bad)}`).toEqual({});
    }
  });

  it("holds the #45 firewall — session content on the body never reaches the notification", () => {
    // A body that tries to smuggle a session's detail / transcript past the firewall.
    const poisoned = {
      session_id: "sess-9",
      text: PUSH_WAKE_TEXT,
      notification_class: "blocking",
      detail: "rm -rf / --no-preserve-root",
      transcript: "the secret the worker is saying",
    };
    const content = notificationContent(poisoned);
    // Only the generic line and the opaque pointer are read; the content fields are structurally ignored.
    expect(content.body).toBe(PUSH_WAKE_TEXT);
    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("secret");
  });

  it("falls back to the generic line for a blank / non-string body text", () => {
    expect(notificationContent({ session_id: "s", text: "   " }).body).toBe(PUSH_WAKE_TEXT);
    expect(notificationContent({ session_id: "s", text: 42 }).body).toBe(PUSH_WAKE_TEXT);
    expect(notificationContent({ session_id: "s" }).body).toBe(PUSH_WAKE_TEXT);
  });

  it("falls back to one shared tag and empty data when there is no usable session pointer", () => {
    for (const badPointer of [{ session_id: "" }, { session_id: "   " }, { session_id: 42 }, {}]) {
      const content = notificationContent(badPointer);
      expect(content.tag).toBe("ccctl-wake");
      expect(content.data).toEqual({});
    }
  });
});
