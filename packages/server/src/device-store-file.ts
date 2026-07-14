// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The single-file JSON-snapshot {@link IDeviceStore} backend (#84 / W3-10) — the concrete
 * persistence the hub's paired-device registry survives a daemon restart on, so one operator
 * can manage several paired devices (phone, tablet, laptop) across restarts.
 *
 * `@ccctl/core` defines the CONTRACT (the JSON-safe {@link DeviceStoreSnapshot} shape, the
 * {@link PairedDevice} record, and the {@link IDeviceStore} load/save seam) and deliberately
 * ships no backend: a concrete store is Node-coupled I/O (`fs`, an XDG state path), so it lives
 * here in `@ccctl/server` while core stays runtime-agnostic (CORE-C-001). This is that backend —
 * one file, one JSON object, `0600` — the exact structural mirror of the file session store
 * ({@link createFileSessionStore}), a sibling snapshot at the same XDG state location.
 *
 * **Three guarantees, mapped to the acceptance criteria:**
 *
 *   1. **Round-trip across a restart (AC1/AC4).** {@link IDeviceStore.save} writes the whole
 *      snapshot; {@link IDeviceStore.load} reads it back deep-equal on the next start — so every
 *      paired device (its `{id, name, createdAt, lastSeen, tokenHash}`) survives, and listing is
 *      reading the loaded `devices`. A never-saved store loads `null` (a fresh daemon, no device
 *      ever paired), never a fabricated empty registry — so a caller can tell "nothing paired"
 *      from "explicitly-saved empty registry" (the core round-trip contract).
 *   2. **`0600` file permissions.** The snapshot is written owner-read/write only, and the mode
 *      is FORCED — see {@link save}'s atomic temp-write + `chmod` + `rename`, which holds `0600`
 *      regardless of the umask or a pre-existing looser file.
 *   3. **No plaintext token at rest (AC1).** Guaranteed UPSTREAM, by construction: a
 *      {@link PairedDevice} carries a {@link DeviceTokenHash} and has NO field for the raw
 *      {@link https://ccctl | DeviceToken}, so the minted secret cannot reach a snapshot — only
 *      its one-way hash does. This backend only serialises that already-safe shape; it invents no
 *      field, so it cannot re-introduce the secret. A runtime at-rest grep (the minted token
 *      appears ZERO times on disk while its hash is present) complements the omission in the test
 *      suite — the technique the compile-time proof cannot be, since a `DeviceToken` is itself a
 *      JSON-safe branded string.
 *
 * **Atomicity + fail-closed.** A save is crash-safe (temp file → atomic `rename`, so a reader
 * never sees a half-written file), and a load fails CLOSED on a corrupt or version-drifted
 * snapshot with a branded, path-naming error — the same pin-and-fail-closed posture the session
 * store takes, in the same guardrail voice as {@link brandListenError} /
 * {@link requireLocalServerAuth}. Single-writer by design: one daemon owns its state file.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEVICE_STORE_SNAPSHOT_VERSION, type DeviceStoreSnapshot, type IDeviceStore } from "@ccctl/core";
// The XDG *state* home env var and the ccctl app state directory are app-global — the file
// session store (#23) established `$XDG_STATE_HOME/ccctl/` as ccctl's state location; this sibling
// store persists alongside it under the same directory, so it reuses those two constants rather
// than re-declaring (and risking drift from) them. Only this backend's own file name + modes are
// local below.
import { CCCTL_STATE_DIR, XDG_STATE_HOME_ENV } from "./session-store-file.js";

/** The device-store snapshot file's name under {@link CCCTL_STATE_DIR}. */
export const DEVICE_STORE_FILE_NAME = "device-store.json";

/**
 * The snapshot file's permission bits — owner read/write only (`0600`). The hard acceptance
 * criterion; {@link createFileDeviceStore}'s `save` forces exactly this.
 */
export const DEVICE_STORE_FILE_MODE = 0o600;

/**
 * The state directory's permission bits — owner-only (`0700`), applied when the directory is
 * CREATED. Defense-in-depth so a `0600` file is not reachable through a group/other-traversable
 * parent; the file's own `0600` remains the load-bearing guarantee (an already-existing operator
 * directory is not force-tightened).
 */
export const DEVICE_STORE_DIR_MODE = 0o700;

/**
 * Resolve the default snapshot path: `$XDG_STATE_HOME/ccctl/device-store.json`, falling back to
 * `~/.local/state/ccctl/device-store.json`. Per the XDG Base Directory spec, `$XDG_STATE_HOME` is
 * honoured ONLY when set to an ABSOLUTE path; unset, empty, or relative all fall back to
 * `$HOME/.local/state` (a relative XDG base is spec-invalid and would otherwise resolve against
 * the process cwd — a footgun). The exact resolution the file session store uses, differing only
 * in the file name.
 *
 * `env` and `home` are injectable seams so the resolution is unit-testable without touching the
 * real environment or home directory.
 */
