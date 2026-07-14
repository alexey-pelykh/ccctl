// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Server-side minting for QR-pair onboarding (#74). The pure encode/redact contract
 * — the {@link DeviceToken} brand, the pairing-URL builder, and its loggable
 * projection — lives in {@link https://ccctl | @ccctl/core}; this module owns the one
 * runtime-coupled piece: drawing CSPRNG randomness to mint a fresh token.
 *
 * This slice is MINTING ONLY. Persisting the minted tokens durably and hashed, with a
 * human-readable name, is #84 (W3-10); verifying a token a device later presents is a
 * later credentialed-wave item. Neither a token store nor an ingress guard is introduced
 * here — the daemon mints a token, encodes it into a QR, and that is the whole of #74's
 * server surface.
 */

import { randomBytes } from "node:crypto";
import { deviceToken, type DeviceToken } from "@ccctl/core";

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
 * persisted or logged here — durable, hashed persistence is #84 (W3-10), and the token's
 * only intended exit surface is the scannable QR.
 */
export function mintDeviceToken(randomBytesSource: RandomBytesSource = randomBytes): DeviceToken {
  return deviceToken(randomBytesSource(DEVICE_TOKEN_BYTES).toString("base64url"));
}
