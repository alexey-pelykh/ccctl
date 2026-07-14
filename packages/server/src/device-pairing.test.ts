// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { buildPairingUrl, loggablePairingUrl } from "@ccctl/core";
import { DEVICE_TOKEN_BYTES, mintDeviceToken } from "./device-pairing.js";

describe("mintDeviceToken", () => {
  it("mints a base64url token — URL-safe, no padding, so it rides a URL fragment unescaped", () => {
    const token = mintDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url-encode to 43 characters (no `=` padding).
    expect(token).toHaveLength(43);
  });

  it("is distinct per call — the 'distinct per device' guarantee", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => mintDeviceToken()));
    expect(tokens.size).toBe(100);
  });

  it("builds the token from exactly DEVICE_TOKEN_BYTES of the injected randomness", () => {
    const sizes: number[] = [];
    mintDeviceToken((size) => {
      sizes.push(size);
      return Buffer.alloc(size, 0);
    });
    expect(sizes).toEqual([DEVICE_TOKEN_BYTES]);
  });

  it("base64url-encodes the injected bytes deterministically (no live crypto in the assertion)", () => {
    // 0xFB 0xFF encodes to `-_` in base64url (the `+`/`/` → `-`/`_` substitution) — proves
    // the URL-safe alphabet is used, not standard base64.
    const token = mintDeviceToken(() => Buffer.from([0xfb, 0xff]));
    expect(token).toBe("-_8");
  });

  it("never leaves the raw token in a pairing URL's loggable projection", () => {
    const token = mintDeviceToken();
    const safe = loggablePairingUrl(buildPairingUrl({ host: "phone.tailnet.ts.net", token }));
    expect(safe).not.toContain(token);
    expect(safe).toContain("REDACTED");
  });
});
