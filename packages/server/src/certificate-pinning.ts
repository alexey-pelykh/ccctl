// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Server-side crypto for worker↔server TLS certificate pinning (#59): reducing a server
 * certificate's public key to its SPKI pin, and the guard the worker runs to reject a
 * certificate whose key is not pinned. The pure contract — the {@link SpkiPin} brand and the
 * {@link certificatePinMatches} decision — lives in {@link https://ccctl | @ccctl/core}; this
 * module owns only what needs `node:crypto`: {@link computeSpkiPin}, the runtime-coupled
 * counterpart to {@link hashDeviceToken}.
 *
 * SCOPE (#59): this ships the load-bearing, unit-testable pinning MECHANISM — compute a pin,
 * accept the expected key, reject a substituted one, support a rotation overlap. Exercising it
 * over a LIVE loopback TLS handshake (a worker socket that actually speaks TLS, runs this guard,
 * and rejects a plaintext endpoint — AC1) lands with the real patched worker in #67, the same
 * hard gate every prior security slice defers real-worker proof to (see
 * `docs/security-posture.md`). No certificate is generated or served here — the guard operates
 * on a certificate a server PRESENTS, so there is no cert-gen dependency.
 */

import { createHash, type KeyObject } from "node:crypto";
import { certificatePinMatches, spkiPin, type SpkiPin } from "@ccctl/core";

/**
 * The hash a {@link SpkiPin} is built with: SHA-256 over the DER SubjectPublicKeyInfo — the
 * RFC 7469 `pin-sha256` construction. A device token is a raw secret hashed for at-rest storage
 * ({@link DEVICE_TOKEN_HASH_ALGORITHM}); a pin is the identity of a PUBLIC key. Both are fast
 * cryptographic digests (no slow KDF — there is no low-entropy secret to protect). Named so the
 * computation and its known-answer test reference the one algorithm; a silent switch breaks the
 * test.
 */
export const SPKI_PIN_HASH_ALGORITHM = "sha256";

/**
 * Reduce a server public key to its {@link SpkiPin} (#59): the base64
 * {@link SPKI_PIN_HASH_ALGORITHM} digest of its DER-encoded SubjectPublicKeyInfo — the
 * runtime-coupled counterpart to {@link hashDeviceToken}. Accepts either a {@link KeyObject}
 * (e.g. `crypto.X509Certificate.publicKey`) or the raw DER SPKI bytes a live handshake exposes
 * as `tls.PeerCertificate.pubkey`, so the SAME reduction serves both the test/keygen path and
 * the eventual #67 live-socket path.
 *
 * Deterministic — the same key always yields the same pin — which is precisely what lets a
 * reissued leaf certificate sharing the key stay trusted, and a rotated key present a fresh pin
 * (AC4).
 */
export function computeSpkiPin(publicKey: KeyObject | Buffer): SpkiPin {
  const spkiDer = Buffer.isBuffer(publicKey) ? publicKey : publicKey.export({ type: "spki", format: "der" });
  return spkiPin(createHash(SPKI_PIN_HASH_ALGORITHM).update(spkiDer).digest("base64"));
}

/**
 * Raised when a presented server key is NOT one of the pinned keys — the "a substituted
 * certificate is rejected, and no worker channel is established" guarantee (AC3). A named type
 * so the worker's transport can catch precisely a pin failure (distinct from any other TLS
 * error) and fail the connection closed. Carries the presented pin for an operator log; a pin is
 * a hash of a PUBLIC key, so surfacing it leaks nothing.
 */
export class CertificatePinMismatchError extends Error {
  /** The presented (rejected) key's SPKI pin — a hash of a PUBLIC key, so safe to surface in a log. */
  readonly presentedPin: SpkiPin;

  constructor(presentedPin: SpkiPin) {
    super(`ccctl: the server certificate's key (SPKI pin ${presentedPin}) is not pinned; refusing the channel`);
    this.name = "CertificatePinMismatchError";
    this.presentedPin = presentedPin;
  }
}

/**
 * The pinning guard the worker runs against the certificate a server presents (#59): reduce the
 * presented key to its {@link SpkiPin} ({@link computeSpkiPin}) and accept iff it is one of
 * `pinnedKeys` ({@link certificatePinMatches}). Returns on a match — the channel may establish
 * (AC2); throws {@link CertificatePinMismatchError} on a mismatch — the channel must NOT
 * establish (AC3). `pinnedKeys` may hold more than one pin, which is the key-rotation overlap
 * window (AC4); an empty `pinnedKeys` fails closed (it is a misconfiguration, per
 * {@link certificatePinMatches}).
 *
 * Transport-agnostic BY DESIGN: it decides accept/reject on a key and leaves HOW that verdict
 * aborts a real socket — a `tls.connect` `checkServerIdentity` returning the error, or a
 * `secureConnect` handler destroying the socket — to the #67 transport wiring. That is the
 * deferred live-handshake boundary: the decision is delivered and tested here; the socket it
 * rides is #67's.
 */
export function assertPinnedServerKey(presentedKey: KeyObject | Buffer, pinnedKeys: readonly SpkiPin[]): void {
  const presented = computeSpkiPin(presentedKey);
  if (!certificatePinMatches(pinnedKeys, presented)) {
    throw new CertificatePinMismatchError(presented);
  }
}
