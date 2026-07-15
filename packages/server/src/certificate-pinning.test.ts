// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spkiPin, type SpkiPin } from "@ccctl/core";
import {
  assertPinnedServerKey,
  CertificatePinMismatchError,
  computeSpkiPin,
  SPKI_PIN_HASH_ALGORITHM,
} from "./certificate-pinning.js";

/** A fresh EC P-256 key pair — real keys from `node:crypto`, no cert-gen dependency (#59, Option B). */
function freshKey() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
}

describe("computeSpkiPin (the node:crypto SPKI reduction, sibling to hashDeviceToken, #59)", () => {
  it("is a known-answer base64 SHA-256 (no live crypto in the assertion)", () => {
    // Golden vector: `printf '%s' 'test-spki-fixture' | shasum -a 256 | xxd -r -p | base64`.
    // computeSpkiPin hashes the DER bytes it is given; feeding a fixed byte string pins the exact
    // algorithm + encoding, so a silent switch to a different hash or to base64url breaks this.
    expect(computeSpkiPin(Buffer.from("test-spki-fixture"))).toBe("tN9pCx2zpTGAVaVrMMQTzhE10whVBsc2WZKfoUCXZqc=");
    expect(SPKI_PIN_HASH_ALGORITHM).toBe("sha256");
  });

  it("produces a valid SPKI-pin shape from a real public key (44 base64 chars ending in '=')", () => {
    const pin = computeSpkiPin(freshKey());
    expect(pin).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // The brand constructor accepts it — the shape is a real pin, not just regex-lucky.
    expect(spkiPin(pin)).toBe(pin);
  });

  it("agrees on a KeyObject and its raw DER SPKI bytes — the live `PeerCertificate.pubkey` path", () => {
    const key = freshKey();
    const der = key.export({ type: "spki", format: "der" });
    // A live TLS handshake hands the worker `cert.pubkey` (DER SPKI Buffer); a keygen/test path
    // hands a KeyObject. Both MUST reduce to the same pin, or the two paths would disagree.
    expect(computeSpkiPin(der)).toBe(computeSpkiPin(key));
  });

  it("is deterministic per key and distinct across keys", () => {
    const key = freshKey();
    expect(computeSpkiPin(key)).toBe(computeSpkiPin(key));
    const pins = new Set(Array.from({ length: 50 }, () => computeSpkiPin(freshKey())));
    expect(pins.size).toBe(50);
  });
});

describe("assertPinnedServerKey (the worker's pin guard, #59)", () => {
  it("accepts the expected pinned certificate — the channel may establish (AC2)", () => {
    const server = freshKey();
    const pinned = [computeSpkiPin(server)];
    expect(() => assertPinnedServerKey(server, pinned)).not.toThrow();
    // The live-handshake Buffer form is accepted identically.
    expect(() => assertPinnedServerKey(server.export({ type: "spki", format: "der" }), pinned)).not.toThrow();
  });

  it("rejects a substituted certificate — no channel establishes (AC3)", () => {
    const pinned = [computeSpkiPin(freshKey())];
    const substituted = freshKey();
    expect(() => assertPinnedServerKey(substituted, pinned)).toThrow(CertificatePinMismatchError);
  });

  it("names the presented pin on rejection — a public-key hash, safe to surface for an operator log (AC3)", () => {
    const pinned = [computeSpkiPin(freshKey())];
    const substituted = freshKey();
    const expectedPin = computeSpkiPin(substituted);
    try {
      assertPinnedServerKey(substituted, pinned);
      expect.unreachable("a substituted key must be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(CertificatePinMismatchError);
      expect((err as CertificatePinMismatchError).presentedPin).toBe(expectedPin);
      expect((err as CertificatePinMismatchError).message).toContain("not pinned");
    }
  });

  it("keeps trusting a leaf REISSUED with the same key — SPKI pinning survives renewal (AC4)", () => {
    const server = freshKey();
    const pinned = [computeSpkiPin(server)];
    // A reissued leaf carries the SAME SubjectPublicKeyInfo. Model it as a distinct KeyObject
    // re-imported from the same key material — same SPKI ⇒ same pin ⇒ still accepted.
    const reissuedLeafSameKey = createPublicKey(server.export({ type: "spki", format: "pem" }));
    expect(computeSpkiPin(reissuedLeafSameKey)).toBe(pinned[0]);
    expect(() => assertPinnedServerKey(reissuedLeafSameKey, pinned)).not.toThrow();
  });

  it("rejects a ROTATED key until it is re-pinned, and accepts BOTH during the overlap window (AC4)", () => {
    const oldKey = freshKey();
    const newKey = freshKey();
    const pinnedOld = [computeSpkiPin(oldKey)];
    // Rotate the server key without re-pinning: the new key is refused.
    expect(() => assertPinnedServerKey(newKey, pinnedOld)).toThrow(CertificatePinMismatchError);
    // Overlap window: pin BOTH keys — old and new are accepted; roll the server, then retire the old pin.
    const overlap: readonly SpkiPin[] = [computeSpkiPin(oldKey), computeSpkiPin(newKey)];
    expect(() => assertPinnedServerKey(oldKey, overlap)).not.toThrow();
    expect(() => assertPinnedServerKey(newKey, overlap)).not.toThrow();
  });

  it("fails closed on an empty pinned set — pinning against nothing is a misconfiguration", () => {
    const empty: readonly SpkiPin[] = [];
    expect(() => assertPinnedServerKey(freshKey(), empty)).toThrow(/at least one pinned key/);
  });
});
