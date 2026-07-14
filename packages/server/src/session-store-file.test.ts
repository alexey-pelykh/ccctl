// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountBearer,
  createSession,
  SESSION_STORE_SNAPSHOT_VERSION,
  sessionIngressToken,
  WORK_SECRET_VERSION,
  type Session,
  type SessionStoreSnapshot,
  type UnreadEntry,
  type WorkSecret,
} from "@ccctl/core";
import {
  CCCTL_STATE_DIR,
  createFileSessionStore,
  resolveSessionStorePath,
  SESSION_STORE_FILE_MODE,
  SESSION_STORE_FILE_NAME,
  XDG_STATE_HOME_ENV,
} from "./session-store-file.js";

// A fixed epoch so every fixture is deterministic — the model's injectable `now`
// means no test reads a real clock (mirrors packages/core/src/session-store.test.ts).
const T0 = 1_000_000;

/** A representative session registry spanning the lifecycle/activity dimensions. */
const sessions: readonly Session[] = [
  { ...createSession("sess-running", T0), status: "ready", activity: { kind: "running" } },
  {
    ...createSession("sess-blocked", T0 + 5),
    status: "busy",
    activity: { kind: "requires_action", detail: "Approve tool use?" },
  },
  createSession("sess-fresh", T0 + 10),
];

/** A representative unread queue, ordered by `at`. */
const unread: readonly UnreadEntry[] = [
  { sessionId: "sess-blocked", at: T0 + 6, activity: { kind: "requires_action", detail: "Approve tool use?" } },
  { sessionId: "sess-running", at: T0 + 7, activity: { kind: "idle" } },
];

/** A full, non-empty snapshot fixture. */
function snapshotFixture(): SessionStoreSnapshot {
  return { version: SESSION_STORE_SNAPSHOT_VERSION, sessions, unread };
}

