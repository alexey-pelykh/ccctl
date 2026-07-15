// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { certificatePinMatches, spkiPin, type SpkiPin } from "./index.js";

// Real base64 SHA-256 digests (valid SPKI-pin shape): `printf '%s' <s> | shasum -a 256 | xxd -r -p | base64`.
// `+0X6…` opens with `+` and `n9AV…` carries `/`, so the fixtures exercise the full standard-base64 alphabet.
const PIN_A = "n9AV9bCrB5DP6PL5KV7PJaWqFwDbNRBvRzal5/S4gO8=";
const PIN_B = "+0X6UjqxqAp4qEtoDe95UC5lqh/3lmiNcEsShv5VjWs=";
const PIN_C = "p491joTUVbKjOL5CZ678jIODl9/3Y1nVm0sRT5qu2Sw=";

describe("spkiPin (the base64 SHA-256-of-SPKI brand, #59)", () => {
  it("accepts a valid pin (43 base64 chars + '=') and preserves its value", () => {
    expect(spkiPin(PIN_A)).toBe(PIN_A);
    // Full standard-base64 alphabet — a leading `+` and an embedded `/` are valid pin chars.
    expect(spkiPin(PIN_B)).toBe(PIN_B);
  });

  it("fails closed on a blank pin — a blank string is trivially not a digest", () => {
    expect(() => spkiPin("")).toThrow(/SPKI pin/);
    expect(() => spkiPin("   ")).toThrow(/SPKI pin/);
  });

  it("fails closed on a malformed pin, so a typo fails LOUD at config time (never a silent never-match)", () => {
    // Too short / too long: not a 32-byte digest.
    expect(() => spkiPin("YWJj")).toThrow(/SPKI pin/);
    expect(() => spkiPin(PIN_A + "extra")).toThrow(/SPKI pin/);
    // Missing the terminal `=` padding a 32-byte base64 always carries.
    expect(() => spkiPin(PIN_A.slice(0, -1))).toThrow(/SPKI pin/);
    // base64url (`-`/`_`) is NOT the RFC 7469 standard-base64 pin alphabet.
    expect(() => spkiPin("n9AV9bCrB5DP6PL5KV7PJaWqFwDbNRBvRzal5_S4gO8-")).toThrow(/SPKI pin/);
    // A stray space inside an otherwise well-formed pin.
    expect(() => spkiPin(PIN_A.slice(0, -2) + " =")).toThrow(/SPKI pin/);
  });
});

describe("certificatePinMatches (the pure 'trusted iff pinned' decision, #59)", () => {
  it("accepts a presented key that is the single pinned key (AC2)", () => {
    expect(certificatePinMatches([spkiPin(PIN_A)], spkiPin(PIN_A))).toBe(true);
  });

  it("rejects a presented key that is not pinned (AC3 — the reject decision)", () => {
    expect(certificatePinMatches([spkiPin(PIN_A)], spkiPin(PIN_C))).toBe(false);
  });

  it("accepts EITHER pin when multiple are pinned — the key-rotation overlap window (AC4)", () => {
    const pinned = [spkiPin(PIN_A), spkiPin(PIN_B)];
    expect(certificatePinMatches(pinned, spkiPin(PIN_A))).toBe(true);
    expect(certificatePinMatches(pinned, spkiPin(PIN_B))).toBe(true);
    // A third, un-pinned key is still rejected even with two pins present.
    expect(certificatePinMatches(pinned, spkiPin(PIN_C))).toBe(false);
  });

  it("fails CLOSED on an empty pinned set — pinning against nothing is a misconfiguration, not 'trust all'", () => {
    const empty: readonly SpkiPin[] = [];
    expect(() => certificatePinMatches(empty, spkiPin(PIN_A))).toThrow(/at least one pinned key/);
  });
});
