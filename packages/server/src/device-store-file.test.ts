// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_STORE_SNAPSHOT_VERSION,
  deviceTokenHash,
  pairedDevice,
  renameDevice,
  type DeviceStoreSnapshot,
  type PairedDevice,
} from "@ccctl/core";
import {
  createFileDeviceStore,
  DEVICE_STORE_DIR_MODE,
  DEVICE_STORE_FILE_MODE,
  DEVICE_STORE_FILE_NAME,
  resolveDeviceStorePath,
} from "./device-store-file.js";
import { CCCTL_STATE_DIR, XDG_STATE_HOME_ENV } from "./session-store-file.js";
import { hashDeviceToken, mintDeviceToken } from "./device-pairing.js";

// A fixed epoch so every fixture is deterministic — the model's injectable `now` means no
// test reads a real clock (mirrors session-store-file.test.ts).
const T0 = 1_000_000;

/** Distinctive at-rest hashes per fixture device. */
const HASH_A = deviceTokenHash("a".repeat(64));
const HASH_B = deviceTokenHash("b".repeat(64));

/** A representative paired-device registry — a phone, a tablet, a laptop for one operator. */
const devices: readonly PairedDevice[] = [
  pairedDevice({ id: "dev-phone", name: "Alex's phone", tokenHash: HASH_A, now: T0 }),
  pairedDevice({ id: "dev-tablet", name: "kitchen tablet", tokenHash: HASH_B, now: T0 + 5 }),
];

/** A full, non-empty snapshot fixture. */
function snapshotFixture(): DeviceStoreSnapshot {
  return { version: DEVICE_STORE_SNAPSHOT_VERSION, devices };
}

