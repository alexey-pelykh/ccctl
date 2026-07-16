// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  DEVICE_STORE_SNAPSHOT_VERSION,
  deviceTokenHash,
  pairedDevice,
  renameDevice,
  revokeAllDevices,
  revokeDevice,
  touchDevice,
  type DeviceStoreSnapshot,
  type PairedDevice,
} from "./index.js";

// A fixed epoch so every fixture is deterministic — the model's injectable `now` means no
// test reads a real clock (mirrors packages/core/src/session-store.test.ts).
const T0 = 1_000_000;

/** A representative hashed token — the at-rest form a paired device persists. */
const HASH = deviceTokenHash("a9c14f6e79a480aa0412075563c974fa4434b57fed73afe3360188a871fd7998");

describe("deviceTokenHash", () => {
  it("tags a non-empty string as a DeviceTokenHash", () => {
    expect(deviceTokenHash("deadbeef")).toBe("deadbeef");
  });

  it("rejects an empty or whitespace-only hash — a blank hash is not a digest", () => {
    expect(() => deviceTokenHash("")).toThrow(/non-empty/);
    expect(() => deviceTokenHash("   ")).toThrow(/non-empty/);
  });
});

describe("pairedDevice (freshly-paired device record, #84)", () => {
  it("starts createdAt and lastSeen both at `now` — pairing is the device's first sighting", () => {
    const device = pairedDevice({ id: "dev-1", name: "Alex's phone", tokenHash: HASH, now: T0 });
    expect(device).toEqual({
      id: "dev-1",
      name: "Alex's phone",
      createdAt: T0,
      lastSeen: T0,
      tokenHash: HASH,
    });
  });

  it("persists the token HASH, never a raw token — the record has no `token` field (AC1)", () => {
    const device = pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH, now: T0 });
    expect(device.tokenHash).toBe(HASH);
    expect(Object.keys(device).sort()).toEqual(["createdAt", "id", "lastSeen", "name", "tokenHash"]);
    expect(device).not.toHaveProperty("token");
  });

  it("trims the name", () => {
    expect(pairedDevice({ id: "dev-1", name: "  phone  ", tokenHash: HASH, now: T0 }).name).toBe("phone");
  });

  it("rejects a blank name — a blank human-readable name is not a name", () => {
    expect(() => pairedDevice({ id: "dev-1", name: "", tokenHash: HASH, now: T0 })).toThrow(/non-empty/);
    expect(() => pairedDevice({ id: "dev-1", name: "   ", tokenHash: HASH, now: T0 })).toThrow(/non-empty/);
  });
});

describe("renameDevice (AC2)", () => {
  const device = pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH, now: T0 });

  it("updates the name, preserving id, createdAt, lastSeen, and the token hash", () => {
    const renamed = renameDevice(device, "Alex's phone");
    expect(renamed).toEqual({
      id: "dev-1",
      name: "Alex's phone",
      createdAt: T0,
      lastSeen: T0,
      tokenHash: HASH,
    });
  });

  it("is pure — it never mutates the input record", () => {
    renameDevice(device, "renamed");
    expect(device.name).toBe("phone");
  });

  it("trims the new name and rejects a blank one — a rename cannot blank out a device's name", () => {
    expect(renameDevice(device, "  tablet  ").name).toBe("tablet");
    expect(() => renameDevice(device, "")).toThrow(/non-empty/);
    expect(() => renameDevice(device, "   ")).toThrow(/non-empty/);
  });
});

describe("touchDevice (last-seen, AC4)", () => {
  const device = pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH, now: T0 });

  it("advances lastSeen to `now`, preserving every other field", () => {
    const touched = touchDevice(device, T0 + 5_000);
    expect(touched).toEqual({ ...device, lastSeen: T0 + 5_000 });
    expect(touched.createdAt).toBe(T0);
  });

  it("is pure — it never mutates the input record", () => {
    touchDevice(device, T0 + 5_000);
    expect(device.lastSeen).toBe(T0);
  });
});

