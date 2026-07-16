// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * On-demand heap snapshot (#62) — a LIVE daemon heap dump for chasing a long-run memory-growth
 * vector, produced WITHOUT restarting the daemon and reachable ONLY with local auth.
 *
 * **Trigger — a POSIX signal ({@link HEAP_SNAPSHOT_SIGNAL}, `SIGUSR2`), not an HTTP endpoint.**
 * A signal is the idiomatic Unix/Node way to poke a running daemon, and its authorization is the
 * OS's own: only a process running as the SAME uid (or root) on the SAME host can deliver it — it
 * is unreachable off-box, over any network or tunnel. That is "local auth" in its strongest, most
 * conservative form, which matters HERE more than usual: a heap snapshot is a copy of process
 * memory, so its trigger should be as tightly held as possible (a loopback HTTP endpoint bearer'd
 * by the local-server-auth secret is a wider surface — and that secret is still BOOT-GATE-ONLY, its
 * request-credential boundary deferred, so wiring it here would front-run deferred scope). The
 * signal handler runs in the live process, so no restart is needed. `SIGUSR1` is reserved by Node
 * for the inspector; `SIGUSR2` is the free companion.
 *
 * **The snapshot FILE is written owner-only `0600`** ({@link HEAP_SNAPSHOT_FILE_MODE}) because it
 * holds a copy of process memory — every in-flight account Bearer and session-ingress token — so a
 * world-readable dump would hand those to any other local user. This matches the codebase's
 * secrets-at-rest discipline (the `0600` session / device stores). The default writer pre-creates
 * the file owner-only so it is never even briefly group/other-readable, then re-asserts the mode.
 *
 * **It rides the #61 structured trail as the DIAGNOSTIC log category**, not a plain console line:
 * the daemon's stdout is a JSON-lines trail (`… | jq`), which a bare line would corrupt. A written
 * snapshot emits `diagnostic`/`heap-snapshot` (info) naming the PATH; a failure emits
 * `diagnostic`/`heap-snapshot-failed` (error) with the reason. Neither carries a credential — the
 * line names only the file's path, and the shape is JSON-safe by construction (`@ccctl/core`).
 *
 * Everything host-touching (the V8 writer, the clock, the pid, the signal source, the log sink) is
 * an INJECTED seam so the capture and the signal wiring are unit-testable with fakes — no real
 * signal delivered, no real snapshot written — the same determinism discipline the rest of the
 * server follows. Production wires the real `node:v8` / `process` defaults.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { writeHeapSnapshot as v8WriteHeapSnapshot } from "node:v8";
import { NO_OP_LOGGER, type Logger } from "@ccctl/core";

/**
 * The signal that triggers a live heap snapshot: `SIGUSR2`. `SIGUSR1` is reserved by Node for the
 * inspector, so the free companion is used. Named so the daemon, the operator-facing hint, and the
 * tests reference the one signal.
 */
export const HEAP_SNAPSHOT_SIGNAL: NodeJS.Signals = "SIGUSR2";

/**
 * The environment variable that overrides where snapshots are written — honoured ONLY when set to
 * an ABSOLUTE path (a relative one would resolve against the daemon's cwd, a footgun), mirroring the
 * XDG absolute-only discipline in `startup.ts`. Unset / blank / relative all fall back to the OS
 * temp dir. An operator directs the secrets-bearing dumps to a controlled (e.g. `0700`, encrypted)
 * location this way.
 */
export const HEAP_SNAPSHOT_DIR_ENV = "CCCTL_HEAP_SNAPSHOT_DIR";

/** Owner-only file mode for the secrets-bearing snapshot — read/write for the owner, nothing for group/other. */
export const HEAP_SNAPSHOT_FILE_MODE = 0o600;

/**
 * Resolve the directory snapshots are written to: {@link HEAP_SNAPSHOT_DIR_ENV} when it is an
 * ABSOLUTE path, else the OS temp dir ({@link tmpdir}). `env` is injectable so the resolution is
 * unit-testable without mutating the real environment.
 */
export function resolveHeapSnapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[HEAP_SNAPSHOT_DIR_ENV]?.trim();
  return configured !== undefined && configured !== "" && isAbsolute(configured) ? configured : tmpdir();
}

/**
 * The snapshot file name for a given pid and wall-clock instant: `ccctl-heap-<pid>-<stamp>.heapsnapshot`.
 * The ISO instant's `:` and `.` are replaced with `-` so the name is safe on every filesystem, and the
 * `.heapsnapshot` extension is the one Chrome DevTools / clinic.js recognise. pid + millisecond stamp
 * make two snapshots from one daemon effectively collision-free.
 */
export function heapSnapshotFileName(pid: number, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `ccctl-heap-${pid}-${stamp}.heapsnapshot`;
}

/** Write a heap snapshot to `path`, returning the path actually written. The injected seam over `node:v8`. */
export type HeapSnapshotWriter = (path: string) => string;