export function resolveDeviceStorePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env[XDG_STATE_HOME_ENV]?.trim();
  const stateHome =
    configured !== undefined && configured !== "" && isAbsolute(configured)
      ? configured
      : join(home, ".local", "state");
  return join(stateHome, CCCTL_STATE_DIR, DEVICE_STORE_FILE_NAME);
}

/** Monotonic per-process sequence making each in-flight temp file name unique. */
let saveSequence = 0;

/**
 * A single-file JSON-snapshot {@link IDeviceStore}. Private — callers depend on the
 * {@link IDeviceStore} port through {@link createFileDeviceStore}, exactly as the file session
 * store exposes a factory over its port rather than a class.
 */
class FileDeviceStore implements IDeviceStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<DeviceStoreSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A fresh daemon: no device has ever been paired. Absence is `null`, never a
        // fabricated empty registry (the core round-trip contract).
        return null;
      }
      // A real I/O failure (EACCES, EISDIR, …) surfaces rather than masquerading as "fresh" —
      // silently swallowing it would drop the operator's paired devices on a transient
      // permission glitch.
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Branded + fail-closed, without leaking the raw Node parser string into the message
      // (brandListenError's principle); the underlying SyntaxError is chained as `cause`.
      throw new Error(
        `ccctl: the device-store snapshot at ${this.#filePath} is not valid JSON — ` +
          `remove the file to start fresh.`,
        { cause: error },
      );
    }

    // A bare JSON `null` (or any non-object primitive) is not a snapshot — fail closed with the
    // same branded error rather than letting the `.version` read below throw an unbranded
    // TypeError on `null`. Keeps the fail-closed branding uniform across every degenerate input
    // (an array falls through to the version gate, which rejects it too).
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `ccctl: the device-store snapshot at ${this.#filePath} is not a JSON object — ` +
          `remove the file to start fresh.`,
      );
    }

    // Fail closed on version drift: a snapshot written by a different schema version is not
    // silently mis-read as the current shape (the same pin-and-fail-closed posture core's
    // DEVICE_STORE_SNAPSHOT_VERSION invites). Migration, should it ever be needed, is a
    // deliberate future change; today an unknown version is a hard stop.
    const version = (parsed as { readonly version?: unknown }).version;
    if (version !== DEVICE_STORE_SNAPSHOT_VERSION) {
      throw new Error(
        `ccctl: the device-store snapshot at ${this.#filePath} is version ${String(version)}, ` +
          `but this build reads version ${DEVICE_STORE_SNAPSHOT_VERSION} — remove the file to start fresh.`,
      );
    }

    return parsed as DeviceStoreSnapshot;
  }

  async save(snapshot: DeviceStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: DEVICE_STORE_DIR_MODE });

    // Pretty-printed + trailing newline so the state file is human-inspectable (a POSIX text
    // file), which a JSON snapshot at rest usefully is.
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    // Atomic + exactly-0600. Write a uniquely-named temp in the SAME directory (so the rename is
    // atomic on one filesystem), created at 0600 so it is never briefly world-readable, then
    // `chmod` to FORCE exactly 0600 on that fresh inode: writeFile's mode is umask-masked, so a
    // pathological owner-clearing umask (e.g. 0o200) would otherwise leave the temp at 0o400 —
    // chmod pins it back. Then rename OVER the destination, which becomes the temp's fresh 0600
    // inode, so any pre-existing looser file there is replaced WHOLESALE rather than modified in
    // place (writeFile's mode is never applied to an existing file — the rename, not the chmod,
    // is what defeats that). A reader never sees a partial file.
    const tempPath = `${this.#filePath}.${process.pid}.${(saveSequence++).toString(36)}.tmp`;
    try {
      await writeFile(tempPath, serialized, { mode: DEVICE_STORE_FILE_MODE });
      await chmod(tempPath, DEVICE_STORE_FILE_MODE);
      await rename(tempPath, this.#filePath);
    } catch (error) {
      // Best-effort cleanup so a failed save leaves no orphaned temp behind; swallow the
      // cleanup's own error so the original failure is what surfaces.
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Create a single-file JSON-snapshot {@link IDeviceStore} at `filePath`, defaulting to the
 * resolved XDG state path ({@link resolveDeviceStorePath}). The default keeps the daemon
 * call-site a bare `createFileDeviceStore()`; a test passes an explicit temp path. Returns the
 * {@link IDeviceStore} port — callers depend on the contract, not this backend.
 */
export function createFileDeviceStore(filePath: string = resolveDeviceStorePath()): IDeviceStore {
  return new FileDeviceStore(filePath);
}
