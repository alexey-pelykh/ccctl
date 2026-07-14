// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The single-file JSON-snapshot {@link ISessionStore} backend (#23) — the concrete
 * persistence the hub's session registry + unread queue survive a daemon restart on.
 *
 * `@ccctl/core` defines the CONTRACT (the JSON-safe {@link SessionStoreSnapshot} shape
 * and the {@link ISessionStore} load/save seam) and deliberately ships no backend: a
 * concrete store is Node-coupled I/O (`fs`, an XDG state path), so it lives here in
 * `@ccctl/server` while core stays runtime-agnostic (CORE-C-001). This is that backend
 * — one file, one JSON object, `0600`.
 *
 * **Three guarantees, mapped to the acceptance criteria:**
 *
 *   1. **Round-trip across a restart.** {@link ISessionStore.save} writes the whole
 *      snapshot; {@link ISessionStore.load} reads it back deep-equal on the next start.
 *      A never-saved store loads `null` (a fresh daemon), never a fabricated empty
 *      snapshot — so a caller can tell "no prior state" from "explicitly-saved empty
 *      state" (the core round-trip contract).
 *   2. **`0600` file permissions.** The snapshot is written owner-read/write only, and
 *      the mode is FORCED — see {@link save}'s atomic temp-write + `chmod` + `rename`,
 *      which holds `0600` regardless of the umask or a pre-existing looser file.
 *   3. **No secrets at rest (SRV-C-007).** Guaranteed UPSTREAM, at compile time: the
 *      persisted shape is provably {@link https://ccctl | JsonValue}-safe
 *      (`SessionStorePersistenceProofs` in core), so the account Bearer — not a JSON
 *      value — cannot reach a snapshot by construction, and the scoped session-ingress
 *      token is absent because the persisted types carry no such field. This backend
 *      only serialises that already-safe shape; it invents no field, so it cannot
 *      re-introduce a secret. A cheap runtime at-rest check complements the proof in
 *      the test suite.
 *
 * **Atomicity + fail-closed.** A save is crash-safe (temp file → atomic `rename`, so a
 * reader never sees a half-written file), and a load fails CLOSED on a corrupt or
 * version-drifted snapshot with a branded, path-naming error — the same
 * pin-and-fail-closed posture the wire contract takes, in the same guardrail voice as
 * {@link brandListenError} / {@link requireLocalServerAuth}. Single-writer by design:
 * one daemon owns its state file.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SESSION_STORE_SNAPSHOT_VERSION, type ISessionStore, type SessionStoreSnapshot } from "@ccctl/core";

/**
 * The environment variable naming the base of the XDG *state* directory
 * (XDG Base Directory spec). State — as opposed to config or cache — is exactly
 * where a "survives a restart, safe to lose" snapshot belongs.
 */
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";

/** The per-application subdirectory under the XDG state home that holds ccctl's state. */
export const CCCTL_STATE_DIR = "ccctl";

/** The snapshot file's name under {@link CCCTL_STATE_DIR}. */
export const SESSION_STORE_FILE_NAME = "session-store.json";

/**
 * The snapshot file's permission bits — owner read/write only (`0600`). The hard
 * acceptance criterion; {@link createFileSessionStore}'s `save` forces exactly this.
 */
export const SESSION_STORE_FILE_MODE = 0o600;

/**
 * The state directory's permission bits — owner-only (`0700`), applied when the
 * directory is CREATED. Defense-in-depth so a `0600` file is not reachable through a
 * group/other-traversable parent; the file's own `0600` remains the load-bearing
 * guarantee (an already-existing operator directory is not force-tightened).
 */
export const SESSION_STORE_DIR_MODE = 0o700;

/**
 * Resolve the default snapshot path: `$XDG_STATE_HOME/ccctl/session-store.json`,
 * falling back to `~/.local/state/ccctl/session-store.json`. Per the XDG Base
 * Directory spec, `$XDG_STATE_HOME` is honoured ONLY when set to an ABSOLUTE path;
 * unset, empty, or relative all fall back to `$HOME/.local/state` (a relative XDG base
 * is spec-invalid and would otherwise resolve against the process cwd — a footgun).
 *
 * `env` and `home` are injectable seams so the resolution is unit-testable without
 * touching the real environment or home directory — the same pure-and-injectable idiom
 * as {@link requireLocalServerAuth}.
 */
export function resolveSessionStorePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env[XDG_STATE_HOME_ENV]?.trim();
  const stateHome =
    configured !== undefined && configured !== "" && isAbsolute(configured)
      ? configured
      : join(home, ".local", "state");
  return join(stateHome, CCCTL_STATE_DIR, SESSION_STORE_FILE_NAME);
}

/** Monotonic per-process sequence making each in-flight temp file name unique. */
let saveSequence = 0;

/**
 * A single-file JSON-snapshot {@link ISessionStore}. Private — callers depend on the
 * {@link ISessionStore} port through {@link createFileSessionStore}, exactly as the
 * launcher/relay backends expose a factory over their port rather than a class.
 */