/**
 * The production writer: pre-create the target owner-only, then let V8 write the snapshot into that
 * existing inode, then re-assert `0600`. The pre-create closes the window in which V8's own
 * `open()` (mode subject to umask, typically `0644`) would leave the secrets-bearing dump briefly
 * world-readable; `wx` refuses a pre-existing file (a real collision on the pid+ms name is
 * effectively impossible and worth surfacing rather than silently overwriting). V8 opens the
 * existing file with `O_TRUNC`, preserving its mode; the trailing `chmod` is a defensive belt in
 * case a platform re-creates it.
 */
const defaultHeapSnapshotWriter: HeapSnapshotWriter = (path) => {
  writeFileSync(path, "", { mode: HEAP_SNAPSHOT_FILE_MODE, flag: "wx" });
  const written = v8WriteHeapSnapshot(path);
  chmodSync(written, HEAP_SNAPSHOT_FILE_MODE);
  return written;
};

/** The injectable seams {@link captureHeapSnapshot} runs over — all with production defaults. */
export interface HeapSnapshotDeps {
  /** Write the snapshot (default: the owner-only `node:v8` writer). */
  readonly write?: HeapSnapshotWriter;
  /** Target directory (default: {@link resolveHeapSnapshotDir}). */
  readonly dir?: string;
  /** Owning process id, for the file name (default: {@link process.pid}). */
  readonly pid?: number;
  /** Wall-clock source, for the file-name stamp (default: {@link Date.now}). */
  readonly now?: () => number;
  /** Structured-log sink the outcome is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
}

/** The outcome of a capture: the written path on success, or the path attempted plus a reason on failure. */
export type HeapSnapshotOutcome =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Capture one heap snapshot: resolve the target path, write it, and record the outcome on the
 * structured trail — `diagnostic`/`heap-snapshot` (info, naming the path) on success, or
 * `diagnostic`/`heap-snapshot-failed` (error, naming the reason) on any write failure. Never
 * throws: a failed snapshot on a struggling daemon must not take the daemon down, so the error is
 * caught, logged, and returned. The returned {@link HeapSnapshotOutcome} lets a caller (or a test)
 * act on the result without reading the log.
 */
export function captureHeapSnapshot(deps: HeapSnapshotDeps = {}): HeapSnapshotOutcome {
  const {
    write = defaultHeapSnapshotWriter,
    dir = resolveHeapSnapshotDir(),
    pid = process.pid,
    now = Date.now,
    logger = NO_OP_LOGGER,
  } = deps;
  const path = join(dir, heapSnapshotFileName(pid, now()));
  try {
    const written = write(path);
    logger.log({ category: "diagnostic", level: "info", event: "heap-snapshot", sessionId: null, detail: written });
    return { ok: true, path: written };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "error",
      event: "heap-snapshot-failed",
      sessionId: null,
      detail: `heap snapshot to ${path} failed: ${reason}`,
    });
    return { ok: false, path, reason };
  }
}

/**
 * The minimal signal-source surface {@link installHeapSnapshotSignalHandler} needs — the real
 * `process` satisfies it, and a test passes a bare `EventEmitter`. Kept narrow (just `on` /
 * `removeListener`) so a fake is trivial.
 */
export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): void;
  removeListener(signal: NodeJS.Signals, handler: () => void): void;
}

/** {@link HeapSnapshotDeps} plus the signal wiring: which signal, and the source to listen on. */
export interface HeapSnapshotSignalDeps extends HeapSnapshotDeps {
  /** The signal to arm (default: {@link HEAP_SNAPSHOT_SIGNAL}). */
  readonly signal?: NodeJS.Signals;
  /** The signal source (default: {@link process}). */
  readonly source?: SignalSource;
}

/**
 * Arm the heap-snapshot trigger: install a handler for {@link HEAP_SNAPSHOT_SIGNAL} that captures a
 * snapshot each time the daemon is signalled, and return a disposer that removes it. The daemon
 * wires this once at its composition root (the CLI `serve` verb), passing the same structured-log
 * sink it gave the server so a snapshot rides the daemon's trail.
 *
 * A platform that cannot listen for the signal (Windows has no `SIGUSR2`) must not crash the daemon
 * — installation is guarded, the inability is surfaced once on the trail, and a no-op disposer is
 * returned so a caller can uninstall unconditionally.
 */
export function installHeapSnapshotSignalHandler(deps: HeapSnapshotSignalDeps = {}): () => void {
  const { signal = HEAP_SNAPSHOT_SIGNAL, source = process, logger = NO_OP_LOGGER, ...captureDeps } = deps;
  const handler = (): void => {
    captureHeapSnapshot({ ...captureDeps, logger });
  };
  try {
    source.on(signal, handler);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "warn",
      event: "heap-snapshot-failed",
      sessionId: null,
      detail: `heap-snapshot signal handler could not be armed for ${signal}: ${reason}`,
    });
    return () => undefined;
  }
  return () => {
    source.removeListener(signal, handler);
  };
}
