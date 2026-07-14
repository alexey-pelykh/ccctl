// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  createSession,
  SESSION_STORE_SNAPSHOT_VERSION,
  type ISessionStore,
  type Session,
  type SessionStoreSnapshot,
  type UnreadEntry,
} from "./index.js";

// A fixed epoch so every fixture is deterministic — the model's injectable `now`
// seam means no test ever reads a real clock.
const T0 = 1_000_000;

/**
 * An in-memory {@link ISessionStore} that serialises through JSON exactly as the
 * real single-file backend (#23) will — so the round-trip assertions exercise
 * the genuine "survives serialisation" contract, not object identity. A test
 * fixture ONLY: `@ccctl/core` ships no backend (the file backend lives in
 * `@ccctl/server`), and its mere existence here demonstrates the interface is
 * implementable with pure JavaScript — no Node I/O, no runtime coupling.
 */
class InMemorySessionStore implements ISessionStore {
  #serialized: string | null = null;

  load(): Promise<SessionStoreSnapshot | null> {
    return Promise.resolve(this.#serialized === null ? null : (JSON.parse(this.#serialized) as SessionStoreSnapshot));
  }

  save(snapshot: SessionStoreSnapshot): Promise<void> {
    this.#serialized = JSON.stringify(snapshot);
    return Promise.resolve();
  }
}

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

describe("ISessionStore (AC: session-registry + unread-queue persistence — load / save / round-trip)", () => {
  it("returns null before anything is saved — a fresh daemon has no snapshot", async () => {
    const store = new InMemorySessionStore();
    expect(await store.load()).toBeNull();
  });

  it("round-trips the session registry through a save/load cycle", async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotFixture());
    const loaded = await store.load();
    expect(loaded?.sessions).toEqual(sessions);
  });

  it("round-trips the unread queue through a save/load cycle", async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotFixture());
    const loaded = await store.load();
    expect(loaded?.unread).toEqual(unread);
  });

  it("round-trips the full snapshot deep-equal — it survives JSON serialisation unchanged", async () => {
    const store = new InMemorySessionStore();
    const snapshot = snapshotFixture();
    await store.save(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });

  it("preserves the schema version across the round-trip", async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotFixture());
    const loaded = await store.load();
    expect(loaded?.version).toBe(SESSION_STORE_SNAPSHOT_VERSION);
  });

  it("round-trips an empty snapshot — a hub with no sessions and nothing unread", async () => {
    const store = new InMemorySessionStore();
    const empty: SessionStoreSnapshot = { version: SESSION_STORE_SNAPSHOT_VERSION, sessions: [], unread: [] };
    await store.save(empty);
    expect(await store.load()).toEqual(empty);
  });

  it("a later save replaces the prior snapshot", async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotFixture());
    const replacement: SessionStoreSnapshot = {
      version: SESSION_STORE_SNAPSHOT_VERSION,
      sessions: [createSession("sess-only", T0 + 100)],
      unread: [],
    };
    await store.save(replacement);
    expect(await store.load()).toEqual(replacement);
  });
});

describe("SessionStoreSnapshot (AC: runtime-agnostic, no secrets at rest)", () => {
  // The load-bearing "no credential can reach a snapshot" guarantee is the
  // compile-time `SessionStorePersistenceProofs` (`IsJson<SessionStoreSnapshot>`)
  // in index.ts — enforced by `tsc`, not by this test. This is a cheap runtime
  // complement: the persisted projection of a real session carries none of the
  // credential vocabulary, mirroring the server's `not.toContain(ACCOUNT_BEARER)`
  // at-rest check.
  it("serialises to JSON carrying no credential-shaped content", () => {
    const serialized = JSON.stringify(snapshotFixture());
    expect(serialized).not.toMatch(/bearer|authorization|ingress|secret|token/i);
  });

  it("serialises to a JSON object with exactly the snapshot's top-level keys", () => {
    const parsed = JSON.parse(JSON.stringify(snapshotFixture())) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["sessions", "unread", "version"]);
  });
});
