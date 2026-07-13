// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fenced, self-classifying LIVE-WORKER oracle — the credentialed complement to
 * the hermetic wire-conformance golden (issue #133, traces E2E-B-002).
 *
 * The hermetic golden (`bridge-wire-conformance.ts`, asserted in
 * `wire-conformance.e2e.test.ts`) is fully hermetic — loopback only, no real worker,
 * no credentials, no egress — and pins the *shapes* of the environments-bridge wire.
 * But a hermetic golden can only verify "the server emits the wire the golden
 * encodes," never "the golden encodes the wire the real Claude Code worker actually
 * speaks." If the captured shapes drift from a future worker release, the hermetic
 * golden stays green while real interop silently breaks.
 *
 * This oracle is the independent live check that closes that gap. It drives a REAL
 * patched worker against the REAL {@link CcctlServer} and classifies the OBSERVED wire
 * against the golden's PINNED shapes — so the two together are necessary AND
 * sufficient: the golden pins the shapes, the oracle proves a real worker still speaks
 * them. Three properties, each load-bearing:
 *
 *   - **Fenced / opt-in.** {@link resolveOracleEnv} gates the whole run on
 *     `CCCTL_E2E` + `CCCTL_SDK_URL` + `ANTHROPIC_API_KEY` (all three present). Absent →
 *     the caller SKIPS the suite (`describe.skipIf`); this oracle lives OUTSIDE the
 *     credential-free CI `e2e` lane and never runs — nor fails — there.
 *   - **Self-classifying.** Every driven run yields exactly one {@link OracleVerdict}:
 *     `verified` (the live wire matches every pinned golden shape), `drift` (a leg's
 *     live wire diverges — the golden's shapes are stale vs the current worker; the
 *     diverging leg(s) are NAMED), or `inconclusive` (a required leg was never observed —
 *     the worker didn't reach `idle`, no turn completed, or a bridge response was never
 *     captured). {@link classifyObservedWire} is the pure decision.
 *   - **Skips-never-fakes.** When credentials / a real worker are absent it SKIPS (the
 *     fence) or self-classifies `inconclusive` (the drive) — it NEVER substitutes a
 *     synthetic / fake leg that would make an absent oracle look green (the exact
 *     circular-fixture failure #131 removed). A missing leg is `inconclusive`, never a
 *     fabricated pass.
 *
 * Receiver-grounded, exactly as `one-session-harness.ts`: every "reached X" verdict is
 * read from the endpoint that actually took the traffic — the server's own
 * environments + session maps for §1/§2 and the derived-`idle` activity for §4, the
 * poll body the bridge received for §3 — never a sender's self-report. The pinned-shape
 * checks reuse the golden's OWN pure assertions ({@link assertEnvironmentRegisterResponseWire},
 * {@link assertSessionCreateResponseWire}, {@link assertWorkItemWire}), so "drift" is
 * literally "the captured live wire fails the same shape gate the hermetic golden pins."
 *
 * The oracle plays the environments-bridge role (§1 register → §2 session-create → §3
 * work-poll) against the live server — capturing each real response body — and hands a
 * REAL patched worker everything it needs to open the §4/§5 per-session channel, reach
 * `idle`, and process one injected turn. The bridge legs' captured bytes are checked
 * against the pinned golden; the real worker's channel is grounded on the server's own
 * derived state. This is the same bridge + worker + phone split the hermetic harness
 * runs, with the FAKE worker swapped for a real one — the swap the walking skeleton was
 * always headed for.
 *
 * Forward-looking seam: the concrete way a patched worker is brought up
 * ({@link PatchedWorkerLauncher}) is the credentialed-wave integration point. The repo
 * ships no real-worker launcher today (#71 wired the `ccctl serve` / `patch` / `tunnel`
 * verbs, but packaging a patched worker is a later, credentialed wave), so the DEFAULT
 * launcher ({@link spawnPatchedWorker}) spawns the operator-supplied
 * `CCCTL_SDK_URL` command with a documented env contract, and any mismatch surfaces
 * SAFELY as `inconclusive` (the worker never reaches `idle`) — never a fake green. The
 * launcher is injectable so the pure fence + classification logic is fully unit-testable
 * WITHOUT credentials (see `live-worker-oracle.test.ts`), and the concrete contract can
 * firm up when the patched-worker packaging lands, with zero churn to the oracle.
 */

import { spawn } from "node:child_process";
import { environmentWorkPollPath, ENVIRONMENTS_BRIDGE_PATH, formatAuthority, SESSIONS_PATH } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import {
  assertEnvironmentRegisterResponseWire,
  assertRegisterStatus,
  assertSessionCreateResponseWire,
  assertWorkItemWire,
  BRIDGE_ENVIRONMENT_REGISTER_BODY,
  BRIDGE_SESSION_CREATE_BODY,
  type DecodedWorkSecret,
} from "./bridge-wire-conformance.js";

// --- fencing (pure) ---

/** The three env vars that fence the credentialed oracle — all three must be present. */
export const ORACLE_ENV_VARS = ["CCCTL_E2E", "CCCTL_SDK_URL", "ANTHROPIC_API_KEY"] as const;

/** The resolved, present-and-non-empty oracle configuration (only built when the fence is satisfied). */
export interface OracleConfig {
  /**
   * The `CCCTL_SDK_URL` value — the operator-supplied handle to the patched worker the
   * default launcher brings up (a launch command; see {@link spawnPatchedWorker}). Opaque
   * to the fence, which requires only that it be present and non-empty.
   */
  readonly sdkUrl: string;
  /** The `ANTHROPIC_API_KEY` — the credential the REAL worker uses to reach api.anthropic.com for the one turn. */
  readonly apiKey: string;
}

/** The fence verdict: ready (all three env vars present) or not (naming the absent ones). */
export type OracleFence =
  | { readonly ready: true; readonly config: OracleConfig }
  | { readonly ready: false; readonly missing: readonly string[] };

/**
 * Resolve the credentialed-oracle fence from an environment. READY only when ALL of
 * `CCCTL_E2E` (truthy, i.e. present and not `""` / `"0"` / `"false"`), `CCCTL_SDK_URL`
 * (non-empty), and `ANTHROPIC_API_KEY` (non-empty) are set; otherwise NOT ready, naming
 * every absent var. Pure over the injected `env` (defaults to `process.env`) so the
 * fence is unit-testable without mutating the process environment — the caller wraps
 * this in `describe.skipIf(!fence.ready)` so an unfenced run SKIPS (never fails, never
 * fakes) and never enters the credential-free CI lane.
 */
export function resolveOracleEnv(env: NodeJS.ProcessEnv = process.env): OracleFence {
  const missing: string[] = [];

  if (!isTruthyFlag(env.CCCTL_E2E)) {
    missing.push("CCCTL_E2E");
  }
  const sdkUrl = env.CCCTL_SDK_URL ?? "";
  if (sdkUrl === "") {
    missing.push("CCCTL_SDK_URL");
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (apiKey === "") {
    missing.push("ANTHROPIC_API_KEY");
  }

  if (missing.length > 0) {
    return { ready: false, missing };
  }
  return { ready: true, config: { sdkUrl, apiKey } };
}

/** A one-line human reason for a fence miss — used by the caller's skip note. */
export function describeFence(fence: OracleFence): string {
  return fence.ready
    ? "credentialed oracle armed (CCCTL_E2E + CCCTL_SDK_URL + ANTHROPIC_API_KEY present)"
    : `credentialed oracle fenced off — missing ${fence.missing.join(", ")}`;
}

/** Whether an env flag reads as ON — present and not one of the conventional OFF spellings. */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

// --- classification (pure) ---

/** The self-classifying verdict of one driven oracle run. */
export type OracleVerdict = "verified" | "drift" | "inconclusive";

/** Canonical per-leg labels — named in a `drift` verdict and in `inconclusive` gap reports. */
export const ORACLE_LEG = {
  register: "environment-register (§1)",
  sessionCreate: "session-create (§2)",
  workPoll: "work-poll (§3)",
  workerChannel: "worker-channel (§4/§5)",
} as const;

/**
 * The receiver-grounded observation of ONE live run, fed to {@link classifyObservedWire}.
 *
 * The three `*Body` fields are the RAW response bytes the live server returned on each
 * bridge leg (`undefined` when the leg was never reached because an upstream leg drifted
 * and no id could be extracted to issue the next request). `registerStatus` is the §1
 * response STATUS captured alongside its body, so the oracle asserts the register 200 —
 * not just the register body shape (issue #155). The three booleans are the real worker's
 * §4/§5 liveness, each read from the server's OWN state (the held-open worker downstream it
 * tracks, the `idle` activity it derived, the turn it ran) — never a self-report.
 */
export interface LiveCapture {
  /** Raw §1 `POST /v1/environments/bridge` response body, or `undefined` if never captured. */
  readonly registerBody?: string | undefined;
  /** The §1 register response STATUS (the pinned `200`, #154), or `undefined` if never captured. A non-200 is register-leg drift. */
  readonly registerStatus?: number | undefined;
  /** Raw §2 `POST /v1/sessions` response body, or `undefined` if never captured. */
  readonly sessionCreateBody?: string | undefined;
  /** Raw §3 `GET …/work/poll` response body, or `undefined` if never captured. */
  readonly workPollBody?: string | undefined;
  /** A real worker opened the §4/§5 channel and holds its downstream open (server's `hasLiveWorker`, receiver-grounded — NOT mere session existence). */
  readonly workerRegistered: boolean;
  /** The server derived `idle` activity from a CONNECTED worker's §4 status — the `idle` read gated on a live downstream, not the session's creation-default idle. */
  readonly reachedIdle: boolean;
  /** One injected turn was picked up and completed by the real worker (left `idle` then returned, receiver-grounded). */
  readonly turnObserved: boolean;
}

/** The classified report of one driven run: the verdict, the named diverging legs, and a human reason. */
export interface OracleReport {
  readonly verdict: OracleVerdict;
  /** The legs whose live wire diverged from the pinned golden shapes — non-empty ONLY for `drift`. */
  readonly divergentLegs: readonly string[];
  /** A human-readable explanation: which shapes matched, which drifted (with the shape error), or what was never captured. */
  readonly reason: string;
}

/**
 * Classify one {@link LiveCapture} into a {@link OracleReport} — the pure heart of the
 * oracle, unit-testable without a live worker.
 *
 * Precedence is deliberate: a PRESENT-but-divergent bridge body is a definitive `drift`
 * (the wire diverged — that is the signal the oracle exists to raise), so it OUTRANKS a
 * missing capture. Only when every captured body matches its pinned golden shape does an
 * absent leg become `inconclusive` (couldn't capture — no signal, never faked green):
 *
 *   1. **drift** — any captured `*Body` FAILS the golden's own pinned assertion
 *      ({@link assertEnvironmentRegisterResponseWire} / {@link assertSessionCreateResponseWire} /
 *      {@link assertWorkItemWire}), OR the captured §1 register STATUS is not the pinned
 *      `200` ({@link assertRegisterStatus} — a `201` is the pre-#154 divergence, #155).
 *      Every failing leg is named, each with its shape / status error.
 *   2. **inconclusive** — no drift, but a required leg was never observed: a bridge body
 *      is `undefined`, or the real worker never registered / never reached `idle` / never
 *      completed a turn. The gaps are named.
 *   3. **verified** — every captured body matches its pinned golden shape AND the real
 *      worker registered, reached `idle`, and completed one turn.
 */
export function classifyObservedWire(capture: LiveCapture): OracleReport {
  // 1. Drift — any captured body that fails its pinned golden shape, or the §1 register
  //    STATUS that is not the pinned 200. Checked FIRST so a present-but-divergent leg is
  //    never masked by a downstream inconclusive gap.
  const drifts: string[] = [];
  checkPinnedRegisterStatus(capture.registerStatus, drifts);
  checkPinnedShape(capture.registerBody, ORACLE_LEG.register, assertEnvironmentRegisterResponseWire, drifts);
  checkPinnedShape(capture.sessionCreateBody, ORACLE_LEG.sessionCreate, assertSessionCreateResponseWire, drifts);
  checkPinnedShape(capture.workPollBody, ORACLE_LEG.workPoll, assertWorkItemWire, drifts);

  if (drifts.length > 0) {
    const legs = uniqueLegs(drifts.map(legOf));
    return {
      verdict: "drift",
      divergentLegs: legs,
      reason: `live wire diverged from the pinned golden shapes on ${legs.length} leg(s): ${drifts.join("; ")}`,
    };
  }

  // 2. Inconclusive — every present body conformed, but a required observation is missing.
  const gaps: string[] = [];
  if (capture.registerBody === undefined) {
    gaps.push(`${ORACLE_LEG.register} response was never captured`);
  }
  if (capture.sessionCreateBody === undefined) {
    gaps.push(`${ORACLE_LEG.sessionCreate} response was never captured`);
  }
  if (capture.workPollBody === undefined) {
    gaps.push(`${ORACLE_LEG.workPoll} response was never captured`);
  }
  if (!capture.workerRegistered) {
    gaps.push(`the real worker never opened the ${ORACLE_LEG.workerChannel} channel`);
  }
  if (!capture.reachedIdle) {
    gaps.push("the real worker never reached idle");
  }
  if (!capture.turnObserved) {
    gaps.push("no turn completed");
  }

  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      divergentLegs: [],
      reason: `could not capture the live wire — ${gaps.join(", ")}`,
    };
  }

  // 3. Verified — every pinned shape matched and the real worker completed the flow.
  return {
    verdict: "verified",
    divergentLegs: [],
    reason:
      "the live worker wire matches every pinned golden shape (§1/§2/§3), and a real worker reached idle and completed one turn",
  };
}

