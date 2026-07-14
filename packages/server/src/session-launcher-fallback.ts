// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The FALLBACK composite of {@link ISessionLauncher} (#31) — the reification of the port's
 * "the caller then falls back to another backend" contract (`SRV-B-003`).
 *
 * The launcher port promises that a backend REJECTS when it cannot bring a surface up (tmux
 * absent for the tmux backend, #29) and that the caller then tries another backend (the
 * owned-pty fallback, #30). {@link createFallbackSessionLauncher} IS that caller, packaged as
 * an {@link ISessionLauncher} itself: it holds an ORDERED list of backends and, on
 * {@link ISessionLauncher.launch}, tries each in turn — returning the FIRST that resolves (a
 * surface came up), advancing to the next ONLY on a reject (that backend could not). This is
 * exactly the "via the primary or fallback backend" AC: the daemon composes `[tmux, owned-pty]`
 * behind this one port, and a "New session" request lands on whichever backend is available.
 *
 * Being an {@link ISessionLauncher} itself, it composes transparently — the server depends only
 * on the port and never learns whether it holds a single backend or a fallback chain. It is
 * backend-agnostic by construction (it calls only `launch`), so it needs NOTHING from #30 to
 * exist: it orders whatever backends it is handed, and is hermetically testable against fakes.
 *
 * A degraded-but-successful launch — the owned-pty fallback resolves with
 * {@link TerminalAttachment.attachable} `false` (#30) — is a SUCCESS, not a skip: only a REJECT
 * (the backend cannot bring ANY surface up) advances the chain, so the operator is never
 * silently dropped onto a lesser surface while a better one was available earlier in the order.
 */

import {
  isSessionLaunchError,
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type LaunchFailureCode,
  type SessionLaunchOptions,
} from "./session-launcher.js";

/**
 * The failure codes that describe the REQUEST rather than the host (#33). When every backend has
 * rejected, one of these among the failures is the honest answer — a launch the operator must fix
 * would have failed on ANY backend, so reporting "no backend was available" instead would blame the
 * host for the caller's mistake and send them off installing tmux to fix a missing binary.
 */
const CALLER_FAULT_CODES: readonly LaunchFailureCode[] = ["invalid-cwd", "worker-not-found", "non-prompting-mode"];

/**
 * Compose an ordered list of {@link ISessionLauncher} backends into one fallback launcher.
 * `backends[0]` is the primary (tmux #29); each later entry is the next fallback (owned-pty
 * #30). {@link ISessionLauncher.launch} returns the first backend that resolves and advances
 * past a backend only when it rejects; when EVERY backend rejects, it rejects with an
 * {@link AggregateError} carrying each backend's failure.
 *
 * Requires at least one backend — a fallback launcher with no backends could never launch, so
 * an empty list is a construction-time error (caught at wiring, not deferred to a confusing
 * launch-time reject).
 */
export function createFallbackSessionLauncher(backends: readonly ISessionLauncher[]): ISessionLauncher {
  if (backends.length === 0) {
    throw new Error("ccctl: a fallback session launcher needs at least one backend");
  }
  return {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      const failures: unknown[] = [];
      for (const backend of backends) {
        try {
          // The first backend that brings a surface up wins — its handle is returned as-is
          // (attachable or degraded). Tried in order so the primary is always preferred.
          return await backend.launch(options);
        } catch (error) {
          // This backend could not bring a surface up (e.g. tmux absent) — record why and fall
          // through to the next. Only when every backend has rejected do we give up.
          failures.push(error);
        }
      }
      // Every backend rejected. The composite must now answer ONE typed reason (#33) for what were
      // N failures — and the choice matters, because it is what the operator is told to go fix.
      //
      // A caller-fault code among the failures WINS over `backend-unavailable`: a launch that is
      // wrong in itself (a missing worker binary) fails identically on every backend, so the fact
      // that all of them rejected says nothing about the host — reporting "no backend available"
      // there would be a true statement that misleads. Only when NOTHING more specific was named do
      // we conclude the honest, literal thing: no backend could bring a surface up.
      //
      // The AggregateError is preserved as `cause`, so every backend's own failure is still there
      // for a log even though only one code reaches the wire.
      const cause = new AggregateError(
        failures,
        `ccctl: no session-launcher backend could launch a session (tried ${backends.length})`,
      );
      const specific = failures.find(
        (failure): failure is SessionLaunchError =>
          isSessionLaunchError(failure) && CALLER_FAULT_CODES.includes(failure.code),
      );
      if (specific !== undefined) {
        throw new SessionLaunchError(specific.code, specific.message, { cause });
      }
      throw new SessionLaunchError("backend-unavailable", cause.message, { cause });
    },
  };
}
