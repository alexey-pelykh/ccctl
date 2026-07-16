// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The server-side panic kill (#88 / W6-20): revoke EVERY paired device at once and force
 * re-pairing, over an {@link IDeviceStore}. This is the "reachable server-side" half of the
 * revoke-all control — a named `@ccctl/server` capability the `ccctl revoke-all` CLI verb drives,
 * and the one a future credentialed-wave daemon route would reuse rather than re-implement.
 *
 * `@ccctl/core` owns the pure primitive ({@link revokeAllDevices}, which empties a snapshot's
 * registry); this module owns the load → transform → save orchestration over the persistence seam,
 * the sibling of `device-store-file.ts`'s backend (core = the runtime-agnostic transform, server =
 * the store-coupled I/O). Adapter-agnostic by construction (AC3): it touches only the device store,
 * never a tunnel adapter, so a panic kill works identically whatever adapter (or none) is in use —
 * and works even when the daemon or its tunnel is down, which is exactly when a panic control is
 * reached.
 */

import { revokeAllDevices, type IDeviceStore } from "@ccctl/core";

/**
 * Revoke every paired device in `store` in one action, returning the number of devices that were
 * revoked. Loads the current snapshot, empties its registry via {@link revokeAllDevices} (dropping
 * every {@link https://ccctl | DeviceTokenHash} — the token's only at-rest projection — so every
 * existing token is refused on next use and every device must re-pair, AC1), and persists the
 * emptied snapshot.
 *
 * A never-saved store (`load` → `null`, no device ever paired) and an explicitly-empty registry
 * both revoke NOTHING: the function returns `0` WITHOUT a save. Not saving over the `null` case
 * honours the store's "absence is `null`, never a fabricated empty registry" contract (a save would
 * invent one); skipping the no-op save over the already-empty case keeps a double panic-kill
 * idempotent and touches no disk. Only a registry with at least one device is emptied and written.
 */
export async function revokeAllPairedDevices(store: IDeviceStore): Promise<number> {
  const snapshot = await store.load();
  if (snapshot === null || snapshot.devices.length === 0) {
    return 0;
  }
  const revokedCount = snapshot.devices.length;
  await store.save(revokeAllDevices(snapshot));
  return revokedCount;
}