/** Run one pinned assertion over a captured body; on throw, record a `leg: message` drift entry. */
function checkPinnedShape(
  body: string | undefined,
  leg: string,
  assertShape: (body: string) => unknown,
  drifts: string[],
): void {
  if (body === undefined) {
    return; // absence is an inconclusive gap, not a drift — handled in the caller.
  }
  try {
    assertShape(body);
  } catch (error) {
    drifts.push(`${leg}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run the pinned §1 register STATUS assertion ({@link assertRegisterStatus}) over the
 * captured status; on throw (a non-200 — the pre-#154 201 the worker rejects), record a
 * register-leg drift. Absence is an inconclusive gap (handled via the body check in the
 * caller), never a drift — a leg that never answered has no status to pin (issue #155).
 */
function checkPinnedRegisterStatus(status: number | undefined, drifts: string[]): void {
  if (status === undefined) {
    return;
  }
  try {
    assertRegisterStatus(status);
  } catch (error) {
    drifts.push(`${ORACLE_LEG.register}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The `leg` prefix of a `leg: message` drift entry (up to the first `": "`). */
function legOf(drift: string): string {
  const separator = drift.indexOf(": ");
  return separator === -1 ? drift : drift.slice(0, separator);
}

/** De-duplicate leg labels, preserving first-seen order. */
function uniqueLegs(legs: readonly string[]): string[] {
  return [...new Set(legs)];
}

// --- worker launch seam (the credentialed-wave integration point) ---

/** Everything a real patched worker needs to open the §4/§5 channel for the created session. */
export interface WorkerLaunchOptions {
  /** The operator handle to the patched worker (`CCCTL_SDK_URL`) — the launch command for {@link spawnPatchedWorker}. */
  readonly sdkUrl: string;
  /** The credential the worker uses to reach api.anthropic.com for the one turn. */
  readonly apiKey: string;
  /** The `http://host:port` base of the live control server the worker points its channel at. */
  readonly controlBaseUrl: string;
  /** The session id the §2 create minted — the channel is rooted under it. */
  readonly sessionId: string;
  /** The per-session ingress token decoded from the §3 work-secret — the §4/§5 credential (NOT the account Bearer, #130). */
  readonly sessionIngressToken: string;
}

/** A handle to a launched patched worker — `close()` tears it down at the end of the run. */
export interface PatchedWorkerHandle {
  close(): Promise<void>;
}

/**
 * The seam that brings up a real patched worker for the §4/§5 channel. Injectable so
 * the oracle's fence + classification are unit-testable without a real worker, and so
 * the concrete launch contract can firm up when the patched-worker packaging lands
 * (post-#71) with zero churn to the oracle. When the launch does not (yet) result in a
 * worker that reaches `idle`, the oracle self-classifies `inconclusive` — never a fake
 * green.
 */
export type PatchedWorkerLauncher = (options: WorkerLaunchOptions) => Promise<PatchedWorkerHandle>;

/**
 * The DEFAULT launcher: spawn the operator-supplied `CCCTL_SDK_URL` as a command,
 * pointing it at the live control server via a documented ENV contract (env is a more
 * drift-stable interface than guessed CLI flags):
 *
 *   - `CCCTL_WORKER_CONTROL_URL` — the `http://host:port` base of the §4/§5 channel host;
 *   - `CCCTL_WORKER_SESSION_ID` — the session the worker attaches to;
 *   - `CCCTL_WORKER_INGRESS_TOKEN` — the per-session §4/§5 credential (from the work-secret);
 *   - `ANTHROPIC_API_KEY` — carried through for the worker's real inference on the one turn.
 *
 * This is the credentialed-wave contract, not a claim about today's Claude Code build:
 * the repo ships no packaged patched worker yet (#71 wired the `ccctl serve` daemon, but
 * the patched-worker packaging is a later wave), so a `CCCTL_SDK_URL` that does not honor
 * this contract simply never drives the
 * channel to `idle`, and the run self-classifies `inconclusive`. Kills the child on
 * `close()` so a serial e2e run leaks no process.
 */
export function spawnPatchedWorker(options: WorkerLaunchOptions): Promise<PatchedWorkerHandle> {
  const child = spawn(options.sdkUrl, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      CCCTL_WORKER_CONTROL_URL: options.controlBaseUrl,
      CCCTL_WORKER_SESSION_ID: options.sessionId,
      CCCTL_WORKER_INGRESS_TOKEN: options.sessionIngressToken,
      ANTHROPIC_API_KEY: options.apiKey,
    },
  });
  child.on("error", () => {
    // A ChildProcess is an EventEmitter: an ASYNCHRONOUS spawn failure (e.g. the shell
    // itself cannot be spawned) emits `'error'` AFTER spawn() returns, and an emitter with
    // NO `'error'` listener RETHROWS it as an uncaught exception — which the drive's
    // try/catch (it wraps only the awaited promise chain, not an out-of-band event) would
    // NOT catch, crashing the run. Swallow it: a worker that failed to launch simply never
    // drives the channel to `idle`, so the drive's receiver-grounded wait times out and the
    // run self-classifies `inconclusive` (skips-never-fakes) instead of the process dying.
  });
  return Promise.resolve({
    close: (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      return Promise.resolve();
    },
  });
}

// --- the live drive (impure) ---

/** Inputs to drive one live-worker oracle run. */
export interface DriveOracleOptions {
  /** The REAL local ccctl server the bridge legs + worker channel run against. */
  readonly server: CcctlServer;
  /** The resolved oracle config (the `CCCTL_SDK_URL` handle + `ANTHROPIC_API_KEY`). */
  readonly config: OracleConfig;
  /**
   * The account Bearer presented on the §1/§2 bridge POSTs (the local server presence-checks
   * it; the real account OAuth token is the worker's concern for reaching Anthropic, #130).
   * Defaults to {@link ORACLE_BRIDGE_BEARER}.
   */
  readonly bearer?: string;
  /** The worker-launch seam. Defaults to {@link spawnPatchedWorker}. */
  readonly launcher?: PatchedWorkerLauncher;
  /** The prompt injected as the one turn. Defaults to {@link ORACLE_TURN_PROMPT}. */
  readonly turnPrompt?: string;
  /** How long each receiver-grounded wait (channel idle, turn completion) holds before giving up → `inconclusive`. */
  readonly liveTimeoutMs?: number;
}

/** The bridge-role Bearer the oracle presents on §1/§2 (the local server presence-validates it). */
export const ORACLE_BRIDGE_BEARER = "ccctl-oracle-account-bearer";

/** The prompt the oracle injects to drive exactly one turn through the real worker. */
export const ORACLE_TURN_PROMPT = "reply with the single word: pong";

/** Default per-wait budget for the live receiver-grounded observations. */
const DEFAULT_LIVE_TIMEOUT_MS = 120_000;

/** How long a bridge HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Drive one live-worker oracle run end-to-end and return its self-classified
 * {@link OracleReport}. The oracle plays the environments-bridge (§1 register → §2
 * session-create → §3 work-poll) against the live server, capturing each real response
 * body; then hands a REAL patched worker (via the {@link PatchedWorkerLauncher} seam)
 * everything it needs to open the §4/§5 channel, and waits — receiver-grounded, with a
 * timeout — for it to reach `idle` and process one injected turn.
 *
 * Never throws on a divergence or a missing leg: a shape drift becomes `drift` and a
 * missing observation becomes `inconclusive` (both via {@link classifyObservedWire}) —
 * the oracle SELF-CLASSIFIES rather than failing the harness, so "skips-never-fakes"
 * holds even when the real worker cannot be brought up. Tears the launched worker down
 * before returning so a serial run leaks no process.
 */
export async function driveLiveWorkerOracle(options: DriveOracleOptions): Promise<OracleReport> {
  const { server, config } = options;
  const bearer = options.bearer ?? ORACLE_BRIDGE_BEARER;
  const launcher = options.launcher ?? spawnPatchedWorker;
  const turnPrompt = options.turnPrompt ?? ORACLE_TURN_PROMPT;
  const liveTimeoutMs = options.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
  const controlBaseUrl = `http://${formatAuthority(server.address.host, server.address.port)}`;

  // §1/§2/§3 — the bridge legs. Capture each RAW response body (for the pinned-shape
  // check), plus the §1 register STATUS (pinned 200, #155), and, when a leg conforms,
  // extract the id/secret needed to drive the next.
  const register = await captureResponse(
    server,
    ENVIRONMENTS_BRIDGE_PATH,
    "POST",
    bearer,
    BRIDGE_ENVIRONMENT_REGISTER_BODY,
  );
  const registerBody = register.body;
  const registerStatus = register.status;
  const environmentId = tryExtract(() => assertEnvironmentRegisterResponseWire(registerBody ?? "").environment_id);

  const sessionCreateBody = (await captureResponse(server, SESSIONS_PATH, "POST", bearer, BRIDGE_SESSION_CREATE_BODY))
    .body;
  const sessionId = tryExtract(() => assertSessionCreateResponseWire(sessionCreateBody ?? "").session_id);

  // §3 is reachable only when §1 gave an environment id; poll AFTER §2 so the auto-enqueued
  // session item is delivered immediately.
  const workPollBody =
    environmentId !== undefined
      ? (await captureResponse(server, environmentWorkPollPath(environmentId), "GET", null, undefined)).body
      : undefined;
  const workSecret = tryExtract((): DecodedWorkSecret => assertWorkItemWire(workPollBody ?? "").secret);

  // §4/§5 — hand a REAL worker the channel and observe it live. Only attempt when the
  // bridge legs conformed enough to yield a session + ingress token; otherwise the bridge
  // drift is already the verdict and the liveness stays false (→ classified below).
  let workerRegistered = false;
  let reachedIdle = false;
  let turnObserved = false;
  let worker: PatchedWorkerHandle | undefined;
  if (sessionId !== undefined && workSecret !== undefined) {
    try {
      worker = await launcher({
        sdkUrl: config.sdkUrl,
        apiKey: config.apiKey,
        controlBaseUrl,
        sessionId,
        sessionIngressToken: workSecret.session_ingress_token,
      });

      // Wait for a REAL worker to open the §4/§5 channel AND report idle — both read from
      // the server's OWN state (`hasLiveWorker` = a held-open worker downstream exists;
      // `idle` = the activity the server DERIVED from the worker's status frame), never the
      // worker's self-report. Gating the idle read on `hasLiveWorker` is load-bearing: a
      // bare session carries a creation-default `idle` activity with NO worker, so the
      // downstream check is what makes "reached idle" mean a connected worker, not an empty
      // session.
      reachedIdle = await waitForReceiver(
        () => server.hasLiveWorker(sessionId) && server.sessions.get(sessionId)?.activity.kind === "idle",
        liveTimeoutMs,
      );
      // Grounded after the wait: whether a live worker channel exists right now. If the wait
      // timed out with no worker, this is false → "never opened the channel"; if a worker
      // connected but never idled, this is true while `reachedIdle` is false → "never reached
      // idle". Either way the classifier reports a precise inconclusive gap.
      workerRegistered = server.hasLiveWorker(sessionId);

      if (reachedIdle) {
        // Drive exactly ONE turn and ground its completion in the server's derived activity.
        // Safe: `reachedIdle` implies a live downstream, so the injection precondition holds
        // (and the surrounding catch turns any residual race into `inconclusive`, not a throw).
        turnObserved = await observeOneTurn(server, sessionId, turnPrompt, liveTimeoutMs);
      }
    } catch {
      // A launch failure, a downstream that closed mid-drive, or an injection race leaves the
      // liveness flags false so the run SELF-CLASSIFIES `inconclusive` — the oracle never
      // throws out of the harness (skips-never-fakes; it cannot reach `verified` without a
      // real, observed turn, so failing here is always safe).
    } finally {
      if (worker !== undefined) {
        await worker.close();
      }
    }
  }

  return classifyObservedWire({
    registerBody,
    registerStatus,
    sessionCreateBody,
    workPollBody,
    workerRegistered,
    reachedIdle,
    turnObserved,
  });
}

/**
 * Inject one turn and observe it complete, grounded in the server's derived activity: a
 * real worker LEAVES `idle` to run the injected turn (activity → `running` /
 * `requires_action`), then RETURNS to `idle`. `false` if the worker never picks it up
 * within the budget (→ `inconclusive`, never faked). Called only after `reachedIdle`, so
 * the injection precondition (a live downstream) holds; the caller's `catch` turns any
 * residual race into `inconclusive` rather than a throw.
 */
async function observeOneTurn(
  server: CcctlServer,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
): Promise<boolean> {
  server.injectTurn(sessionId, prompt);
  // The worker leaves idle to run the turn (running or requires_action)...
  const started = await waitForReceiver(() => server.sessions.get(sessionId)?.activity.kind !== "idle", timeoutMs);
  if (!started) {
    return false;
  }
  // ...and returns to idle when the turn completes.
  return waitForReceiver(() => server.sessions.get(sessionId)?.activity.kind === "idle", timeoutMs);
}

/** A captured bridge response: the STATUS and RAW body bytes, or both `undefined` when the request could not complete. */
interface CapturedResponse {
  readonly status: number | undefined;
  readonly body: string | undefined;
}

/**
 * Issue one bridge request and return its STATUS and RAW response body, or both
 * `undefined` if the request could not complete (network / timeout) — an unreachable leg
 * is an inconclusive gap, not a drift. A non-2xx response still returns (status + body) so
 * the pinned checks classify it (a drifted §1 register status or a 4xx/5xx body fails its
 * gate → `drift`, not a silent pass).
 */
async function captureResponse(
  server: CcctlServer,
  path: string,
  method: "GET" | "POST",
  bearer: string | null,
  body: unknown,
): Promise<CapturedResponse> {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  if (bearer !== null) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (method === "POST") {
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`http://${formatAuthority(server.address.host, server.address.port)}${path}`, init);
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: undefined, body: undefined };
  }
}

/** Run `extract`, returning its value or `undefined` if it throws (a drift the classifier reports). */
function tryExtract<T>(extract: () => T): T | undefined {
  try {
    return extract();
  } catch {
    return undefined;
  }
}

/**
 * Poll `predicate` until it holds or `timeoutMs` lapses — the receiver-grounded wait the
 * drive uses to observe an asynchronous live hop landing (the worker reaching idle, a
 * turn completing). Resolves `true` when it held, `false` on timeout (→ `inconclusive`).
 */
export async function waitForReceiver(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
