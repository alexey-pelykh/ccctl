// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { buildPairingUrl, deviceToken, loggablePairingUrl } from "@ccctl/core";
import { DEVICE_TOKEN_BYTES, DEVICE_TOKEN_HASH_ALGORITHM, hashDeviceToken, mintDeviceToken } from "./device-pairing.js";

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

describe("hashDeviceToken (the at-rest form of a minted token, #84)", () => {
  it("is a lowercase hex SHA-256 digest — 64 hex chars", () => {
    const hash = hashDeviceToken(mintDeviceToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The algorithm is SHA-256; 32 bytes hex-encode to 64 characters.
    expect(DEVICE_TOKEN_HASH_ALGORITHM).toBe("sha256");
  });

  it("is a known-answer SHA-256 hex digest (no live crypto in the assertion)", () => {
    // Golden vectors: `printf '%s' <token> | shasum -a 256`. Pins the exact algorithm +
    // encoding, so a silent switch to a different hash or to base64 breaks the test.
    expect(hashDeviceToken(deviceToken("device-token-fixture"))).toBe(
      "a9c14f6e79a480aa0412075563c974fa4434b57fed73afe3360188a871fd7998",
    );
    expect(hashDeviceToken(deviceToken("another-token"))).toBe(
      "9e78bcb94091b75109fd6773524fc8d6a4f8a6dfb3dae39a9c26c5001879bcf3",
    );
  });

  it("is deterministic — the same token always hashes the same (so a verifier can compare)", () => {
    const token = mintDeviceToken();
    expect(hashDeviceToken(token)).toBe(hashDeviceToken(token));
  });

  it("maps distinct tokens to distinct hashes", () => {
    const hashes = new Set(Array.from({ length: 100 }, () => hashDeviceToken(mintDeviceToken())));
    expect(hashes.size).toBe(100);
  });

  it("is one-way — the hash never carries the raw token (never in plaintext, AC1)", () => {
    const token = mintDeviceToken();
    const hash = hashDeviceToken(token);
    expect(hash).not.toContain(token);
    expect(hash).not.toBe(token as string);
  });
});
