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
 * **Timer census (#238) — {@link installTimerCensus} over `node:async_hooks`, reported ALONGSIDE the
 * tally above, never merged into it.** The sampler above reports, by definition, only the resources
 * KEEPING THE EVENT LOOP ALIVE. Every one of the daemon's per-session timers is `.unref()`'d on the very
 * next statement after it is armed — pending-launch eviction (#33, `pending-launch.ts`), worker downstream
 * liveness (#166, `worker-channel.ts`), session idle threshold (#41), session eviction grace (#173),
 * surface close timeout (`session-release.ts`), and the pty backend's kill escalation (#76,
 * `session-launcher-pty.ts`) — deliberately, so that pending bookkeeping never by itself holds the
 * process open. Correct, and it lands them outside the tally: an unref'd timer is not keeping the loop
 * alive, so it is never counted, so a LEAKED one is invisible. Nor did anything else catch it — #68's
 * oracle asks the kernel about one pty master descriptor (`fstat`, per-fd; a timer is not an fd) and
 * #69's soak asks whether the ref'd tally returns to baseline (which an unref'd timer never enters).
 * This census is that missing oracle. (The kill escalation earns its place on that list twice over: it
 * is the case where the contrast is sharpest, a timer sitting on the very pty path #68's per-fd oracle
 * watches — and so the one place where "a timer is not an fd" costs that oracle a real miss.)
 *
 * **Why `async_hooks` and NOT `process._getActiveHandles()` — measured, not preferred.** The obvious
 * candidate is the undocumented `process._getActiveHandles()`, and the tradeoff looks like the usual
 * "breakage risk across Node majors vs. the coverage bought". It is not: on this repo's Node (v26) that
 * call reports **no timers at all — not even ref'd ones**. Probed directly — a ref'd `net` server reads
 * `["Server"]`, and arming a ref'd `setInterval` leaves it `["Server"]` UNCHANGED while
 * `getActiveResourcesInfo()` moves `["TCPServerWrap"]` → `["TCPServerWrap","Timeout"]`. The reason is
 * structural rather than incidental: a modern Node timer is not a libuv handle at all — it is a JS
 * object on a duration-keyed list behind ONE shared libuv timer — so a HANDLE census cannot see an
 * individual timer, ref'd or not. The coverage bought for this vector is therefore ZERO, and the
 * undocumented-API risk would be taken on for nothing. `async_hooks` is a documented, stable API that
 * DOES see them (probed: an unref'd `setInterval` is tracked, and `destroy` fires on `clearInterval`).
 *
 * **What `async_hooks` costs, and why that is paid only on demand.** Enabling a hook taxes every async
 * operation process-wide for the daemon's whole life — too much to impose on a daemon nobody is
 * diagnosing. So the census is armed LAZILY, on the FIRST {@link INSPECTOR_DIAGNOSTICS_SIGNAL} poke:
 * zero cost until an operator asks, and no restart needed to start paying it — the same "on demand, no
 * restart" bargain this whole module is built on. The price is that timers created BEFORE that first
 * poke are untracked, so the arming poke's own census reads ~0 and says so in words
 * ({@link formatTimerCensusReport}'s `justArmed` note). That is not a real loss: a leak is an
 * ACCUMULATION, so the growth AFTER arming is precisely the signal, and per-session timers churn.
 *
 * The census is split by ref-state ({@link TimerCensusReport.unrefd} / {@link TimerCensusReport.refd}),
 * read at SAMPLE time rather than at `init` — load-bearing, because the daemon unrefs on the line AFTER
 * arming, so an init-time read would report every one of these timers as ref'd. The tracked resource is
 * held through a {@link WeakRef} and pruned when it is gone, so the leak diagnostic cannot itself become
 * a leak. It rides the #61 trail as `diagnostic`/`timer-census` (info) — counts only, never a credential.
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

import { createHook } from "node:async_hooks";
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
 * The `async_hooks` resource type the census tracks: `Timeout` — the type every `setTimeout` /
 * `setInterval` inits under, and so the type every one of the daemon's `.unref()`'d per-session timers
 * carries (the module doc lists them; the count is deliberately not restated here, so that arming one
 * more cannot silently falsify this line). Deliberately not `Immediate` (a `setImmediate` resolves within
 * the same loop turn, so it cannot accumulate into the long-run leak this census exists to see) and
 * deliberately not every async type (a census of every promise and tick would drown the one signal in
 * noise at a far higher cost).
 */
const TIMER_CENSUS_ASYNC_TYPE = "Timeout";

/**
 * The `Timeout` surface the census reads at sample time. `hasRef` is optional because `createHook`'s
 * `init` types `resource` as a bare `object`: this shape is an ASSERTION the type system cannot back, not
 * a guarantee. Reading it optionally keeps one unexpected resource from throwing mid-sample and losing
 * every count with it — the same never-take-the-daemon-down posture the capture functions hold.
 */
interface RefStatefulTimer {
  hasRef?: () => boolean;
}

/**
 * A census of the daemon's LIVE timers, split by ref-state — the report {@link captureHandleReport}
 * structurally cannot produce. {@link unrefd} is the number this census exists for: the timers that are
 * armed and alive yet absent from the ref'd tally, where a leak would otherwise hide. A climbing
 * {@link unrefd} across successive pokes is the leak signal, exactly as a climbing type count is in
 * {@link HandleReport}.
 */
export interface TimerCensusReport {
  /** Live tracked timers — armed and not yet cleared or fired. Always {@link refd} + {@link unrefd}. */
  readonly total: number;
  /** Of which REF'D — the subset {@link process.getActiveResourcesInfo} already reports as `Timeout`. */
  readonly refd: number;
  /** Of which UNREF'D — the subset INVISIBLE to the ref'd tally. The leak vector no other oracle owns. */
  readonly unrefd: number;
}

/**
 * An armed timer census: a live `async_hooks` subscription that tracks every `Timeout` inited since it
 * was armed, and reads their ref-state on demand. Armed rather than point-in-time because `async_hooks`
 * is a SUBSCRIPTION — unlike {@link process.getActiveResourcesInfo}, it cannot report what it was not
 * listening for, which is why {@link installTimerCensus} must run before the timers it counts.
 */
export interface TimerCensus {
  /**
   * Read the currently-live tracked timers, pruning any that have been collected.
   *
   * EVENTUALLY CONSISTENT with respect to clears, and measured rather than assumed: `async_hooks`
   * fires `destroy` on a LATER loop turn, not synchronously inside `clearInterval` — probed on this
   * repo's Node (v26), a cleared timer is still counted by a sample taken in the same synchronous
   * block, and is gone after one `setImmediate`. Irrelevant to the operator this serves (successive
   * `SIGUSR1` pokes are seconds or hours apart, never microseconds) and fail-safe in any case: the
   * lag can only transiently OVER-count, so it can never mask the accumulation the census is read to
   * find. It matters only to a test sampling synchronously, which must yield a turn first.
   */
  sample(): TimerCensusReport;
  /** Disable the hook and drop every tracked reference. The census must not outlive its use. */
  dispose(): void;
}

/**
 * Arm a {@link TimerCensus} over `node:async_hooks`: subscribe to `Timeout` inits, drop each on
 * `destroy` (which fires on `clearTimeout` / `clearInterval` and after a one-shot fires), and read
 * ref-state at SAMPLE time via `hasRef()`.
 *
 * Sample-time ref-reading is the load-bearing choice: the daemon arms a timer and calls `.unref()` on
 * the NEXT line, so an `init`-time read would classify every one of them as ref'd and the census would
 * report the exact opposite of the truth.
 *
 * The tracked `Timeout` is held via {@link WeakRef} and pruned once collected, so a census left armed
 * cannot itself retain the timers it counts — a leak diagnostic that leaked would be worse than none.
 */
export function installTimerCensus(): TimerCensus {
  const tracked = new Map<number, WeakRef<RefStatefulTimer>>();
  const hook = createHook({
    init: (asyncId, type, _triggerAsyncId, resource) => {
      if (type !== TIMER_CENSUS_ASYNC_TYPE) {
        return;
      }
      tracked.set(asyncId, new WeakRef(resource));
    },
    destroy: (asyncId) => {
      tracked.delete(asyncId);
    },
  });
  hook.enable();
  return {
    sample: () => {
      let refd = 0;
      let unrefd = 0;
      for (const [asyncId, weak] of tracked) {
        const timer = weak.deref();
        if (timer === undefined) {
          // Collected without `destroy` ever firing: it cannot be holding anything, so it is not a leak.
          tracked.delete(asyncId);
          continue;
        }
        // No `hasRef` to read: count it REF'D — the conservative side. An unknown shape must not be
        // reported as the unref'd leak this census is read to detect.
        if (timer.hasRef?.() ?? true) {
          refd += 1;
        } else {
          unrefd += 1;
        }
      }
      return { total: refd + unrefd, refd, unrefd };
    },
    dispose: () => {
      hook.disable();
      tracked.clear();
    },
  };
}

/**
 * Render a {@link TimerCensusReport} as the one-line `detail` that rides the trail, leading with the
 * UNREF'D count — the number the census exists for — then the ref'd remainder that cross-checks against
 * `handle-report`'s own `Timeout` tally. Carries only counts, never a credential.
 *
 * `justArmed` marks the poke that armed the census, whose reading is ~0 for a reason an operator must
 * not have to infer: `async_hooks` reports nothing it was not yet listening for, so timers predating the
 * arming poke are untracked. Saying so inline is what stops a meaningless first `0` from being read as
 * "this daemon holds no timers".
 */
export function formatTimerCensusReport(report: TimerCensusReport, justArmed = false): string {
  const tally = `${report.total} live timers — unref'd=${report.unrefd}, ref'd=${report.refd}`;
  return justArmed
    ? `${tally} (census just armed — timers predating this poke are untracked; poke again to read an accumulation)`
    : tally;
}

/** The outcome of a census sample: the report on success, or a reason on failure. */
export type TimerCensusOutcome =
  { readonly ok: true; readonly report: TimerCensusReport } | { readonly ok: false; readonly reason: string };

/**
 * The inputs {@link captureTimerCensus} runs over: the armed census it reads, the sink it records on, and
 * whether this poke armed it. Not "the injectable seams … all with production defaults" its two siblings
 * carry — only `logger` is a seam here; `census` is a required input (there is no honest default, see
 * below) and `justArmed` a fact about this one invocation.
 */
export interface TimerCensusDeps {
  /**
   * The ARMED census to read. No default, and that is the contract: a census must be armed before the
   * timers it counts exist, so there is no honest point-in-time fallback to default to.
   */
  readonly census: TimerCensus;
  /** Structured-log sink the census is recorded on (default: {@link NO_OP_LOGGER}). */
  readonly logger?: Logger;
  /** Whether this poke armed the census — appends the untracked-predecessors note (default: `false`). */
  readonly justArmed?: boolean;
}

/**
 * Sample an armed {@link TimerCensus} and record it on the #61 trail as a `diagnostic`/`timer-census`
 * info line, ALONGSIDE `handle-report` rather than merged into it — so {@link HandleReport}'s contract
 * and #69's baseline semantics are untouched, and the ref'd tally keeps meaning exactly what it meant.
 *
 * Never throws, for the same reason its sibling does not: a failed census on a struggling daemon must
 * not take the daemon down. The error is caught, recorded as `diagnostic`/`timer-census-failed` at error
 * level, and returned.
 */
export function captureTimerCensus(deps: TimerCensusDeps): TimerCensusOutcome {
  const { census, logger = NO_OP_LOGGER, justArmed = false } = deps;
  try {
    const report = census.sample();
    logger.log({
      category: "diagnostic",
      level: "info",
      event: "timer-census",
      sessionId: null,
      detail: formatTimerCensusReport(report, justArmed),
    });
    return { ok: true, report };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.log({
      category: "diagnostic",
      level: "error",
      event: "timer-census-failed",
      sessionId: null,
      detail: `timer census failed: ${reason}`,
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
  /**
   * Arm the timer census (default: {@link installTimerCensus}). Called at most ONCE — on the first poke
   * — so an undiagnosed daemon pays no `async_hooks` tax; a test injects a fake to keep a real hook out
   * of the test process.
   */
  readonly installCensus?: () => TimerCensus;
}

/**
 * Arm the deep-diagnosis trigger: install a handler for {@link INSPECTOR_DIAGNOSTICS_SIGNAL} that, on
 * each poke, samples the FD/handle counts ({@link captureHandleReport}), reads the unref'd-timer census
 * ({@link captureTimerCensus}, arming it on the first poke), and then ensures the inspector is attached
 * ({@link openInspector}) — the handle sample first, so the first poke's counts precede the inspector's
 * own socket handle. Returns a disposer that removes the handler AND disposes the census. The daemon
 * wires this once at its composition root (the CLI `serve` verb), passing the same structured-log sink
 * it gave the server so every action rides the daemon's trail.
 *
 * The census is armed on FIRST POKE rather than here, which is what keeps `async_hooks`' process-wide
 * cost off a daemon nobody is diagnosing while still needing no restart to start paying it (see the
 * module doc). Its disposal rides the returned disposer: a leak diagnostic outliving its own handler
 * would be one more leak.
 *
 * Each action is independently guarded and never throws, so one failing does not suppress the others.
 * A platform that cannot listen for the signal (Windows has no `SIGUSR1`) must not crash the daemon —
 * installation is guarded, the inability is surfaced once on the trail, and a no-op disposer is
 * returned so a caller can uninstall unconditionally.
 */
export function installInspectorDiagnosticsSignalHandler(deps: InspectorDiagnosticsSignalDeps = {}): () => void {
  const {
    signal = INSPECTOR_DIAGNOSTICS_SIGNAL,
    source = process,
    logger = NO_OP_LOGGER,
    installCensus = installTimerCensus,
    ...actionDeps
  } = deps;
  // Armed on the first poke and reused after. `censusArmFailed` latches so a box whose `async_hooks` is
  // unavailable reports the reason ONCE rather than on every poke thereafter.
  let census: TimerCensus | undefined;
  let censusArmFailed = false;
  // One poke runs every action off the shared seam bag — each picks the seams it needs and ignores the
  // rest — with the resolved logger applied. Spreading `actionDeps` (rather than naming fields) keeps an
  // absent seam absent under exactOptionalPropertyTypes, where an explicit `undefined` would not type-check.
  const handler = (): void => {
    captureHandleReport({ ...actionDeps, logger });
    let justArmed = false;
    if (census === undefined && !censusArmFailed) {
      try {
        census = installCensus();
        justArmed = true;
      } catch (error) {
        censusArmFailed = true;
        const reason = error instanceof Error ? error.message : String(error);
        logger.log({
          category: "diagnostic",
          level: "error",
          event: "timer-census-failed",
          sessionId: null,
          detail: `timer census could not be armed: ${reason}`,
        });
      }
    }
    if (census !== undefined) {
      captureTimerCensus({ census, logger, justArmed });
    }
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
    census?.dispose();
    census = undefined;
  };
}
