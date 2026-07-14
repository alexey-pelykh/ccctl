// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect, vi } from "vitest";
import {
  PAIRING_TOKEN_PARAM,
  PAIRING_TOKEN_STORAGE_KEY,
  tokenFromHash,
  storedToken,
  applyPairingToken,
  authHeader,
} from "./pairing.js";

/** A DOM-free `Storage` stand-in backed by a Map — only the `getItem`/`setItem` the module uses. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  };
}

describe("wire constant", () => {
  it("pins the fragment parameter to the @ccctl/core contract (`ccctl_token`)", () => {
    expect(PAIRING_TOKEN_PARAM).toBe("ccctl_token");
  });
});

describe("tokenFromHash", () => {
  it("extracts the token from a `#ccctl_token=…` fragment", () => {
    expect(tokenFromHash("#ccctl_token=Zm9vYmFy_-0")).toBe("Zm9vYmFy_-0");
  });

  it("tolerates a fragment with no leading `#`", () => {
    expect(tokenFromHash("ccctl_token=abc")).toBe("abc");
  });

  it("URL-decodes the token — the inverse of the builder's encodeURIComponent", () => {
    expect(tokenFromHash("#ccctl_token=a%20b%26c")).toBe("a b&c");
  });

  it("finds the token alongside other fragment parameters", () => {
    expect(tokenFromHash("#foo=bar&ccctl_token=tok123")).toBe("tok123");
  });

  it("returns null for an absent, blank, or wrong-parameter fragment", () => {
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#")).toBeNull();
    expect(tokenFromHash("#ccctl_token=")).toBeNull();
    expect(tokenFromHash("#other=value")).toBeNull();
    expect(tokenFromHash(undefined)).toBeNull();
  });
});

describe("storedToken", () => {
  it("returns the persisted token, or null when absent or blank", () => {
    expect(storedToken(fakeStorage({ [PAIRING_TOKEN_STORAGE_KEY]: "tok" }))).toBe("tok");
    expect(storedToken(fakeStorage())).toBeNull();
    expect(storedToken(fakeStorage({ [PAIRING_TOKEN_STORAGE_KEY]: "  " }))).toBeNull();
  });
});

describe("applyPairingToken", () => {
  it("persists a freshly-scanned token AND strips it from the URL so it does not linger", () => {
    const storage = fakeStorage();
    const replaceState = vi.fn();
    const applied = applyPairingToken({
      location: { hash: "#ccctl_token=fresh-tok", pathname: "/", search: "" },
      history: { replaceState },
      storage,
    });
    expect(applied).toBe("fresh-tok");
    expect(storedToken(storage)).toBe("fresh-tok");
    // The secret is scrubbed from the URL — same path, no fragment.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("preserves an existing query string when scrubbing the fragment", () => {
    const replaceState = vi.fn();
    applyPairingToken({
      location: { hash: "#ccctl_token=fresh", pathname: "/app", search: "?view=1" },
      history: { replaceState },
      storage: fakeStorage(),
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app?view=1");
  });

  it("falls back to a previously-stored token without touching the URL (a returning paired device)", () => {
    const replaceState = vi.fn();
    const applied = applyPairingToken({
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState },
      storage: fakeStorage({ [PAIRING_TOKEN_STORAGE_KEY]: "remembered" }),
    });
    expect(applied).toBe("remembered");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("returns null when the device has never been paired", () => {
    const replaceState = vi.fn();
    const applied = applyPairingToken({
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState },
      storage: fakeStorage(),
    });
    expect(applied).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("authHeader", () => {
  it("presents the stored token as an Authorization: Bearer header", () => {
    expect(authHeader(fakeStorage({ [PAIRING_TOKEN_STORAGE_KEY]: "tok" }))).toEqual({
      Authorization: "Bearer tok",
    });
  });

  it("is an empty object when the device is not paired, so it spreads cleanly onto fetch headers", () => {
    expect(authHeader(fakeStorage())).toEqual({});
  });
});