/** Permission bits (mask off the file-type bits) of a path. */
async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("createFileSessionStore", () => {
  // One temp-dir harness for every file-touching concern below — vitest inherits these
  // hooks into the nested describes, so each test still gets a fresh, isolated dir.
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccctl-session-store-"));
    filePath = join(dir, SESSION_STORE_FILE_NAME);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("round-trip + restart persistence (AC1)", () => {
    it("returns null before anything is saved — a fresh daemon has no snapshot", async () => {
      const store = createFileSessionStore(filePath);
      expect(await store.load()).toBeNull();
    });

    it("round-trips the session registry through a save/load cycle", async () => {
      const store = createFileSessionStore(filePath);
      await store.save(snapshotFixture());
      const loaded = await store.load();
      expect(loaded?.sessions).toEqual(sessions);
    });

    it("round-trips the unread queue through a save/load cycle", async () => {
      const store = createFileSessionStore(filePath);
      await store.save(snapshotFixture());
      const loaded = await store.load();
      expect(loaded?.unread).toEqual(unread);
    });

    it("round-trips the full snapshot deep-equal — it survives JSON serialisation unchanged", async () => {
      const store = createFileSessionStore(filePath);
      const snapshot = snapshotFixture();
      await store.save(snapshot);
      expect(await store.load()).toEqual(snapshot);
    });

    it("preserves the schema version across the round-trip", async () => {
      const store = createFileSessionStore(filePath);
      await store.save(snapshotFixture());
      expect((await store.load())?.version).toBe(SESSION_STORE_SNAPSHOT_VERSION);
    });

    it("round-trips an empty snapshot — a hub with no sessions and nothing unread", async () => {
      const store = createFileSessionStore(filePath);
      const empty: SessionStoreSnapshot = { version: SESSION_STORE_SNAPSHOT_VERSION, sessions: [], unread: [] };
      await store.save(empty);
      expect(await store.load()).toEqual(empty);
    });

    it("a later save replaces the prior snapshot", async () => {
      const store = createFileSessionStore(filePath);
      await store.save(snapshotFixture());
      const replacement: SessionStoreSnapshot = {
        version: SESSION_STORE_SNAPSHOT_VERSION,
        sessions: [createSession("sess-only", T0 + 100)],
        unread: [],
      };
      await store.save(replacement);
      expect(await store.load()).toEqual(replacement);
    });

    it("survives a restart — a NEW store instance at the same path loads what the prior one saved", async () => {
      // The load-bearing AC1 property ("reload after a restart"): the state lives on
      // disk, not in the instance. A second `createFileSessionStore` at the same path —
      // standing in for the daemon coming back up — reads the first's snapshot.
      const snapshot = snapshotFixture();
      await createFileSessionStore(filePath).save(snapshot);
      const afterRestart = createFileSessionStore(filePath);
      expect(await afterRestart.load()).toEqual(snapshot);
    });

    it("creates the parent state directory if it does not exist", async () => {
      const nested = join(dir, "nested", "state", SESSION_STORE_FILE_NAME);
      const store = createFileSessionStore(nested);
      await store.save(snapshotFixture());
      expect(await store.load()).toEqual(snapshotFixture());
    });
  });

  describe("0600 file permissions (AC2)", () => {
    it("writes the snapshot file owner-read/write only (0600)", async () => {
      await createFileSessionStore(filePath).save(snapshotFixture());
      expect(await fileMode(filePath)).toBe(SESSION_STORE_FILE_MODE);
      expect(SESSION_STORE_FILE_MODE).toBe(0o600);
    });

    it("forces 0600 even over a pre-existing looser-mode file", async () => {
      // The atomic temp-write + rename replaces the destination inode entirely, so a
      // file left 0644 (which writeFile's `mode` would NOT tighten in place) still ends
      // up 0600 — the exact trap the temp+chmod+rename dance defeats.
      await writeFile(filePath, "stale", { mode: 0o644 });
      await chmod(filePath, 0o644);
      expect(await fileMode(filePath)).toBe(0o644);

      await createFileSessionStore(filePath).save(snapshotFixture());
      expect(await fileMode(filePath)).toBe(0o600);
    });
  });

  describe("no secrets at rest (AC3)", () => {
    // The load-bearing "no credential can reach a snapshot" guarantee is the
    // compile-time `SessionStorePersistenceProofs` in core (enforced by `tsc`). These
    // are cheap runtime complements over the ACTUAL on-disk bytes.
    it("writes JSON carrying no credential-shaped content", async () => {
      await createFileSessionStore(filePath).save(snapshotFixture());
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).not.toMatch(/bearer|authorization|ingress|secret|token/i);
    });

    it("writes a JSON object with exactly the snapshot's top-level keys", async () => {
      await createFileSessionStore(filePath).save(snapshotFixture());
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["sessions", "unread", "version"]);
    });

    // The load-bearing SRV-C-007 at-rest check the core suite already anticipates
    // ("mirroring the server's `not.toContain(ACCOUNT_BEARER)` at-rest check",
    // packages/core/src/session-store.test.ts): grep the ACTUAL on-disk bytes for the
    // LITERAL secret VALUES — the account Bearer AND the session-ingress token — not
    // merely the credential-shaped FIELD WORDS the sibling test above scans for.
    //
    // This is the runtime guard the compile-time `SessionStorePersistenceProofs`
    // canNOT be. That proof excludes the account `AccountBearer` (it is not a
    // `JsonValue`, so a leak into a snapshot is a `tsc` error) — but a
    // `SessionIngressToken` is a JSON-safe branded string the proof does NOT exclude.
    // So a future JSON-safe `Session`/`UnreadEntry` field carrying an ingress credential
    // would compile clean; a LITERAL-value at-rest grep — not a field-word scan, and not
    // the type proof — is the technique that can catch that class of leak. This test pins
    // the invariant at its source: the persisted projection of a real session carries
    // NEITHER literal. Both credential classes on the bridge's two-credential boundary are
    // covered, exactly as the AC requires.
    it("persists a session served by a live account Bearer + ingress token, yet writes NEITHER literal to disk", async () => {
      // A distinctive literal per credential class — the genuine values the two
      // credential holders carry (asserted below), so the on-disk grep targets the
      // real secret strings, not arbitrary bytes.
      const ACCOUNT_BEARER = "oauth-account-secret-DO-NOT-PERSIST";
      const SESSION_INGRESS_TOKEN = "session-ingress-token-DO-NOT-PERSIST";

      // Positive control: each literal goes into the real holder it lives in — the
      // account OAuth Bearer (§1/§2) and the locally-minted per-session ingress token
      // (carried in the §3 work-secret, presented on §4/§5) — and the holder is
      // asserted to retain it. That fixes the grep's targets as genuine, in-process
      // secret values; it does NOT wire them into the snapshot (the types cannot).
      const accountBearer = new AccountBearer(ACCOUNT_BEARER);
      const workSecret: WorkSecret = {
        version: WORK_SECRET_VERSION,
        session_ingress_token: sessionIngressToken(SESSION_INGRESS_TOKEN),
        api_base_url: "http://127.0.0.1:0",
      };
      expect(accountBearer.reveal()).toBe(ACCOUNT_BEARER);
      expect(workSecret.session_ingress_token).toBe(SESSION_INGRESS_TOKEN);

      // The persisted hub state: a session registry entry + an unread marker. The
      // persisted types (`Session`, `UnreadEntry`) carry NO credential field — that
      // omission-by-construction is exactly what this test pins at rest.
      const served: Session = { ...createSession("sess-served", T0), status: "ready" };
      const snapshot: SessionStoreSnapshot = {
        version: SESSION_STORE_SNAPSHOT_VERSION,
        sessions: [served],
        unread: [{ sessionId: served.id, at: T0 + 1, activity: { kind: "idle" } }],
      };

      const store = createFileSessionStore(filePath);
      await store.save(snapshot);

      // Degenerate-subject guard: prove the file actually holds the session, so "zero
      // occurrences" is a real absence — not a vacuous grep over an empty file.
      expect(await store.load()).toEqual(snapshot);

      // The AC grep: the LITERAL account Bearer and the LITERAL session-ingress token
      // each appear ZERO times in the on-disk snapshot.
      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).not.toContain(ACCOUNT_BEARER);
      expect(onDisk).not.toContain(SESSION_INGRESS_TOKEN);
    });
  });

  describe("fail closed on a corrupt or drifted snapshot", () => {
    it("throws, naming the path, when the file is not valid JSON", async () => {
      await writeFile(filePath, "{ not json", { mode: 0o600 });
      const store = createFileSessionStore(filePath);
      await expect(store.load()).rejects.toThrow(/not valid JSON/);
      await expect(store.load()).rejects.toThrow(filePath);
    });

    it("throws a branded error, naming the path, when the file content is a bare JSON null", async () => {
      // A literal `null` is well-formed JSON but not a snapshot — it must fail closed with
      // the branded error, not an unbranded TypeError from dereferencing `.version` on null.
      await writeFile(filePath, "null", { mode: 0o600 });
      const store = createFileSessionStore(filePath);
      await expect(store.load()).rejects.toThrow(/not a JSON object/);
      await expect(store.load()).rejects.toThrow(filePath);
    });

    it("throws, naming the path and version, when the snapshot version drifts", async () => {
      const drifted = { version: SESSION_STORE_SNAPSHOT_VERSION + 1, sessions: [], unread: [] };
      await writeFile(filePath, JSON.stringify(drifted), { mode: 0o600 });
      const store = createFileSessionStore(filePath);
      await expect(store.load()).rejects.toThrow(new RegExp(`version ${SESSION_STORE_SNAPSHOT_VERSION + 1}`));
      await expect(store.load()).rejects.toThrow(filePath);
    });
  });
});

describe("resolveSessionStorePath — XDG state path resolution", () => {
  it("honours an absolute XDG_STATE_HOME", () => {
    expect(resolveSessionStorePath({ [XDG_STATE_HOME_ENV]: "/xdg/state" }, "/home/tester")).toBe(
      join("/xdg/state", CCCTL_STATE_DIR, SESSION_STORE_FILE_NAME),
    );
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveSessionStorePath({}, "/home/tester")).toBe(
      join("/home/tester", ".local", "state", CCCTL_STATE_DIR, SESSION_STORE_FILE_NAME),
    );
  });

  it("falls back when XDG_STATE_HOME is empty or relative (spec: absolute only)", () => {
    const expected = join("/home/tester", ".local", "state", CCCTL_STATE_DIR, SESSION_STORE_FILE_NAME);
    expect(resolveSessionStorePath({ [XDG_STATE_HOME_ENV]: "" }, "/home/tester")).toBe(expected);
    expect(resolveSessionStorePath({ [XDG_STATE_HOME_ENV]: "relative/state" }, "/home/tester")).toBe(expected);
  });
});