describe("revokeDevice (per-device revoke, #81 / W6-19)", () => {
  const phone = pairedDevice({ id: "dev-1", name: "Alex's phone", tokenHash: HASH, now: T0 });
  const tablet = pairedDevice({ id: "dev-2", name: "tablet", tokenHash: deviceTokenHash("beef"), now: T0 + 10 });
  const laptop = pairedDevice({ id: "dev-3", name: "laptop", tokenHash: deviceTokenHash("cafe"), now: T0 + 20 });
  const snapshot: DeviceStoreSnapshot = {
    version: DEVICE_STORE_SNAPSHOT_VERSION,
    devices: [phone, tablet, laptop],
  };

  it("removes the named device from the registry (AC1) — its record, and its token hash, are gone", () => {
    const revoked = revokeDevice(snapshot, "dev-1");
    expect(revoked.devices.map((device) => device.id)).toEqual(["dev-2", "dev-3"]);
    // The revoked device's ONLY at-rest token projection is gone, so a hash-and-compare verifier
    // (present or future) finds no match and refuses that token on its next use.
    expect(revoked.devices.some((device) => device.tokenHash === HASH)).toBe(false);
  });

  it("leaves every other device — and its token hash — untouched (AC2)", () => {
    const revoked = revokeDevice(snapshot, "dev-1");
    expect(revoked.devices).toEqual([tablet, laptop]);
    // Surviving records ride through unchanged, by reference — one device's revoke touches no other.
    expect(revoked.devices[0]).toBe(tablet);
    expect(revoked.devices[1]).toBe(laptop);
  });

  it("preserves the snapshot version and the order of the remaining devices", () => {
    const revoked = revokeDevice(snapshot, "dev-2");
    expect(revoked.version).toBe(DEVICE_STORE_SNAPSHOT_VERSION);
    expect(revoked.devices.map((device) => device.id)).toEqual(["dev-1", "dev-3"]);
  });

  it("is pure — it never mutates the input snapshot or its devices array", () => {
    revokeDevice(snapshot, "dev-1");
    expect(snapshot.devices.map((device) => device.id)).toEqual(["dev-1", "dev-2", "dev-3"]);
  });

  it("is idempotent over an absent id — a no-op returns an equal, freshly built snapshot, never throwing", () => {
    const revoked = revokeDevice(snapshot, "does-not-exist");
    expect(revoked).toEqual(snapshot);
    expect(revoked).not.toBe(snapshot);
    // A double-revoke (or one racing a concurrent revoke) settles to the same end state as one.
    expect(revokeDevice(revokeDevice(snapshot, "dev-1"), "dev-1").devices.map((device) => device.id)).toEqual([
      "dev-2",
      "dev-3",
    ]);
  });

  it("revoking the last device yields an explicitly-empty registry (the reachable empty state)", () => {
    const single: DeviceStoreSnapshot = { version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [phone] };
    const revoked = revokeDevice(single, "dev-1");
    expect(revoked.devices).toEqual([]);
    expect(revoked.version).toBe(DEVICE_STORE_SNAPSHOT_VERSION);
    // Still a valid snapshot that round-trips through JSON — listing it is an empty registry, not `null`.
    expect(JSON.parse(JSON.stringify(revoked))).toEqual(revoked);
  });
});

describe("revokeAllDevices (panic kill / whole-registry revoke, #88 / W6-20)", () => {
  const phone = pairedDevice({ id: "dev-1", name: "Alex's phone", tokenHash: HASH, now: T0 });
  const tablet = pairedDevice({ id: "dev-2", name: "tablet", tokenHash: deviceTokenHash("beef"), now: T0 + 10 });
  const laptop = pairedDevice({ id: "dev-3", name: "laptop", tokenHash: deviceTokenHash("cafe"), now: T0 + 20 });
  const snapshot: DeviceStoreSnapshot = {
    version: DEVICE_STORE_SNAPSHOT_VERSION,
    devices: [phone, tablet, laptop],
  };

  it("empties the whole registry in one action — every device, and every token hash, is gone (AC1)", () => {
    const revoked = revokeAllDevices(snapshot);
    expect(revoked.devices).toEqual([]);
    // No device's at-rest token projection survives, so a hash-and-compare verifier (present or
    // future) finds NO match for any previously-paired device and refuses every existing token.
    expect(revoked.devices.some((device) => device.tokenHash === HASH)).toBe(false);
  });

  it("is clearly distinct from per-device revoke — it drops ALL records, not one (AC4)", () => {
    // Per-device revoke leaves the other two; revoke-all leaves none. Same starting registry.
    expect(revokeDevice(snapshot, "dev-1").devices.map((device) => device.id)).toEqual(["dev-2", "dev-3"]);
    expect(revokeAllDevices(snapshot).devices).toEqual([]);
  });

  it("preserves the snapshot version — the emptied registry is still a valid snapshot", () => {
    const revoked = revokeAllDevices(snapshot);
    expect(revoked.version).toBe(DEVICE_STORE_SNAPSHOT_VERSION);
    // Round-trips through JSON: an explicitly-empty registry, never `null`.
    expect(JSON.parse(JSON.stringify(revoked))).toEqual(revoked);
  });

  it("is pure — it never mutates the input snapshot or its devices array", () => {
    revokeAllDevices(snapshot);
    expect(snapshot.devices.map((device) => device.id)).toEqual(["dev-1", "dev-2", "dev-3"]);
    // A fresh array is returned, not the input's array cleared in place.
    expect(revokeAllDevices(snapshot).devices).not.toBe(snapshot.devices);
  });

  it("is idempotent over an already-empty registry — a double panic-kill settles to the same end state", () => {
    const empty: DeviceStoreSnapshot = { version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [] };
    const revoked = revokeAllDevices(empty);
    expect(revoked).toEqual(empty);
    expect(revoked).not.toBe(empty);
    expect(revokeAllDevices(revokeAllDevices(snapshot)).devices).toEqual([]);
  });
});

describe("DeviceStoreSnapshot — JSON-safe registry shape", () => {
  it("round-trips a multi-device registry through JSON unchanged (the persistence contract)", () => {
    const snapshot: DeviceStoreSnapshot = {
      version: DEVICE_STORE_SNAPSHOT_VERSION,
      devices: [
        pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH, now: T0 }),
        pairedDevice({ id: "dev-2", name: "tablet", tokenHash: deviceTokenHash("beef"), now: T0 + 10 }),
      ],
    };
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("listing is the snapshot's devices — every currently-paired device (AC4)", () => {
    const devices: readonly PairedDevice[] = [
      pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH, now: T0 }),
      pairedDevice({ id: "dev-2", name: "laptop", tokenHash: deviceTokenHash("cafe"), now: T0 + 20 }),
    ];
    const snapshot: DeviceStoreSnapshot = { version: DEVICE_STORE_SNAPSHOT_VERSION, devices };
    expect(snapshot.devices.map((device) => device.id)).toEqual(["dev-1", "dev-2"]);
    expect(snapshot.devices).toHaveLength(2);
  });
});
