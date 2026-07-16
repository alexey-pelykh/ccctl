// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Inspector attach + FD/handle-count diagnostics (#63) — the second slice of the on-demand daemon
 * diagnostic trail (#61/#62), giving visibility into the long-run file-descriptor / handle leak
 * vector WITHOUT restarting the daemon and reachable ONLY with local auth.
 *
 * **Trigger — a POSIX signal ({@link INSPECTOR_DIAGNOSTICS_SIGNAL}, `SIGUSR1`), not an HTTP endpoint
 * — the same choice #62 made, for the same reason.** A signal's authorization is the OS's own: only
 * a process running as the SAME uid (or root) on the SAME host can deliver it — it is unreachable
 * off-box, over any network or tunnel. That is "local auth" in its strongest, most conservative form.
 * An HTTP diagnostics endpoint would instead need EITHER the local-server-auth secret as a *request*
 * credential — but that secret is BOOT-GATE-ONLY, its request-credential boundary DEFERRED (#57/#58),
 * so wiring it here would front-run deferred scope — OR no auth at all, which fails the "not exposed
 * without local auth" bar. `SIGUSR1` is the signal Node itself uses to attach the inspector, so it is
 * the natural "deep diagnosis" poke: #62 took `SIGUSR2` for the heap snapshot and left `SIGUSR1` — its
 * companion — to the inspector. One `SIGUSR1` does BOTH deep-diagnosis actions (they are grouped in
 * one operator poke, needing no third — and scarce — user signal): it samples the handle counts and
 * ensures the inspector is attached.
 *
 * **FD/handle-count report — {@link captureHandleReport} over {@link process.getActiveResourcesInfo}.**
 * That call returns the libuv resource (file-descriptor / handle / request) types currently keeping
 * the event loop alive — cross-platform (macOS + Linux), stable, and exactly the leak-vector signal:
 * a growing `TCPServerWrap` / `PipeWrap` / `Timeout` tally over successive samples is a leak. It is
 * tallied by type and recorded on the #61 trail as `diagnostic`/`handle-report` (info); the line
 * carries only counts, never a credential.
 *
 * **Inspector attach — {@link openInspector} over `node:inspector`.** It ensures the Node inspector
 * is open **bound to loopback** ({@link INSPECTOR_DIAGNOSTICS_HOST}) — reachable only from the box, so
 * the OS-uid signal trigger is the whole authorization — and reports its `ws://` URL on the trail as
 * `diagnostic`/`inspector-open` (info). It is guarded: `inspector.open()` is NOT idempotent (it
 * throws once the agent is active), so if the inspector is ALREADY open — Node's own `SIGUSR1`
 * auto-open may have won the race, or a prior poke did — the existing URL is reported and no re-open
 * is attempted.
 *
 * The handle sample is taken BEFORE the inspector is opened, so the first poke's counts reflect the
 * daemon's own state before the diagnostic itself perturbs it (the inspector adds a socket handle).
 *
 * Everything host-touching (the resource sampler, the inspector agent, the signal source, the log
 * sink) is an INJECTED seam so the capture and the signal wiring are unit-testable with fakes — no
 * real inspector port opened, no real signal delivered — the same determinism discipline the rest of
 * the server follows. Production wires the real `node:inspector` / `process` defaults.
 */

import { open as inspectorOpen, url as inspectorUrl } from "node:inspector";
import { NO_OP_LOGGER, type Logger } from "@ccctl/core";
// The process-signal seam is shared with the heap-snapshot diagnostic (#62) — the one server-wide
// shape a fake `EventEmitter` stands in for; type-only import, erased at compile (no runtime coupling).
import { type SignalSource } from "./heap-snapshot.js";

/**
 * The signal that triggers the deep-diagnosis poke: `SIGUSR1` — the signal Node itself uses to attach
 * the inspector, left free by #62 (which took `SIGUSR2` for the heap snapshot). Named so the daemon,
 * the operator-facing hint, and the tests reference the one signal.
 */
export const INSPECTOR_DIAGNOSTICS_SIGNAL: NodeJS.Signals = "SIGUSR1";

/**
 * The loopback host the inspector is bound to: `127.0.0.1`. Off-box reach is impossible, so the only
 * way to attach is a same-uid local process — the OS authorization the `SIGUSR1` trigger already
 * enforces. Never a wildcard / LAN address, mirroring the server's own localhost-bind guarantee (#58).
 */
export const INSPECTOR_DIAGNOSTICS_HOST = "127.0.0.1";

/**
 * A tally of the daemon's currently-active libuv resources: the {@link HandleReport.total total}
 * count, and the per-{@link HandleReport.byType type} breakdown (`TCPServerWrap`, `Timeout`,
 * `PipeWrap`, …). A leak shows as a type's count climbing across successive samples.
 */
export interface HandleReport {
  /** Total active libuv resources (handles + requests) keeping the event loop alive. */
  readonly total: number;
  /** Count per libuv resource type — the by-type breakdown a leak is spotted in. */
  readonly byType: Readonly<Record<string, number>>;
}

/**
 * The injected sampler {@link captureHandleReport} runs over: the currently-active libuv resource
 * types. The production default is {@link process.getActiveResourcesInfo}; a test passes a fake array.
 */
export type HandleSampler = () => readonly string[];

/** The production sampler: the live daemon's active libuv resource types via {@link process.getActiveResourcesInfo}. */
const defaultHandleSampler: HandleSampler = () => process.getActiveResourcesInfo();

/** The injectable seams {@link captureHandleReport} runs over — all with production defaults. */
export interface HandleReportDeps {
  /** Sample the active libuv resources (default: {@link process.getActiveResourcesInfo}). */
  readonly sample?: HandleSampler;
  /** Structured-log sink the report is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
}

/** The outcome of a handle sample: the tallied report on success, or a reason on failure. */
export type HandleReportOutcome =
  { readonly ok: true; readonly report: HandleReport } | { readonly ok: false; readonly reason: string };

/**
 * Render a {@link HandleReport} as the one-line `detail` that rides the trail: the total, then the
 * per-type breakdown sorted by type name (so the line is deterministic and diffable across samples).
 * Carries only counts — never a credential.
 */
export function formatHandleReport(report: HandleReport): string {
  const types = Object.keys(report.byType).sort();
  if (types.length === 0) {
    return `${report.total} active libuv resources`;
  }
  const breakdown = types.map((type) => `${type}=${report.byType[type]}`).join(", ");
  return `${report.total} active libuv resources — ${breakdown}`;
}

/**
 * Sample the daemon's current FD/handle counts and record them on the #61 trail as a
 * `diagnostic`/`handle-report` info line (its `detail` the {@link formatHandleReport} tally), for
 * leak-vector visibility. Never throws: a failed sample on a struggling daemon must not take the
 * daemon down, so the error is caught, recorded as `diagnostic`/`handle-report-failed` at error
 * level, and returned. The returned {@link HandleReportOutcome} lets a caller (or a test) act on the
 * result without reading the log.
 */
export function captureHandleReport(deps: HandleReportDeps = {}): HandleReportOutcome {
  const { sample = defaultHandleSampler, logger = NO_OP_LOGGER } = deps;
  try {
    const resources = sample();
    const byType: Record<string, number> = {};
    for (const type of resources) {
      byType[type] = (byType[type] ?? 0) + 1;
    }
    const report: HandleReport = { total: resources.length, byType };
    logger.log({
      category: "diagnostic",
      level: "info",
      event: "handle-report",
      sessionId: null,
      detail: formatHandleReport(report),
    });
    return { ok: true, report };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "error",
      event: "handle-report-failed",
      sessionId: null,
      detail: `active-resource sample failed: ${reason}`,
    });
    return { ok: false, reason };
  }
}

/**
 * The minimal `node:inspector` surface {@link openInspector} needs — the real module satisfies it
 * ({@link inspectorUrl} / {@link inspectorOpen}), and a test passes a fake so no real inspector port
 * is opened. Kept narrow (just `url` / `open`) so a fake is trivial.
 */
export interface InspectorController {
  /** The inspector's `ws://` URL when the agent is active, else `undefined`. */
  url(): string | undefined;
  /** Open the inspector agent on `host:port` (`wait` = block for a debugger to attach). */
  open(port: number, host: string, wait: boolean): void;
}

/** The production controller: the real `node:inspector` agent. */
const defaultInspectorController: InspectorController = {
  url: () => inspectorUrl(),
  open: (port, host, wait) => {
    inspectorOpen(port, host, wait);
  },
};

/** The injectable seams {@link openInspector} runs over — all with production defaults. */
export interface InspectorDeps {
  /** The inspector agent (default: the real `node:inspector`). */
  readonly controller?: InspectorController;
  /** The loopback host to bind (default: {@link INSPECTOR_DIAGNOSTICS_HOST}). */
  readonly host?: string;
  /** The port to bind (default: `0` — an ephemeral, collision-free port; the URL is reported anyway). */
  readonly port?: number;
  /** Structured-log sink the outcome is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
}

/** The outcome of an attach: the URL (and whether it was already open) on success, or a reason on failure. */
export type InspectorOutcome =
  | { readonly ok: true; readonly url: string; readonly alreadyOpen: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Ensure the Node inspector is open bound to loopback and record its `ws://` URL on the #61 trail as
 * `diagnostic`/`inspector-open` (info), so an operator can attach a debugger for deeper diagnosis.
 *
 * Guarded: `inspector.open()` throws `ERR_INSPECTOR_ALREADY_ACTIVATED` once the agent is active, so if
 * the inspector is ALREADY open — Node's own `SIGUSR1` auto-open, or a prior poke — the existing URL
 * is reported and no re-open is attempted ({@link InspectorOutcome.alreadyOpen} = `true`). Never
 * throws: any failure is caught, recorded as `diagnostic`/`inspector-open-failed` at error level, and
 * returned, so a failed attach on a struggling daemon does not take it down.
 */
export function openInspector(deps: InspectorDeps = {}): InspectorOutcome {
  const {
    controller = defaultInspectorController,
    host = INSPECTOR_DIAGNOSTICS_HOST,
    port = 0,
    logger = NO_OP_LOGGER,
  } = deps;
  try {
    const existing = controller.url();
    if (existing !== undefined) {
      logger.log({ category: "diagnostic", level: "info", event: "inspector-open", sessionId: null, detail: existing });
      return { ok: true, url: existing, alreadyOpen: true };
    }
    controller.open(port, host, false);
    const url = controller.url();
    if (url === undefined) {
      // Defensive: the agent reported active but no URL. Treat as a failure rather than assert a
      // credential-free "" — the operator needs a real URL to attach.
      const reason = "inspector opened but reported no URL";
      logger.log({
        category: "diagnostic",
        level: "error",
        event: "inspector-open-failed",
        sessionId: null,
        detail: reason,
      });
      return { ok: false, reason };
    }
    logger.log({ category: "diagnostic", level: "info", event: "inspector-open", sessionId: null, detail: url });
    return { ok: true, url, alreadyOpen: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "error",
      event: "inspector-open-failed",
      sessionId: null,
      detail: `inspector could not be opened on ${host}:${port}: ${reason}`,
    });
    return { ok: false, reason };
  }
}

/** {@link InspectorDeps} + {@link HandleReportDeps} plus the signal wiring: which signal, and the source to listen on. */
export interface InspectorDiagnosticsSignalDeps extends InspectorDeps, HandleReportDeps {
  /** The signal to arm (default: {@link INSPECTOR_DIAGNOSTICS_SIGNAL}). */
  readonly signal?: NodeJS.Signals;
  /** The signal source (default: {@link process}). */
  readonly source?: SignalSource;
}

/**
 * Arm the deep-diagnosis trigger: install a handler for {@link INSPECTOR_DIAGNOSTICS_SIGNAL} that, on
 * each poke, samples the FD/handle counts ({@link captureHandleReport}) and then ensures the inspector
 * is attached ({@link openInspector}) — the handle sample first, so the first poke's counts precede
 * the inspector's own socket handle. Returns a disposer that removes the handler. The daemon wires
 * this once at its composition root (the CLI `serve` verb), passing the same structured-log sink it
 * gave the server so both actions ride the daemon's trail.
 *
 * Each action is independently guarded and never throws, so one failing does not suppress the other.
 * A platform that cannot listen for the signal (Windows has no `SIGUSR1`) must not crash the daemon —
 * installation is guarded, the inability is surfaced once on the trail, and a no-op disposer is
 * returned so a caller can uninstall unconditionally.
 */
export function installInspectorDiagnosticsSignalHandler(deps: InspectorDiagnosticsSignalDeps = {}): () => void {
  const { signal = INSPECTOR_DIAGNOSTICS_SIGNAL, source = process, logger = NO_OP_LOGGER, ...actionDeps } = deps;
  // One poke runs both actions off the shared seam bag — each picks the seams it needs and ignores the
  // rest — with the resolved logger applied. Spreading `actionDeps` (rather than naming fields) keeps an
  // absent seam absent under exactOptionalPropertyTypes, where an explicit `undefined` would not type-check.
  const handler = (): void => {
    captureHandleReport({ ...actionDeps, logger });
    openInspector({ ...actionDeps, logger });
  };
  try {
    source.on(signal, handler);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "warn",
      event: "inspector-open-failed",
      sessionId: null,
      detail: `inspector-diagnostics signal handler could not be armed for ${signal}: ${reason}`,
    });
    return () => undefined;
  }
  return () => {
    source.removeListener(signal, handler);
  };
}