/** Permission bits (mask off the file-type bits) of a path. */
async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("createFileDeviceStore", () => {
  // One temp-dir harness for every file-touching concern below — vitest inherits these hooks
  // into the nested describes, so each test still gets a fresh, isolated dir.
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccctl-device-store-"));
    filePath = join(dir, DEVICE_STORE_FILE_NAME);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("round-trip + restart persistence (AC1)", () => {
    it("returns null before anything is saved — a fresh daemon has no device paired", async () => {
      const store = createFileDeviceStore(filePath);
      expect(await store.load()).toBeNull();
    });

    it("round-trips the paired-device registry through a save/load cycle", async () => {
      const store = createFileDeviceStore(filePath);
      await store.save(snapshotFixture());
      const loaded = await store.load();
      expect(loaded?.devices).toEqual(devices);
    });

    it("round-trips the full snapshot deep-equal — it survives JSON serialisation unchanged", async () => {
      const store = createFileDeviceStore(filePath);
      const snapshot = snapshotFixture();
      await store.save(snapshot);
      expect(await store.load()).toEqual(snapshot);
    });

    it("preserves the schema version across the round-trip", async () => {
      const store = createFileDeviceStore(filePath);
      await store.save(snapshotFixture());
      expect((await store.load())?.version).toBe(DEVICE_STORE_SNAPSHOT_VERSION);
    });

    it("round-trips an empty registry — a hub with no device paired yet, saved explicitly", async () => {
      const store = createFileDeviceStore(filePath);
      const empty: DeviceStoreSnapshot = { version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [] };
      await store.save(empty);
      expect(await store.load()).toEqual(empty);
    });

    it("a later save replaces the prior snapshot", async () => {
      const store = createFileDeviceStore(filePath);
      await store.save(snapshotFixture());
      const replacement: DeviceStoreSnapshot = {
        version: DEVICE_STORE_SNAPSHOT_VERSION,
        devices: [pairedDevice({ id: "dev-only", name: "laptop", tokenHash: HASH_A, now: T0 + 100 })],
      };
      await store.save(replacement);
      expect(await store.load()).toEqual(replacement);
    });

    it("survives a restart — a NEW store instance at the same path loads what the prior one saved", async () => {
      // The load-bearing AC1 property ("reload after a restart"): the state lives on disk, not
      // in the instance. A second `createFileDeviceStore` at the same path — standing in for the
      // daemon coming back up — reads the first's snapshot.
      const snapshot = snapshotFixture();
      await createFileDeviceStore(filePath).save(snapshot);
      const afterRestart = createFileDeviceStore(filePath);
      expect(await afterRestart.load()).toEqual(snapshot);
    });

    it("creates the parent state directory if it does not exist", async () => {
      const nested = join(dir, "nested", "state", DEVICE_STORE_FILE_NAME);
      const store = createFileDeviceStore(nested);
      await store.save(snapshotFixture());
      expect(await store.load()).toEqual(snapshotFixture());
    });
  });

  describe("naming, renaming, and listing across a save/load cycle (AC2/AC4)", () => {
    it("lists every currently-paired device, in order, after a reload (AC4)", async () => {
      const registry: readonly PairedDevice[] = [
        pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH_A, now: T0 }),
        pairedDevice({ id: "dev-2", name: "tablet", tokenHash: HASH_B, now: T0 + 10 }),
        pairedDevice({ id: "dev-3", name: "laptop", tokenHash: HASH_A, now: T0 + 20 }),
      ];
      const store = createFileDeviceStore(filePath);
      await store.save({ version: DEVICE_STORE_SNAPSHOT_VERSION, devices: registry });
      const loaded = await store.load();
      expect(loaded?.devices.map((device) => device.name)).toEqual(["phone", "tablet", "laptop"]);
      expect(loaded?.devices).toHaveLength(3);
    });

    it("persists a rename — the renamed device, and only its name, survives a reload (AC2)", async () => {
      const store = createFileDeviceStore(filePath);
      await store.save({
        version: DEVICE_STORE_SNAPSHOT_VERSION,
        devices: [pairedDevice({ id: "dev-1", name: "phone", tokenHash: HASH_A, now: T0 })],
      });

      // Rename the loaded record and persist the updated registry (the whole snapshot is replaced).
      const loaded = await store.load();
      const renamed = (loaded?.devices ?? []).map((device) =>
        device.id === "dev-1" ? renameDevice(device, "Alex's phone") : device,
      );
      await store.save({ version: DEVICE_STORE_SNAPSHOT_VERSION, devices: renamed });

      const afterRename = await store.load();
      expect(afterRename?.devices[0]?.name).toBe("Alex's phone");
      // Everything else — id, createdAt, and the token hash — is intact across the rename + round-trip.
      expect(afterRename?.devices[0]?.id).toBe("dev-1");
      expect(afterRename?.devices[0]?.createdAt).toBe(T0);
      expect(afterRename?.devices[0]?.tokenHash).toBe(HASH_A);
    });
  });

  describe("0600 file permissions", () => {
    it("writes the snapshot file owner-read/write only (0600)", async () => {
      await createFileDeviceStore(filePath).save(snapshotFixture());
      expect(await fileMode(filePath)).toBe(DEVICE_STORE_FILE_MODE);
      expect(DEVICE_STORE_FILE_MODE).toBe(0o600);
    });

    it("forces 0600 even over a pre-existing looser-mode file", async () => {
      // The atomic temp-write + rename replaces the destination inode entirely, so a file left
      // 0644 (which writeFile's `mode` would NOT tighten in place) still ends up 0600 — the exact
      // trap the temp+chmod+rename dance defeats.
      await writeFile(filePath, "stale", { mode: 0o644 });
      await chmod(filePath, 0o644);
      expect(await fileMode(filePath)).toBe(0o644);

      await createFileDeviceStore(filePath).save(snapshotFixture());
      expect(await fileMode(filePath)).toBe(0o600);
    });

    it("creates the state directory owner-only (0700)", async () => {
      const nested = join(dir, "fresh-state", DEVICE_STORE_FILE_NAME);
      await createFileDeviceStore(nested).save(snapshotFixture());
      expect(await fileMode(join(dir, "fresh-state"))).toBe(DEVICE_STORE_DIR_MODE);
      expect(DEVICE_STORE_DIR_MODE).toBe(0o700);
    });
  });

  describe("no plaintext token at rest (AC1)", () => {
    it("writes a JSON object with exactly the snapshot's top-level keys", async () => {
      await createFileDeviceStore(filePath).save(snapshotFixture());
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["devices", "version"]);
    });

    it("persists each device as exactly {id, name, createdAt, lastSeen, tokenHash} — no raw-token field", async () => {
      await createFileDeviceStore(filePath).save(snapshotFixture());
      const loaded = await createFileDeviceStore(filePath).load();
      const first = loaded?.devices[0];
      expect(first && Object.keys(first).sort()).toEqual(["createdAt", "id", "lastSeen", "name", "tokenHash"]);
    });

    // The load-bearing AC1 guard: a device whose token was genuinely minted then hashed is
    // persisted, yet the on-disk bytes carry the raw token ZERO times — only its one-way hash.
    // This is the runtime guard the compile-time proof cannot be, since a `DeviceToken` is itself
    // a JSON-safe branded string (the proof does NOT exclude it); the omission-by-construction
    // (PairedDevice has no `token` field) plus THIS literal grep are what guarantee it.
    it("persists a minted-then-hashed device, yet writes the raw token to disk ZERO times", async () => {
      const token = mintDeviceToken();
      const tokenHash = hashDeviceToken(token);
      const device = pairedDevice({ id: "dev-1", name: "Alex's phone", tokenHash, now: T0 });
      const snapshot: DeviceStoreSnapshot = { version: DEVICE_STORE_SNAPSHOT_VERSION, devices: [device] };

      const store = createFileDeviceStore(filePath);
      await store.save(snapshot);

      // Degenerate-subject guard: prove the file actually holds the device, so "zero occurrences"
      // is a real absence — not a vacuous grep over an empty file.
      expect(await store.load()).toEqual(snapshot);

      const onDisk = await readFile(filePath, "utf8");
      // The raw minted token never appears; its hash — what a paired device DOES persist — is present.
      expect(onDisk).not.toContain(token);
      expect(onDisk).toContain(tokenHash);
    });
  });

  describe("fail closed on a corrupt or drifted snapshot", () => {
    it("throws, naming the path, when the file is not valid JSON", async () => {
      await writeFile(filePath, "{ not json", { mode: 0o600 });
      const store = createFileDeviceStore(filePath);
      await expect(store.load()).rejects.toThrow(/not valid JSON/);
      await expect(store.load()).rejects.toThrow(filePath);
    });

    it("throws a branded error, naming the path, when the file content is a bare JSON null", async () => {
      // A literal `null` is well-formed JSON but not a snapshot — it must fail closed with the
      // branded error, not an unbranded TypeError from dereferencing `.version` on null.
      await writeFile(filePath, "null", { mode: 0o600 });
      const store = createFileDeviceStore(filePath);
      await expect(store.load()).rejects.toThrow(/not a JSON object/);
      await expect(store.load()).rejects.toThrow(filePath);
    });

    it("throws, naming the path and version, when the snapshot version drifts", async () => {
      const drifted = { version: DEVICE_STORE_SNAPSHOT_VERSION + 1, devices: [] };
      await writeFile(filePath, JSON.stringify(drifted), { mode: 0o600 });
      const store = createFileDeviceStore(filePath);
      await expect(store.load()).rejects.toThrow(new RegExp(`version ${DEVICE_STORE_SNAPSHOT_VERSION + 1}`));
      await expect(store.load()).rejects.toThrow(filePath);
    });
  });
});

