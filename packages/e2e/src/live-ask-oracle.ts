// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fenced, self-classifying ASKUSERQUESTION PHONE-SURFACING oracle — the credentialed live-worker
 * gate that discharges #78 AC4 (issue #266, #78 Option A), the last hop ADR-005's #263 spike could not
 * reach.
 *
 * **The one thing this gate OBSERVES that nothing else can.** `@ccctl/core` states the claim and its
 * exact epistemic status: `AskUserQuestion` blocks NATIVELY even under `bypassPermissions` (a mode that
 * suppresses permission *prompts* does not touch an INTERACTION tool) — that block is OBSERVED against
 * the stock permission engine (ADR-005). But that the worker then SURFACES the block as
 * `worker_status: requires_action` over §4/§5 "is a strong INFERENCE, not yet observed: the spike ran
 * against the TUI and could not reach the last hop, which the #266 live-worker gate owns" (see
 * `@ccctl/core` § `NON_PROMPTING_PERMISSION_MODES`). This oracle IS that last hop: it drives a REAL
 * `bypassPermissions` worker to invoke `AskUserQuestion` and reads, from the server's OWN derived
 * activity, whether the block surfaced as `requires_action` — turning the inference into an observation
 * or, if it does not hold, into a NAMED drift.
 *
 * It is the AskUserQuestion sibling of the #133 wire-conformance {@link driveLiveWorkerOracle}: same
 * fence ({@link resolveOracleEnv}), same worker-launch seam ({@link spawnPatchedWorker} —
 * EXTENDED here with the #78 hook wiring), same receiver-grounded discipline, same
 * `verified` / `drift` / `inconclusive` posture. What differs is the LEG it judges: not the bridge wire
 * shapes, but the AskUserQuestion surfacing.
 *
 * The three properties every oracle in this package holds, held here too:
 *
 *   - **Fenced / opt-in.** {@link resolveOracleEnv} (REUSED from #133) gates the run on
 *     `CCCTL_E2E` + `CCCTL_SDK_URL` + `ANTHROPIC_API_KEY`. Absent → the caller SKIPS the suite
 *     (`describe.skipIf`); this gate lives OUTSIDE the credential-free CI `e2e` lane. The JUDGMENT
 *     ({@link classifyAskSurfacing}) is unit-tested credential-free in `live-ask-oracle.test.ts`.
 *   - **Self-classifying.** Every driven run yields exactly one {@link AskOracleVerdict}: `verified`
 *     (a real worker invoked `AskUserQuestion`, the #78 hook captured well-formed structured options,
 *     AND the block surfaced as `requires_action`), `drift` (the worker invoked `AskUserQuestion` — the
 *     hook fired — but the block NEVER surfaced as `requires_action`, i.e. the #266 inference is
 *     FALSIFIED; OR the hook's captured payload is not well-formed structured options — the leg is
 *     NAMED and the run FAILS), or `inconclusive` (the worker never reached idle, or never invoked
 *     `AskUserQuestion` at all — runtime-skip, never a fabricated green).
 *   - **Skips-never-fakes.** When credentials / a real worker / a real `AskUserQuestion` tool call are
 *     absent, it SKIPS (the fence) or self-classifies `inconclusive` (the drive) — it NEVER substitutes
 *     a synthetic block that would make an absent oracle look green.
 *
 * **Two receiver-grounded reads, two different receivers — and why.** The needs-you surfacing is
 * read from the SERVER's OWN derived activity (`server.sessions.get(id)?.activity.kind`), exactly as
 * `driveLiveWorkerOracle` reads `idle`. The STRUCTURED OPTIONS are read from the #78 hook's OWN handoff
 * file — the bytes the `PreToolUse` hook captured from the real `AskUserQuestion` `tool_input` — and
 * classified through core's OWN {@link requiresActionEnrichmentFromValue}, the same fail-closed guard
 * the server uses to buffer a worker-emitted enrichment. Grounding the options on the hook output rather
 * than on the server's `hasBufferedEnrichment` is FORCED, not a shortcut: the server's
 * hook→reconcile→buffer→serve path (`worker-channel.ts` § `reconcileHookHandoff`) fires ONLY for a
 * session the server LAUNCHED (its `hookInstalls` map is populated exclusively by
 * `ui-session-launch.ts` § `launchSession`). This oracle brings its `bypassPermissions` session —
 * the #266 target — up over the BRIDGE (a §2 attach registration), NOT via launch, so it carries no
 * `hookInstalls` entry; its handoff is never reconciled and `hasBufferedEnrichment` would read
 * `false` even on a perfect surfacing. (The LAUNCH↔BRIDGE split is what governs the `hookInstalls`
 * entry, not the permission mode — ADR-007 lets launch accept `bypassPermissions` too, but this
 * oracle deliberately drives the bridge on-ramp, the path with no install.) The server-side buffer→serve
 * IS already unit/contract-tested (`worker-channel.test.ts` § hook-handoff correlation) — but ONLY for
 * a LAUNCHED/prompting session, the one kind that carries a `hookInstalls` entry. The served-enrichment
 * leg for a `bypassPermissions`/bridge session is therefore covered by NEITHER this gate's live run NOR
 * those hermetic tests: it is structurally unreachable without a bridge-path hook install (see the SCOPE
 * note below). This gate's novel job is the two LIVE behaviors it alone can observe — the worker
 * surfacing `requires_action`, and the real hook firing with well-formed options against a real worker.
 *
 * **The hook is the REAL one.** {@link installAskUserQuestionHookSettings} (re-exported from
 * `@ccctl/server`) resolves the actual `ask-user-question-hook.js` the daemon installs, and this oracle
 * wires it into the worker's launch via the seam's new `CCCTL_WORKER_HOOK_SETTINGS`
 * ({@link WorkerLaunchOptions.hookSettingsPath}). So a `verified` verdict proves the SHIPPED hook works
 * against a real worker, not a re-implemented copy.
 *
 * **SCOPE — the (`bypassPermissions` + hook) pairing is GATE-constructed, and deliberately so.** The
 * hook BINARY is the shipped one, but the CONFIGURATION it runs in here is not one the product currently
 * produces on its own: today the daemon installs the #262 hook (and runs `reconcileHookHandoff`) ONLY for
 * a session it LAUNCHED — never for one that registered over the BRIDGE (a §2 attach) — so a
 * `bypassPermissions`/bridge session gets NEITHER the install NOR the reconcile in the product. This
 * gate installs the hook itself (via `--settings`) to
 * reach the one observation #266 owns: that a real `bypassPermissions` worker's native `AskUserQuestion`
 * block surfaces as `requires_action`. That is legitimate — the surfacing is a worker/server behavior
 * independent of WHO installed the hook — but it means a `verified` verdict certifies the SURFACING and
 * the hook's CAPTURE, NOT a product path that installs-and-serves enrichment for bridge sessions. Whether
 * bridge/`bypassPermissions` sessions SHOULD get a product-level hook install + reconcile is a separate,
 * out-of-#266 concern (a likely future credentialed-wave item).
 *
 * **Forward-looking seam (unchanged from #133).** The repo ships no packaged patched worker yet, so the
 * DEFAULT launcher ({@link spawnPatchedWorker}) spawns the operator-supplied `CCCTL_SDK_URL` command
 * with the documented env contract; a command that does not honor it simply never drives the channel to
 * `idle` (or never invokes `AskUserQuestion`), and the run self-classifies `inconclusive` — never a
 * fake green. The launcher is injectable so the fence + classification are fully unit-testable WITHOUT
 * credentials.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { formatAuthority, requiresActionEnrichmentFromValue, type RequiresActionEnrichment } from "@ccctl/core";
import {
  cleanupHookInstall,
  installAskUserQuestionHookSettings,
  type CcctlServer,
  type HookInstall,
} from "@ccctl/server";
import { createSession, pollWork, registerEnvironment } from "./bridge-wire-conformance.js";
import {
  ORACLE_BRIDGE_BEARER,
  spawnPatchedWorker,
  waitForReceiver,
  type OracleConfig,
  type PatchedWorkerHandle,
  type PatchedWorkerLauncher,
} from "./live-worker-oracle.js";

// --- classification (pure) ---

/** The self-classifying verdict of one driven AskUserQuestion-surfacing run. */
export type AskOracleVerdict = "verified" | "drift" | "inconclusive";

/** Canonical per-leg labels — named in a `drift` verdict and in `inconclusive` gap reports. */
export const ASK_ORACLE_LEG = {
  workerChannel: "worker-channel (§4/§5)",
  askInvocation: "askuserquestion-invocation (#262 hook)",
  hookOptions: "structured-options (#262 hook capture)",
  requiresActionSurfacing: "requires-action-surfacing (#266)",
} as const;

/** The permission mode the gate's session + worker run under — the mode #266 exists to observe. */
export const ASK_ORACLE_PERMISSION_MODE = "bypassPermissions";

/**
 * The receiver-grounded observation of ONE driven run, fed to {@link classifyAskSurfacing}.
 *
 * The two booleans are read from the SERVER's OWN derived activity (a live worker reached idle, then the
 * block surfaced as `requires_action`) — never a worker self-report. `hookCaptureBody` is the RAW bytes
 * the #78 `PreToolUse` hook wrote to its handoff file when the real worker invoked `AskUserQuestion`
 * (the receiver here is the hook's own capture), or `undefined` when the hook never fired — the worker
 * never invoked `AskUserQuestion`, or the best-effort write did not land. A fresh handoff path per run
 * means a PRESENT body is always THIS run's capture, so `hookCaptureBody !== undefined` reads exactly as
 * "the real worker invoked `AskUserQuestion` this run".
 */
export interface LiveAskCapture {
  /** A real worker opened the §4/§5 channel and reached idle — the precondition for injecting the turn. */
  readonly reachedIdle: boolean;
  /**
   * The server DERIVED `requires_action` activity from the worker's §4/§5 status after the injected turn
   * — the native `AskUserQuestion` block surfaced as a needs-you (the #266 observation). Receiver-grounded
   * on `server.sessions.get(id)?.activity.kind`, never a worker self-report.
   */
  readonly reachedRequiresAction: boolean;
  /**
   * The RAW `{ questions }` the #78 hook captured from the real `AskUserQuestion` `tool_input`, or
   * `undefined` when the hook never fired (no `AskUserQuestion` invoked this run). Proof the tool call
   * happened AND the payload the phone would be offered.
   */
  readonly hookCaptureBody?: string | undefined;
}

/** The classified report of one driven run: the verdict, the named diverging legs, and a human reason. */
export interface AskOracleReport {
  readonly verdict: AskOracleVerdict;
  /** The legs whose observed behavior diverged from the contract — non-empty ONLY for `drift`. */
  readonly divergentLegs: readonly string[];
  /** A human-readable explanation: what verified, what drifted (with the shape error), or what was never captured. */
  readonly reason: string;
}

/**
 * The synthetic #201 stamp used ONLY to reuse {@link requiresActionEnrichmentFromValue}'s shape
 * validation over the hook's `{ questions }` capture. The hook writes NO `sequence_num` (a `PreToolUse`
 * hook fires before the `requires_action` transition whose stamp it would carry even exists — the REAL
 * stamp is minted server-side at that transition, `ask-user-question-hook.ts` § "No sequence_num"). This
 * gate does not judge the stamp — that is the server's job, unit-tested in `worker-channel.test.ts` — it
 * judges only whether the captured QUESTIONS are well-formed structured options, so it pairs them with an
 * arbitrary valid stamp (`0` passes {@link asWorkerStatusSequence}) to run the same core guard.
 */
const HOOK_CAPTURE_SHAPE_STAMP = 0;

/**
 * Parse the #78 hook's raw handoff capture into a {@link RequiresActionEnrichment}, or `null` if its
 * `questions` are not well-formed structured options. Reuses core's OWN
 * {@link requiresActionEnrichmentFromValue} (paired with {@link HOOK_CAPTURE_SHAPE_STAMP}) so "the hook
 * captured well-formed options" means EXACTLY "the same guard the server buffers a worker enrichment
 * through accepts them" — never a second, drifting notion of well-formed. A body that is not JSON, not
 * an object, or carries no usable `questions` all yield `null`.
 */
export function enrichmentFromHookCapture(body: string): RequiresActionEnrichment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { questions } = parsed as { questions?: unknown };
  return requiresActionEnrichmentFromValue({ sequence_num: HOOK_CAPTURE_SHAPE_STAMP, questions });
}

/**
 * Classify one {@link LiveAskCapture} into an {@link AskOracleReport} — the pure heart of the gate,
 * unit-testable without a live worker.
 *
 * Precedence mirrors every oracle here: an OBSERVED divergence is a definitive `drift`, so it OUTRANKS a
 * missing capture. The hook capture is the pivot — its PRESENCE is proof the real worker invoked
 * `AskUserQuestion` this run, which is what makes the two drift cases distinguishable from an
 * inconclusive "never asked":
 *
 *   1. **drift** — the worker DID invoke `AskUserQuestion` (the hook fired) AND either:
 *      (a) the captured `{ questions }` are NOT well-formed structured options
 *          ({@link enrichmentFromHookCapture} → `null`) — the hook fired against a payload the phone
 *          could never render; OR
 *      (b) the block NEVER surfaced as `requires_action` — the #266 inference is FALSIFIED: the worker
 *          invoked the interaction tool but the server's derived activity never became the needs-you
 *          #78 exists to deliver. ("Never" is bounded by the drive's `liveTimeoutMs` observation window:
 *          a surfacing SLOWER than that budget reads as this drift, deliberately — a post-ask stall past
 *          the budget is itself a real failure, and widening it to `inconclusive` would mask a
 *          broken-but-slow surfacing. See {@link driveLiveAskOracle}'s CAVEAT.)
 *   2. **inconclusive** — no drift, but a required observation is missing: the worker never reached
 *      idle, or never invoked `AskUserQuestion` at all (no hook capture — the model chose not to ask,
 *      which is a no-signal run, never a fabricated green).
 *   3. **verified** — a real worker reached idle, invoked `AskUserQuestion` (hook captured well-formed
 *      structured options), AND the block surfaced as `requires_action`. The #266 surfacing inference is
 *      CONFIRMED against a real worker.
 */
export function classifyAskSurfacing(capture: LiveAskCapture): AskOracleReport {
  // 1. Drift — checked FIRST, and gated on the hook having fired (the proof `AskUserQuestion` was
  //    invoked). A present-but-divergent surfacing is never masked by a downstream inconclusive gap.
  if (capture.hookCaptureBody !== undefined) {
    const enrichment = enrichmentFromHookCapture(capture.hookCaptureBody);
    if (enrichment === null) {
      return {
        verdict: "drift",
        divergentLegs: [ASK_ORACLE_LEG.hookOptions],
        reason:
          `the #78 hook fired (${ASK_ORACLE_LEG.askInvocation}) but its captured AskUserQuestion payload is ` +
          "not well-formed structured options — it fails core's requiresActionEnrichmentFromValue, so the phone " +
          "could not render a tappable choice from it",
      };
    }
    if (!capture.reachedRequiresAction) {
      return {
        verdict: "drift",
        divergentLegs: [ASK_ORACLE_LEG.requiresActionSurfacing],
        reason:
          `the worker invoked AskUserQuestion (the #78 hook captured ${enrichment.questions.length} well-formed ` +
          "structured question(s)) but the server NEVER derived requires_action from its §4/§5 status — the #266 " +
          "surfacing inference is falsified: the native block did not reach the phone as a needs-you",
      };
    }
  }

  // 2. Inconclusive — nothing drifted, but a required observation is missing.
  const gaps: string[] = [];
  if (!capture.reachedIdle) {
    gaps.push(`the real worker never reached idle (${ASK_ORACLE_LEG.workerChannel})`);
  }
  if (capture.hookCaptureBody === undefined) {
    gaps.push(`the worker never invoked AskUserQuestion — the #78 hook never fired (${ASK_ORACLE_LEG.askInvocation})`);
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      divergentLegs: [],
      reason: `could not observe the live AskUserQuestion surfacing — ${gaps.join(", ")}`,
    };
  }

  // 3. Verified — a real worker asked, the hook captured well-formed options, and the block surfaced.
  return {
    verdict: "verified",
    divergentLegs: [],
    reason:
      "a real bypassPermissions worker invoked AskUserQuestion (the #78 hook captured well-formed structured " +
      "options) and the server surfaced the native block as requires_action — the #266 phone-surfacing inference " +
      "is confirmed against a real worker",
  };
}

// --- the live drive (impure, fenced) ---

/** Inputs to drive one AskUserQuestion-surfacing oracle run. */
export interface DriveAskOracleOptions {
  /** The REAL local ccctl server the bridge legs + worker channel run against. */
  readonly server: CcctlServer;
  /** The resolved oracle config (the `CCCTL_SDK_URL` handle + `ANTHROPIC_API_KEY`) — reused from #133. */
  readonly config: OracleConfig;
  /** The account Bearer presented on the §1/§2 bridge POSTs. Defaults to {@link ORACLE_BRIDGE_BEARER}. */
  readonly bearer?: string;
  /** The worker-launch seam. Defaults to {@link spawnPatchedWorker}. */
  readonly launcher?: PatchedWorkerLauncher;
  /** The prompt injected to drive exactly one `AskUserQuestion` tool call. Defaults to {@link ASK_ORACLE_TURN_PROMPT}. */
  readonly turnPrompt?: string;
  /**
   * How long each receiver-grounded wait (channel idle, requires_action surfacing) holds before giving
   * up. A channel-idle timeout → `inconclusive`; a requires_action timeout is `inconclusive` when the
   * worker never asked, `drift` when it did (a surfacing slower than the budget — see
   * {@link driveLiveAskOracle}'s CAVEAT).
   */
  readonly liveTimeoutMs?: number;
  /**
   * Where {@link installAskUserQuestionHookSettings} writes the hook's settings + handoff files. Defaults
   * to the server installer's own XDG state dir; a test passes a temp dir so a hermetic drive never
   * touches the operator's real state directory.
   */
  readonly hookStateDir?: string;
}

/**
 * The prompt the oracle injects to drive exactly one `AskUserQuestion` tool call. Written to be as
 * unambiguous as an instruction can be — the model still AUTHORS the tool call, so a run where it chooses
 * NOT to ask self-classifies `inconclusive` (no hook capture), never a false red.
 */
export const ASK_ORACLE_TURN_PROMPT =
  "Call the AskUserQuestion tool right now, before doing anything else, to ask the user whether to " +
  'proceed. Offer exactly two options with the labels "Proceed" and "Cancel".';

/** Default per-wait budget for the live receiver-grounded observations. */
const DEFAULT_ASK_LIVE_TIMEOUT_MS = 120_000;

/**
 * Drive one AskUserQuestion-surfacing oracle run end-to-end and return its self-classified
 * {@link AskOracleReport}. NEVER throws on a divergence or a missing leg — it returns a verdict, so
 * "skips-never-fakes" holds even when the real worker cannot be brought up.
 *
 * Installs the REAL #78 hook, plays the environments-bridge to bring up a `bypassPermissions` session
 * over the bridge (a §2 attach registration — the on-ramp this oracle drives, whose session carries no
 * `hookInstalls` entry, unlike a launched one), hands a REAL patched worker the channel WITH the hook
 * wired in, waits for it to reach idle, injects one turn instructing an
 * `AskUserQuestion` call, and observes — receiver-grounded, with a timeout — whether the block surfaced
 * as `requires_action`. Then reads the hook's own capture (the structured options) and classifies. Tears
 * the worker down and cleans the hook-install files before returning, so a serial run leaks neither a
 * process nor a file.
 */
export async function driveLiveAskOracle(options: DriveAskOracleOptions): Promise<AskOracleReport> {
  const { server, config } = options;
  const bearer = options.bearer ?? ORACLE_BRIDGE_BEARER;
  const launcher = options.launcher ?? spawnPatchedWorker;
  const turnPrompt = options.turnPrompt ?? ASK_ORACLE_TURN_PROMPT;
  const liveTimeoutMs = options.liveTimeoutMs ?? DEFAULT_ASK_LIVE_TIMEOUT_MS;
  const controlBaseUrl = `http://${formatAuthority(server.address.host, server.address.port)}`;

  // Install the REAL #78 hook (#262) for THIS run, under a fresh token. A failure to install degrades to
  // a worker with no hook wired — the run then self-classifies `inconclusive` (no capture), never a fake
  // green — mirroring `launchSession`'s "the hook is enrichment, never the block itself" stance.
  let hookInstall: HookInstall | undefined;
  try {
    hookInstall = installAskUserQuestionHookSettings(randomUUID(), options.hookStateDir);
  } catch {
    hookInstall = undefined;
  }

  let reachedIdle = false;
  let reachedRequiresAction = false;
  let worker: PatchedWorkerHandle | undefined;
  try {
    // §1/§2/§3 — the bridge legs, PLUMBING here (not the leg under test — that is #133's oracle): get a
    // `bypassPermissions` session + its ingress token to hand the worker. The session MUST be created
    // with `bypassPermissions` so the server derives the same `autoResolvesPermissions` a real headless
    // worker would (`environments-bridge.ts`), and so the session genuinely IS the mode #266 observes.
    const { environmentId } = await registerEnvironment(server, bearer);
    const { sessionId } = await createSession(server, bearer, undefined, ASK_ORACLE_PERMISSION_MODE);
    const delivered = await pollWork(server, environmentId);

    worker = await launcher({
      sdkUrl: config.sdkUrl,
      apiKey: config.apiKey,
      controlBaseUrl,
      sessionId,
      sessionIngressToken: delivered.secret.session_ingress_token,
      hookSettingsPath: hookInstall?.settingsPath,
      permissionMode: ASK_ORACLE_PERMISSION_MODE,
    });

    // Wait for the REAL worker to open the §4/§5 channel AND report idle — both read from the server's
    // OWN state (a held-open downstream exists; the activity it DERIVED is `idle`), never a self-report.
    // Gating `idle` on `hasLiveWorker` is load-bearing: a bare session carries a creation-default `idle`
    // with NO worker (the same distinction `driveLiveWorkerOracle` documents).
    reachedIdle = await waitForReceiver(
      () => server.hasLiveWorker(sessionId) && server.sessions.get(sessionId)?.activity.kind === "idle",
      liveTimeoutMs,
    );

    if (reachedIdle) {
      // Drive exactly one turn instructing an `AskUserQuestion` call, then wait for the server to DERIVE
      // `requires_action` from the worker's §4/§5 status — the #266 surfacing, receiver-grounded. A
      // timeout (the worker never surfaced) leaves the flag false → the classifier reads the hook capture
      // to tell falsified-inference (drift) apart from never-asked (inconclusive).
      //
      // CAVEAT — the surfacing observation is WINDOW-BOUNDED by `liveTimeoutMs`. If the worker DID ask
      // (the hook fires) but the block surfaces only AFTER the budget, the flag stays false and the
      // classifier reports `drift`, not `inconclusive` — a false red in principle. This is deliberate, not
      // an oversight: the PreToolUse→native-block→§5 ordering is sub-second, the default budget is 120 s,
      // and a post-ask stall that long IS a real surfacing failure. Widening this to `inconclusive` would
      // MASK a genuinely broken-but-slow surfacing — the exact regression this gate exists to catch. A
      // real worker that legitimately needs longer is absorbed by raising `liveTimeoutMs` — the knob moves,
      // the verdict's meaning does not.
      server.injectTurn(sessionId, turnPrompt);
      reachedRequiresAction = await waitForReceiver(
        () => server.sessions.get(sessionId)?.activity.kind === "requires_action",
        liveTimeoutMs,
      );
    }
  } catch {
    // A launch failure, a downstream that closed mid-drive, or an injection race leaves the flags false
    // so the run SELF-CLASSIFIES `inconclusive` — the oracle never throws out of the harness.
  } finally {
    if (worker !== undefined) {
      await worker.close();
    }
  }

  // Read the #78 hook's OWN capture — the structured options it pulled from the real `AskUserQuestion`
  // `tool_input`. Read AFTER the wait so a hook that fired during the turn is observed; the bridge
  // session has no `hookInstalls` entry, so the server never CONSUMES the handoff (`reconcileHookHandoff`
  // no-ops without an install), leaving it on disk for this receiver-grounded read. Cleaned up right
  // after, whether or not it was written.
  let hookCaptureBody: string | undefined;
  if (hookInstall !== undefined) {
    hookCaptureBody = readHookCapture(hookInstall.handoffPath);
    cleanupHookInstall(hookInstall);
  }

  return classifyAskSurfacing({ reachedIdle, reachedRequiresAction, hookCaptureBody });
}

/**
 * Read the #78 hook's handoff capture at `path`, or `undefined` when it was never written (the ordinary
 * case for a run where the worker did not invoke `AskUserQuestion`) or cannot be read. Best-effort and
 * silent: an absent capture is an `inconclusive` gap, never an error to raise.
 */
function readHookCapture(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
