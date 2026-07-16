// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_STORE_SNAPSHOT_VERSION,
  deviceTokenHash,
  pairedDevice,
  type DeviceStoreSnapshot,
  type IDeviceStore,
} from "@ccctl/core";
import { revokeAllPairedDevices } from "./device-revoke-all.js";
import { createFileDeviceStore } from "./device-store-file.js";

// A fixed epoch so every fixture is deterministic (mirrors device-store-file.test.ts).
const T0 = 1_000_000;

/** Three paired devices — the populated registry a panic kill wipes. */
function threeDevices(): DeviceStoreSnapshot {
  return {
    version: DEVICE_STORE_SNAPSHOT_VERSION,
    devices: [
      pairedDevice({ id: "dev-1", name: "Alex's phone", tokenHash: deviceTokenHash("aaa"), now: T0 }),
      pairedDevice({ id: "dev-2", name: "tablet", tokenHash: deviceTokenHash("bbb"), now: T0 + 10 }),
      pairedDevice({ id: "dev-3", name: "laptop", tokenHash: deviceTokenHash("ccc"), now: T0 + 20 }),
    ],
  };
}

/**
 * A minimal in-memory {@link IDeviceStore} that records every `save` — so a test can assert
 * not just the returned count but WHETHER a save happened (the null / already-empty cases must
 * touch no disk).
 */
class InMemoryDeviceStore implements IDeviceStore {
  readonly saves: DeviceStoreSnapshot[] = [];
  #snapshot: DeviceStoreSnapshot | null;

  constructor(snapshot: DeviceStoreSnapshot | null) {
    this.#snapshot = snapshot;
  }

  load(): Promise<DeviceStoreSnapshot | null> {
    return Promise.resolve(this.#snapshot);
  }

  save(snapshot: DeviceStoreSnapshot): Promise<void> {
    this.saves.push(snapshot);
    this.#snapshot = snapshot;
    return Promise.resolve();
  }
}

describe("revokeAllPairedDevices (server-side panic kill, #88 / W6-20)", () => {
  it("empties a populated registry and returns how many devices were revoked (AC1)", async () => {
    const store = new InMemoryDeviceStore(threeDevices());

    const revoked = await revokeAllPairedDevices(store);

    expect(revoked).toBe(3);
    // Exactly one save, of an emptied registry with the version preserved.
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toEqual({ version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [] });
  });

  it("revokes NOTHING and does NOT save over a never-paired store (load → null)", async () => {
    // A fresh daemon: no device ever paired. Saving here would fabricate an empty registry,
    // breaking the store's "absence is null, never a fabricated empty registry" contract.
    const store = new InMemoryDeviceStore(null);

    const revoked = await revokeAllPairedDevices(store);

    expect(revoked).toBe(0);
    expect(store.saves).toHaveLength(0);
  });

  it("revokes NOTHING and does NOT save over an already-empty registry (idempotent, no disk touch)", async () => {
    const store = new InMemoryDeviceStore({ version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [] });

    const revoked = await revokeAllPairedDevices(store);

    expect(revoked).toBe(0);
    expect(store.saves).toHaveLength(0);
  });

  it("is idempotent — a second panic kill after one revokes nothing and writes nothing", async () => {
    const store = new InMemoryDeviceStore(threeDevices());

    expect(await revokeAllPairedDevices(store)).toBe(3);
    expect(await revokeAllPairedDevices(store)).toBe(0);
    // The registry was written once (the first kill); the second is a no-op that touches no disk.
    expect(store.saves).toHaveLength(1);
  });

  describe("against the real file device store (end-to-end)", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "ccctl-revoke-all-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("wipes a persisted registry so a subsequent load sees an empty one", async () => {
      const store = createFileDeviceStore(join(dir, "device-store.json"));
      await store.save(threeDevices());

      const revoked = await revokeAllPairedDevices(store);

      expect(revoked).toBe(3);
      // The panic kill is durable: a fresh load off disk sees the emptied registry, not the
      // three devices — every device must re-pair.
      const reloaded = await store.load();
      expect(reloaded).toEqual({ version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [] });
    });
  });
});
