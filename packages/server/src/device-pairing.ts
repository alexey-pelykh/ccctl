// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Server-side crypto for QR-pair onboarding (#74) + device persistence (#84): the two
 * runtime-coupled pieces of the device-token lifecycle. #74 mints a fresh per-device token
 * from CSPRNG randomness; #84 hashes a minted token into its at-rest {@link DeviceTokenHash}.
 * The pure encode/redact contract — the {@link DeviceToken}/{@link DeviceTokenHash} brands, the
 * pairing-URL builder, its loggable projection, and the persisted {@link PairedDevice} record +
 * {@link IDeviceStore} seam — lives in {@link https://ccctl | @ccctl/core}; this module owns only
 * what needs `node:crypto`: {@link mintDeviceToken} and {@link hashDeviceToken}.
 *
 * The durable, named device store itself (the file backend behind {@link IDeviceStore}) is
 * `device-store-file.ts` (#84). Server-side VERIFICATION of a token a device later presents
 * remains a later credentialed-wave item — this module hashes a token FOR storage but
 * introduces no ingress guard, so the single account-level auth model (security-posture.md) is
 * untouched.
 */

import { createHash, randomBytes } from "node:crypto";
import { deviceToken, deviceTokenHash, type DeviceToken, type DeviceTokenHash } from "@ccctl/core";

/**
 * The number of random bytes behind a minted token. 32 bytes is 256 bits of entropy —
 * ample for a bearer secret, and collision-free in practice, which is what makes every
 * mint "distinct per device". Named so the mint and its tests reference the one value.
 */
export const DEVICE_TOKEN_BYTES = 32;

/**
 * The source of the random bytes a minted token is built from. Injectable (parallel to
 * the tunnel adapters' {@link https://ccctl | CommandRunner} seam) so minting is
 * deterministic under test without mocking global crypto; defaults to `node:crypto`'s
 * CSPRNG {@link randomBytes}.
 */
export type RandomBytesSource = (size: number) => Buffer;

/**
 * Mint a fresh per-device access token (#74): {@link DEVICE_TOKEN_BYTES} of CSPRNG
 * randomness, base64url-encoded so it rides a URL fragment without escaping. Distinct
 * per call — two mints never collide at 256 bits — which is the "distinct per device"
 * guarantee. The randomness source is injectable (defaulting to {@link randomBytes}) so a
 * test asserts the encoding deterministically.
 *
 * Returns the token to the caller (the daemon prints it as a QR); it is deliberately NOT
 * persisted or logged here — hashing a minted token into the at-rest form a device store keeps
 * is its sibling {@link hashDeviceToken} (#84), and the token's only intended exit surface is
 * the scannable QR.
 */
export function mintDeviceToken(randomBytesSource: RandomBytesSource = randomBytes): DeviceToken {
  return deviceToken(randomBytesSource(DEVICE_TOKEN_BYTES).toString("base64url"));
}

/**
 * The one-way hash algorithm the at-rest device-token digest ({@link hashDeviceToken}) is built
 * with. A device token is {@link DEVICE_TOKEN_BYTES} (256 bits) of CSPRNG randomness, NOT a
 * low-entropy human password — so a fast cryptographic hash (SHA-256), not a deliberately-slow
 * password KDF (argon2/bcrypt/scrypt), is the correct choice: a slow KDF exists to blunt
 * brute-force on GUESSABLE passwords, and a 256-bit random secret is not brute-forceable. This
 * is the standard way high-entropy API tokens are stored. Named so the hash and its tests
 * reference the one algorithm.
 */
export const DEVICE_TOKEN_HASH_ALGORITHM = "sha256";

/**
 * Hash a minted {@link DeviceToken} into its at-rest {@link DeviceTokenHash} (#84): a
 * {@link DEVICE_TOKEN_HASH_ALGORITHM} digest, hex-encoded. This is the ONLY form of a device
 * token that is persisted (the durable store keeps this, never the raw secret — the "never in
 * plaintext at rest" guarantee, AC1). Deterministic — the same token always hashes the same,
 * which is what lets a future credentialed-wave verifier hash a presented token and compare it
 * against the stored hash — and one-way, so a leaked store yields no usable credential.
 *
 * No salt: a per-record salt defends a LOW-entropy secret against a precomputed (rainbow) table,
 * which a 256-bit CSPRNG token does not need — and an unsalted digest keeps the future
 * verify-time check a direct hash-and-compare rather than a per-record salted rehash.
 */
export function hashDeviceToken(token: DeviceToken): DeviceTokenHash {
  return deviceTokenHash(createHash(DEVICE_TOKEN_HASH_ALGORITHM).update(token).digest("hex"));
}