describe("resolveDeviceStorePath — XDG state path resolution", () => {
  it("honours an absolute XDG_STATE_HOME", () => {
    expect(resolveDeviceStorePath({ [XDG_STATE_HOME_ENV]: "/xdg/state" }, "/home/tester")).toBe(
      join("/xdg/state", CCCTL_STATE_DIR, DEVICE_STORE_FILE_NAME),
    );
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveDeviceStorePath({}, "/home/tester")).toBe(
      join("/home/tester", ".local", "state", CCCTL_STATE_DIR, DEVICE_STORE_FILE_NAME),
    );
  });

  it("falls back when XDG_STATE_HOME is empty or relative (spec: absolute only)", () => {
    const expected = join("/home/tester", ".local", "state", CCCTL_STATE_DIR, DEVICE_STORE_FILE_NAME);
    expect(resolveDeviceStorePath({ [XDG_STATE_HOME_ENV]: "" }, "/home/tester")).toBe(expected);
    expect(resolveDeviceStorePath({ [XDG_STATE_HOME_ENV]: "relative/state" }, "/home/tester")).toBe(expected);
  });

  it("shares the ccctl state directory with the session store — a sibling snapshot, distinct file", () => {
    // Both stores resolve under `$XDG_STATE_HOME/ccctl/`; only the file name differs, so a device
    // store and a session store never collide but live side by side.
    const devicePath = resolveDeviceStorePath({ [XDG_STATE_HOME_ENV]: "/xdg/state" }, "/home/tester");
    expect(devicePath.endsWith(join(CCCTL_STATE_DIR, DEVICE_STORE_FILE_NAME))).toBe(true);
    expect(DEVICE_STORE_FILE_NAME).toBe("device-store.json");
  });
});
