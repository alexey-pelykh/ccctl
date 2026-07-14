// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  DEVICE_STORE_SNAPSHOT_VERSION,
  deviceTokenHash,
  pairedDevice,
  renameDevice,
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