class FileSessionStore implements ISessionStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<SessionStoreSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A fresh daemon: nothing has ever been saved. Absence is `null`, never a
        // fabricated empty snapshot (the core round-trip contract).
        return null;
      }
      // A real I/O failure (EACCES, EISDIR, …) surfaces rather than masquerading as
      // "fresh" — silently swallowing it would drop the operator's state on a
      // transient permission glitch.
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Branded + fail-closed, without leaking the raw Node parser string into the
      // message (brandListenError's principle); the underlying SyntaxError is chained
      // as `cause` for anyone who wants the detail.
      throw new Error(
        `ccctl: the session-store snapshot at ${this.#filePath} is not valid JSON — ` +
          `remove the file to start fresh.`,
        { cause: error },
      );
    }

    // A bare JSON `null` (or any non-object primitive) is not a snapshot — fail closed
    // with the same branded error rather than letting the `.version` read below throw an
    // unbranded TypeError on `null`. Keeps the fail-closed branding uniform across every
    // degenerate input (an array falls through to the version gate, which rejects it too).
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `ccctl: the session-store snapshot at ${this.#filePath} is not a JSON object — ` +
          `remove the file to start fresh.`,
      );
    }

    // Fail closed on version drift: a snapshot written by a different schema version is
    // not silently mis-read as the current shape (the same pin-and-fail-closed posture
    // core's SESSION_STORE_SNAPSHOT_VERSION invites). Migration, should it ever be
    // needed, is a deliberate future change; today an unknown version is a hard stop.
    const version = (parsed as { readonly version?: unknown }).version;
    if (version !== SESSION_STORE_SNAPSHOT_VERSION) {
      throw new Error(
        `ccctl: the session-store snapshot at ${this.#filePath} is version ${String(version)}, ` +
          `but this build reads version ${SESSION_STORE_SNAPSHOT_VERSION} — remove the file to start fresh.`,
      );
    }

    return persistableSnapshot(parsed as SessionStoreSnapshot);
  }

  async save(snapshot: SessionStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: SESSION_STORE_DIR_MODE });

    // Pretty-printed + trailing newline so the state file is human-inspectable (a POSIX
    // text file), which a JSON snapshot at rest usefully is.
    const serialized = `${JSON.stringify(persistableSnapshot(snapshot), null, 2)}\n`;

    // Atomic + exactly-0600. Write a uniquely-named temp in the SAME directory (so the
    // rename is atomic on one filesystem), created at 0600 so it is never briefly
    // world-readable, then `chmod` to FORCE exactly 0600 on that fresh inode: writeFile's
    // mode is umask-masked, so a pathological owner-clearing umask (e.g. 0o200) would
    // otherwise leave the temp at 0o400 — chmod pins it back. Then rename OVER the
    // destination, which becomes the temp's fresh 0600 inode, so any pre-existing looser
    // file there is replaced WHOLESALE rather than modified in place (writeFile's mode is
    // never applied to an existing file — the rename, not the chmod, is what defeats that).
    // A reader never sees a partial file.
    const tempPath = `${this.#filePath}.${process.pid}.${(saveSequence++).toString(36)}.tmp`;
    try {
      await writeFile(tempPath, serialized, { mode: SESSION_STORE_FILE_MODE });
      await chmod(tempPath, SESSION_STORE_FILE_MODE);
      await rename(tempPath, this.#filePath);
    } catch (error) {
      // Best-effort cleanup so a failed save leaves no orphaned temp behind; swallow
      // the cleanup's own error so the original failure is what surfaces.
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Create a single-file JSON-snapshot {@link ISessionStore} at `filePath`, defaulting to
 * the resolved XDG state path ({@link resolveSessionStorePath}). The default keeps the
 * daemon call-site a bare `createFileSessionStore()`; a test passes an explicit temp
 * path. Returns the {@link ISessionStore} port — callers depend on the contract, not
 * this backend.
 */
export function createFileSessionStore(filePath: string = resolveSessionStorePath()): ISessionStore {
  return new FileSessionStore(filePath);
}

/**
 * Drop every `registering` session from a snapshot — and, with it, any unread entry that named one —
 * applied on BOTH save and load (#33).
 *
 * A `registering` session is a UC2 launch whose worker has not checked in yet, and the only two
 * things that can ever resolve it live IN THIS PROCESS: the pending-launch record that its §2
 * registration would claim, and the eviction timer holding its terminal handle (`pending-launch.ts`).
 * Neither survives a restart. So a `registering` row that reached the disk would come back as an
 * IMMORTAL ghost — nothing can claim it (its worker died with the old process), nothing can evict it
 * (there is no pending record to evict), and it would sit in the operator's session list forever.
 * That is exactly the ghost #33 exists to prevent, resurrected by persistence.
 *
 * The unread queue is filtered ALONGSIDE the registry, because dropping a session while keeping the
 * entries keyed to it would trade the ghost row for a ghost BADGE: an unread count the operator can
 * never open, clear, or attribute, pointing at a session that is not in the list. Today a
 * `registering` session cannot accrue unread activity at all (it has no worker channel to accrue it
 * over — `rejectIfRegistering` in `worker-channel.ts` 409s every leg), so this filter is a no-op on
 * any snapshot THIS build writes. It is not written for this build: `load` accepts snapshots from
 * other ones, and the invariant worth holding at the boundary is the whole-snapshot one — every
 * unread entry names a session in the registry — not merely the row-level one.
 *
 * Enforced HERE, at the boundary, rather than trusted to whichever caller eventually wires the store:
 * a rule that lives only in a doc comment is a rule that holds only until someone does not read it.
 * Filtering on LOAD as well as on save also means a snapshot written by a build without this guard
 * cannot poison a session list either.
 */
function persistableSnapshot(snapshot: SessionStoreSnapshot): SessionStoreSnapshot {
  const sessions = snapshot.sessions.filter((session) => session.status !== "registering");
  if (sessions.length === snapshot.sessions.length) {
    return snapshot;
  }
  const persisted = new Set(sessions.map((session) => session.id));
  return { ...snapshot, sessions, unread: snapshot.unread.filter((entry) => persisted.has(entry.sessionId)) };
}
