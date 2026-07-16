// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fenced, self-classifying LAUNCH-A-SESSION-FROM-THE-PHONE-OVER-A-REAL-TAILSCALE-TUNNEL
 * oracle — UC2 exercised over a real tailnet (issue #66, traces E2E-B-001).
 *
 * UC1 (`multi-session-tunnel.ts`, #65) proves the phone can LIST / VIEW / STEER sessions that
 * already exist over a real tunnel. UC2 is the verb that BRINGS ONE INTO BEING from the phone:
 * the operator taps "New session" on a device that is nowhere near their desk, and a headful
 * terminal opens on their host. That launch request is the one leg no other oracle drives over a
 * tunnel — and it is the one that most needs to be driven there, because it is the only remotely
 * triggerable verb that SPAWNS something (`ui-session-launch.ts` § the `maxSessions` cap exists
 * for exactly that reason).
 *
 * The flow this drives, end to end, is the whole UC2 lifecycle (#31 / #33 / #37):
 *
 *   1. **Launch, from the phone, over the tunnel** — `POST {tunnel}/api/sessions` carrying the body
 *      the REAL browser module builds (`launchRequest`, `@ccctl/web-ui/src/launch.js`, #37, injected
 *      as a {@link LaunchRequestBuilder}), answered `201 { sessionId, attachable, hint }`. The daemon
 *      runs its injected {@link ISessionLauncher} and mints the session id.
 *   2. **Listed from birth, over the tunnel** — `GET {tunnel}/api/sessions` shows that id as
 *      `registering` BEFORE any worker has checked in (#33): its terminal is up, its worker is not.
 *   3. **The launched session REGISTERS** — the worker inside that terminal registers over the
 *      environments bridge (§2, on-box/loopback as in reality) carrying the cwd + permission mode it
 *      was launched under, which the daemon correlates back to the pending launch
 *      (`claimPendingLaunch`) and answers with THE LAUNCH'S OWN ID — so the row the operator is
 *      watching advances IN PLACE to `connecting` rather than a second row appearing beside it.
 *   4. **Viewable / steerable, over the tunnel** — the phone views that session's SSE transcript and
 *      steers it, both through the tunnel base.
 *
 * **Id continuity IS the proof of "the launched session registers"** (AC2), and it is worth stating
 * plainly because it is the single most load-bearing assertion here. The §2 leg is literally
 * `claimPendingLaunch(state, cwd, permissionMode) ?? randomUUID()` (`environments-bridge.ts`): a
 * claim that HITS answers the launched id, and a claim that MISSES silently answers a fresh one and
 * leaves the operator's `registering` row to be evicted as a ghost 10s later. Both are `201`s; both
 * produce a live, listable, steerable session. Nothing distinguishes them except WHICH id came back
 * — so an oracle that checked only "a session registered" would pass a daemon in which every
 * phone-launched session silently disowns its own launch row. This one reads the id.
 *
 * Three properties, exactly as the UC1 tunnel oracle and the credentialed live-worker oracle
 * (`live-worker-oracle.ts`, #133) hold them:
 *
 *   - **Fenced / opt-in.** {@link resolveTunnelE2EEnv} (REUSED from the UC1 oracle — the infra
 *     prerequisite is identical: one real, authenticated tailnet) gates the run on `CCCTL_E2E` +
 *     `CCCTL_E2E_TAILSCALE`. Absent → the caller SKIPS the suite (`describe.skipIf`); this oracle
 *     lives OUTSIDE the credential-free CI `e2e` lane and never runs — nor fails — there. The fence
 *     and the classifier LOGIC are proven credential-free in the `test` lane
 *     (`launch-tunnel.test.ts`), so the AC judgment gates EVERY CI run; only the transport is fenced.
 *   - **Self-classifying.** Every driven run yields exactly one {@link LaunchVerdict}: `verified`,
 *     `drift` (a contract violation was OBSERVED while the flow ran), or `inconclusive` (a required
 *     leg was never captured). {@link classifyLaunchFlow} is the pure decision.
 *   - **Skips-never-fakes.** When a real tailnet is absent the fence SKIPS; when a leg cannot be
 *     captured the drive self-classifies `inconclusive`. It NEVER substitutes a synthetic tunnel or a
 *     loopback stand-in to make an absent tailnet look green (the circular-fixture failure #131
 *     removed). A missing leg is `inconclusive`, never a fabricated pass.
 *
 * **What is real, what is a stand-in, and why** — the honest boundary, since it is what the reader
 * must be able to check rather than take on faith:
 *
 *   - **Real**: the tunnel (a real {@link TailscaleTunnel} → real `tailscale serve`), the whole
 *     `@ccctl/server` launch ingress + its pending-launch bookkeeping + the §2 claim correlation +
 *     the session registry + the SSE relay + the command path, and the phone's request body (the
 *     REAL `@ccctl/web-ui` `launchRequest`, not a re-transcription of it).
 *   - **Stand-in**: the {@link ISessionLauncher} backend ({@link createRecordingLauncher}) and the
 *     launched worker ({@link connectFakeWorker}). Both are INJECTED PORTS of the system under test,
 *     not stand-ins for the thing being asserted — the assertion is about the daemon's launch
 *     lifecycle over a tunnel, not about tmux. This is the same posture `web-ui-launch-flow.test.ts`
 *     takes on the launcher, and the same one the UC1 tunnel oracle takes on the worker.
 *   - **Why the launcher stays a stand-in**: the repo ships no packaged patched worker (see the
 *     package README § "What is fenced to the credentialed wave"), so a REAL launcher would open a
 *     real terminal running nothing that could ever register — turning AC2 into an unreachable
 *     `inconclusive` on every run. The real backend's own surface + FD-residual behavior is #68's
 *     job, and the tmux/pty backends are unit-proven in `@ccctl/server` besides.
 *   - **Why that is not circular**: the stand-ins are on the far side of ports the daemon calls OUT
 *     through; every fact this oracle reads back is the DAEMON's own (the 201 it minted, the list it
 *     serves, the id its §2 leg answered). #131's circular fixture was the opposite shape — a fake
 *     that answered the very question being asked.
 *
 * The launcher + worker legs stay on-box (loopback), exactly as in reality: the terminal spawns on
 * the operator's host and the patched worker inside it talks to the daemon over loopback. Only the
 * PHONE is off-box, and it holds ONLY the tunnel base — so a successful launch / list / view / steer
 * through it IS the proof that leg traversed the tunnel.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlEvent } from "@ccctl/core";
import type {
  CcctlServer,
  ISessionLauncher,
  LaunchedSession,
  SessionLaunchOptions,
  SurfaceLiveness,
} from "@ccctl/server";
import type { Tunnel } from "@ccctl/tunnel-adapters";
import { createSession, pollWork, registerEnvironment } from "./bridge-wire-conformance.js";
// REUSED from the UC1 tunnel oracle (#65) — the fence (identical infra prerequisite: one real
// tailnet), the reachable-base helpers, the list parsers, the receiver-grounded turn readers, and the
// over-tunnel phone transport. Re-declaring any of them here would be a second copy of a rule that is
// already pinned by `multi-session-tunnel.test.ts`.
import {
  connectTunnelPhone,
  hasPerSessionStatus,
  isTailnetHost,
  listSessionsOverTunnel,
  tunnelPhoneBaseUrl,
  userTurnSessionId,
  userTurnText,
} from "./multi-session-tunnel.js";
import { connectFakeWorker, waitFor, type FakeWorker, type UiClient } from "./one-session-harness.js";

// --- the launched session's birth status (pure) ---

/**
 * The status a launched session is listed under FROM BIRTH, before its worker checks in (#33) — its
 * terminal is up, so the session is real and visible, but it is not yet viewable or steerable. Named
 * rather than inlined because BOTH halves of AC2 turn on it: the born row must BE this, and the
 * post-registration row must no longer be.
 */
export const BORN_STATUS = "registering";

// --- launch-accepted parsing (pure) ---

/** The `POST /api/sessions` 201 body — WHICH session came up, and how to reach its surface. */
export interface LaunchAccepted {
  readonly sessionId: string;
  readonly attachable: boolean;
  readonly hint: string;
}

/**
 * Parse a `POST /api/sessions` 201 body into its {@link LaunchAccepted}, defensively. Throws on a
 * malformed body (not an object, or no non-empty string `sessionId`) so a broken launch answer cannot
 * masquerade as a launch that minted an id. Pure; unit-testable without a live server.
 *
 * Independent of the server's own `LaunchAcceptedWire` serializer, for the reason the golden pins
 * every other wire independently (`bridge-wire-conformance.ts`): a shape asserted with the producer's
 * own type is asserted against itself.
 */
export function parseLaunchAcceptedBody(body: unknown): LaunchAccepted {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("ccctl e2e: POST /api/sessions did not return an object body");
  }
  const { sessionId, attachable, hint } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("ccctl e2e: POST /api/sessions did not return a non-empty `sessionId`");
  }
  if (typeof attachable !== "boolean" || typeof hint !== "string") {
    throw new Error("ccctl e2e: POST /api/sessions did not return the `{ attachable, hint }` attachment");
  }
  return { sessionId, attachable, hint };
}

// --- launch intent (pure) ---

/**
 * WHAT a launch asked for — the comparable core of the phone's request and of what the daemon's
 * launcher was actually invoked with. AC1's "a New session request from the phone LAUNCHES a session"
 * is only true if the daemon launched THE PHONE'S request, so the two are compared field by field.
 */
export interface LaunchIntent {
  readonly cwd: string;
  readonly permissionMode: string;
  readonly project?: string | undefined;
  readonly initialPrompt?: string | undefined;
}

/**
 * Builds the "New session" request body the phone POSTs for a given (real, canonical) cwd.
 *
 * The e2e supplies the REAL browser module's builder (`launchRequest`, `@ccctl/web-ui/src/launch.js`,
 * #37) — the phone leg must be the phone's OWN code, never a re-transcription of it. A hand-written
 * body here would assert the ingress against this package's belief about `launch.js` rather than
 * against `launch.js`, which is the exact tautology `web-ui-launch-flow.test.ts` exists to avoid.
 *
 * INJECTED rather than imported because `@ccctl/web-ui` is dependency-free plain JS that ships no type
 * declarations, and this module is typechecked source. Every other web-ui call site in this package
 * lives in a `*.test.ts`, which `tsconfig.json` excludes from `typecheck` — so the real module stays in
 * the driver's hands (where it resolves as `any`, exactly as at its sibling call sites) and this module
 * does not claim a dependency it cannot type. Returns `unknown` because that is honestly what an
 * untyped builder yields; {@link parseLaunchIntent} reads it back defensively.
 */
export type LaunchRequestBuilder = (cwd: string) => unknown;

/**
 * Read a launch-request body — the ACTUAL bytes the phone is about to POST — back into its comparable
 * {@link LaunchIntent}, or `null` when it is not a well-formed request (no object, no non-empty string
 * `cwd` / `permissionMode`, or a non-string optional).
 *
 * Reading the intent off the POSTed body rather than off what the caller MEANT to ask for is what
 * makes AC1's comparison honest: both sides of it are then observations — what actually went over the
 * tunnel, and what the daemon's launcher actually received — rather than one observation against an
 * assumption. Pure; unit-testable.
 */
export function parseLaunchIntent(body: unknown): LaunchIntent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { cwd, permissionMode, project, initialPrompt } = body as Record<string, unknown>;
  if (typeof cwd !== "string" || cwd === "" || typeof permissionMode !== "string" || permissionMode === "") {
    return null;
  }
  if (project !== undefined && typeof project !== "string") {
    return null;
  }
  if (initialPrompt !== undefined && typeof initialPrompt !== "string") {
    return null;
  }
  return {
    cwd,
    permissionMode,
    ...(project !== undefined ? { project } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
  };
}

/**
 * Whether two launch intents are the same request. An omitted optional and one explicitly set to
 * `undefined` compare alike, because both read `undefined` on access — so a plain `===` per field is
 * the whole comparison (the ingress OMITS blank optionals rather than setting them empty —
 * `exactOptionalPropertyTypes`). Pure; unit-testable.
 *
 * `cwd` is compared EXACTLY, which is only sound because the drive launches at an ALREADY-CANONICAL
 * directory ({@link driveLaunchTunnelFlow}): the ingress roots the terminal at the RESOLVED path
 * (`resolveLaunchCwd`), so launching at a raw `/tmp/x` would hand the launcher `/private/tmp/x` on
 * macOS and this comparison would read a faithful daemon as drift. Canonicalizing the INPUT removes
 * that whole class of false positive instead of teaching the oracle to forgive a mismatch — which
 * would also forgive a real one.
 */
export function sameLaunchIntent(a: LaunchIntent, b: LaunchIntent): boolean {
  return (
    a.cwd === b.cwd &&
    a.permissionMode === b.permissionMode &&
    a.project === b.project &&
    a.initialPrompt === b.initialPrompt
  );
}

/** A one-line rendering of a launch intent — used in `drift` violation prose. */
export function describeLaunchIntent(intent: LaunchIntent): string {
  const optionals = [
    `mode=${intent.permissionMode}`,
    ...(intent.project !== undefined ? [`project=${intent.project}`] : []),
    ...(intent.initialPrompt !== undefined ? [`prompt=${intent.initialPrompt}`] : []),
  ];
  return `${intent.cwd} (${optionals.join(", ")})`;
}

// --- classification (pure) ---

/** The self-classifying verdict of one driven real-tunnel UC2 run. */
export type LaunchVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const LAUNCH_CHECK = {
  tunnel: "tunnel-up (AC3)",
  publicSurface: "no-public-surface (AC3)",
  launch: "phone-launch-over-tunnel (AC1)",
  launcherIntent: "launcher-ran-the-phones-request (AC1)",
  birth: "listed-from-birth-over-tunnel (AC2)",
  registration: "launched-session-registers (AC2)",
  steer: "phone-steer-over-tunnel (AC2)",
  view: "phone-view-over-tunnel (AC2)",
} as const;

/**
 * The receiver-grounded observation of ONE driven UC2 run, fed to {@link classifyLaunchFlow}.
 *
 * Every field is read from the endpoint that took the traffic — the tunnel's own status, the daemon's
 * own 201 / list / §2 answer, its launcher's own invocation record, the worker's own inbound frames,
 * the phone's own over-tunnel SSE log — never a sender's self-report. Fields that gate an
 * `inconclusive` "never captured" verdict are `undefined` when the leg was never reached, so a missing
 * leg is a gap rather than a silent `false`.
 */
export interface LaunchTunnelCapture {
  /** The real tunnel established AND `status()` reported it up (with a reachable public host). */
  readonly tunnelUp: boolean;
  /** The reachable base host the phone dialed, or `undefined` if the tunnel never came up. */
  readonly publicHost?: string | undefined;
  /**
   * The reachable base was a PUBLIC host (not tailnet-scoped) — a definitive AC3 violation.
   * `undefined` when the tunnel never came up (no base to judge — that is the `inconclusive`
   * tunnel-down gap, not a public-surface drift).
   */
  readonly publicSurface?: boolean | undefined;
  /** The id the phone's OVER-TUNNEL launch minted (the daemon's own 201), or `undefined` if it never landed. */
  readonly launchedSessionId?: string | undefined;
  /** What the phone ASKED to launch — the REAL `launchRequest` body it POSTed over the tunnel. */
  readonly requestedLaunch?: LaunchIntent | undefined;
  /** What the DAEMON'S OWN launcher was invoked with (receiver-grounded), or `undefined` if it never ran. */
  readonly launcherInvokedWith?: LaunchIntent | undefined;
  /** The phone read a born list over the tunnel at all (BEFORE any worker registered). */
  readonly bornListed: boolean;
  /** The launched id's status in that born list, or `undefined` when the row was ABSENT from it. */
  readonly bornStatus?: string | undefined;
  /** The born row carried a usable per-session status (non-empty `status` + `activity.kind`). */
  readonly bornStatusOk: boolean;
  /** The id the launched worker's §2 registration answered — the claim's own receipt. */
  readonly registeredSessionId?: string | undefined;
  /** The ids the phone listed OVER THE TUNNEL after the registration, or `undefined` if never read. */
  readonly registeredListedIds?: readonly string[] | undefined;
  /** The launched id's status after its worker registered, or `undefined` when the row was absent. */
  readonly registeredStatus?: string | undefined;
  /**
   * The phone's steer reached the launched session's OWN worker, carrying its own text + session id
   * (receiver-grounded). `undefined` when the steer leg was never observed over the tunnel.
   */
  readonly steered?: boolean | undefined;
  /**
   * The phone viewed the launched session's OWN transcript, exact relayed bytes (receiver-grounded).
   * `undefined` when the view leg was never observed over the tunnel.
   */
  readonly viewed?: boolean | undefined;
}

/** The classified report of one driven run: the verdict, the named violations, and a human reason. */
export interface LaunchReport {
  readonly verdict: LaunchVerdict;
  /** The checks whose observed behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation: what verified, what drifted, or what was never captured. */
  readonly reason: string;
}

/**
 * Classify one {@link LaunchTunnelCapture} into a {@link LaunchReport} — the pure heart of the
 * oracle, unit-testable without a tailnet, and the Tier-A encoding of UC2's three ACs.
 *
 * Precedence is deliberate and mirrors the UC1 tunnel oracle: an OBSERVED contract violation is a
 * definitive `drift` (the flow ran and behaved wrong — the signal the oracle exists to raise), so it
 * OUTRANKS a missing capture. Only when nothing drifted does an absent leg become `inconclusive`
 * (couldn't capture — no signal, never faked green):
 *
 *   1. **drift** — a PUBLIC reachable base; a daemon that launched something other than what the
 *      phone asked for; a launch the over-tunnel list never showed from birth, or showed under the
 *      wrong status; a registration that MINTED A FRESH ID instead of claiming the launch (the row
 *      the operator is watching is not the session that came up); a second row beside the launched
 *      one; or a row still `registering` after its own worker registered. Every violated check is named.
 *   2. **inconclusive** — no drift, but a required leg was never observed: no tunnel; the phone never
 *      launched, or what it asked to launch was never captured; the launcher never ran; the phone
 *      never listed from birth; the worker never registered, the phone never re-listed after that
 *      registration, or the launched row's status was never read back; or the steer / view leg was
 *      never captured. The gaps are named. BOTH sides of every comparison gate — a check that fires
 *      only when both sides are defined leaves an unobserved side falling through to `verified`.
 *   3. **verified** — the tunnel came up tailnet-scoped; the phone launched over it and the daemon
 *      ran exactly that request; the launched session was listed from birth as `registering` with a
 *      usable per-session status; its worker's registration CLAIMED it (same id, row advanced, no
 *      second row); and the phone viewed + steered it over the tunnel.
 */
export function classifyLaunchFlow(capture: LaunchTunnelCapture): LaunchReport {
  // 1. Drift — observed contract violations. Checked FIRST so a present-but-wrong leg is never
  //    masked by a downstream inconclusive gap.
  const violations: string[] = [];

  if (capture.publicSurface === true) {
    violations.push(
      `${LAUNCH_CHECK.publicSurface}: the reachable base ${capture.publicHost ?? "?"} is a PUBLIC host, not a tailnet one`,
    );
  }

  // AC1 — the daemon must launch THE PHONE'S request. A launch that dropped the operator's prompt or
  // rooted the terminal somewhere else is a launch, but not the one that was asked for.
  if (
    capture.requestedLaunch !== undefined &&
    capture.launcherInvokedWith !== undefined &&
    !sameLaunchIntent(capture.requestedLaunch, capture.launcherInvokedWith)
  ) {
    violations.push(
      `${LAUNCH_CHECK.launcherIntent}: the daemon launched ${describeLaunchIntent(capture.launcherInvokedWith)}, but the phone asked over the tunnel for ${describeLaunchIntent(capture.requestedLaunch)}`,
    );
  }

  // AC2 — "appears in the list from birth". A launch that 201'd but is absent from a list the phone
  // DID read is a definitive violation (an empty/unread list is the inconclusive gap below instead).
  if (capture.launchedSessionId !== undefined && capture.bornListed && capture.bornStatus === undefined) {
    violations.push(
      `${LAUNCH_CHECK.birth}: the phone launched ${capture.launchedSessionId} over the tunnel but the list did not show it from birth`,
    );
  }
  // …and it must be born `registering` (#33): its terminal is up, its worker has not checked in.
  if (capture.bornStatus !== undefined && capture.bornStatus !== BORN_STATUS) {
    violations.push(
      `${LAUNCH_CHECK.birth}: the launched session was listed from birth as \`${capture.bornStatus}\`, expected \`${BORN_STATUS}\``,
    );
  }

  // AC2 — "the launched session registers". THE load-bearing check: a claim that missed answers a
  // FRESH id, which is a `201` and a live session either way — only the id tells the two apart.
  if (
    capture.launchedSessionId !== undefined &&
    capture.registeredSessionId !== undefined &&
    capture.registeredSessionId !== capture.launchedSessionId
  ) {
    violations.push(
      `${LAUNCH_CHECK.registration}: the launched worker's registration minted ${capture.registeredSessionId}, but the phone launched ${capture.launchedSessionId} — the launch was never claimed, so the operator's row is not the session that came up`,
    );
  }
  // …independently confirmed from the PHONE's own over-tunnel view: an unclaimed launch leaves its
  // ghost row beside the freshly-minted one, so the list carries two ids where UC2 has exactly one —
  // hence the invariant is stated as an exact identity (one row, and it is the launched one) rather
  // than as a set comparison: any other cardinality is already the violation.
  // Deliberately NOT guarded on a non-empty list: a list the phone DID read and found EMPTY is a
  // definitive violation (the launched session must be in it), not a gap — a check that passes on a
  // cardinality-zero subject is not evidence. `undefined` (never read) IS the gap, and is caught below.
  if (
    capture.registeredListedIds !== undefined &&
    capture.launchedSessionId !== undefined &&
    (capture.registeredListedIds.length !== 1 || capture.registeredListedIds[0] !== capture.launchedSessionId)
  ) {
    violations.push(
      `${LAUNCH_CHECK.registration}: after its worker registered the phone listed [${[...capture.registeredListedIds].sort().join(", ")}] over the tunnel, expected only the launched ${capture.launchedSessionId}`,
    );
  }
  // …and the row must ADVANCE: a session still `registering` after its own worker checked in is one
  // whose claim missed — its eviction timer is still armed, and it will be reaped as a ghost.
  if (capture.registeredSessionId !== undefined && capture.registeredStatus === BORN_STATUS) {
    violations.push(
      `${LAUNCH_CHECK.registration}: the launched session is still \`${BORN_STATUS}\` after its own worker registered — the row never advanced`,
    );
  }

  if (violations.length > 0) {
    return {
      verdict: "drift",
      violations,
      reason: `the flow ran but violated ${violations.length} check(s) over the tunnel: ${violations.join("; ")}`,
    };
  }

  // 2. Inconclusive — nothing drifted, but a required observation is missing.
  const gaps: string[] = [];
  if (!capture.tunnelUp) {
    gaps.push(`${LAUNCH_CHECK.tunnel}: no real tunnel came up`);
  }
  if (capture.launchedSessionId === undefined) {
    gaps.push(`${LAUNCH_CHECK.launch}: the phone never launched a session over the tunnel`);
  }
  // BOTH sides of the AC1 comparison are gaps in their own right. The drift check above fires only
  // when both are defined, so an unobserved side must be caught HERE or it falls through to
  // `verified` — a green asserting the daemon launched the phone's request while nothing was ever
  // compared to anything.
  if (capture.requestedLaunch === undefined) {
    gaps.push(`${LAUNCH_CHECK.launch}: what the phone asked to launch was never captured`);
  }
  if (capture.launcherInvokedWith === undefined) {
    gaps.push(`${LAUNCH_CHECK.launcherIntent}: the daemon's launcher never ran`);
  }
  if (!capture.bornListed) {
    gaps.push(`${LAUNCH_CHECK.birth}: the phone never listed over the tunnel from birth`);
  }
  if (capture.registeredSessionId === undefined) {
    gaps.push(`${LAUNCH_CHECK.registration}: the launched session's worker never registered`);
  }
  if (capture.registeredListedIds === undefined) {
    gaps.push(`${LAUNCH_CHECK.registration}: the phone never listed over the tunnel after the registration`);
  }
  if (capture.registeredStatus === undefined) {
    gaps.push(`${LAUNCH_CHECK.registration}: the launched session's status was never read back over the tunnel`);
  }
  if (capture.steered === undefined) {
    gaps.push(`${LAUNCH_CHECK.steer}: the steer leg was never observed over the tunnel`);
  }
  if (capture.viewed === undefined) {
    gaps.push(`${LAUNCH_CHECK.view}: the view leg was never observed over the tunnel`);
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not capture the full UC2 flow over a real tunnel: ${gaps.join("; ")}`,
    };
  }

  // 3. Verified — every leg observed and conformant. The remaining booleans are gated (a `false`
  //    here, not `undefined`, would be a captured-but-wrong observation) — guard them so a stray
  //    `false` never reads as verified.
  if (capture.bornStatusOk && capture.steered === true && capture.viewed === true && capture.publicSurface === false) {
    return {
      verdict: "verified",
      violations: [],
      reason: `the phone launched ${capture.launchedSessionId ?? "?"} over the tunnel (base ${capture.publicHost ?? "?"}); it was listed from birth as \`${BORN_STATUS}\`, its worker's registration claimed it (same id, now \`${capture.registeredStatus ?? "?"}\`), and the phone viewed + steered it over the tunnel`,
    };
  }

  // A captured-but-not-conformant residue (e.g. a born row missing its per-session status): treat as
  // inconclusive rather than a false green — the observation was incomplete, not proven.
  const residue: string[] = [];
  if (!capture.bornStatusOk) {
    residue.push(`${LAUNCH_CHECK.birth}: the born row was missing its per-session status`);
  }
  if (capture.steered !== true) {
    residue.push(`${LAUNCH_CHECK.steer}: the over-tunnel steer was not positively confirmed`);
  }
  if (capture.viewed !== true) {
    residue.push(`${LAUNCH_CHECK.view}: the over-tunnel view was not positively confirmed`);
  }
  if (capture.publicSurface !== false) {
    residue.push(`${LAUNCH_CHECK.publicSurface}: the reachable base was never confirmed tailnet-scoped`);
  }
  return {
    verdict: "inconclusive",
    violations: [],
    reason: `the flow was captured but not positively confirmed: ${residue.join("; ")}`,
  };
}

// --- the recording launcher stand-in (impure) ---

/** A stand-in launcher plus the receiver-grounded record of what the DAEMON invoked it with. */
export interface RecordingLauncher {
  /** The port to inject at `startServer({ launcher })`. */
  readonly launcher: ISessionLauncher;
  /** Every launch the daemon actually ran, in order — the AC1 receiver-grounded read. */
  launched(): readonly SessionLaunchOptions[];
}

/**
 * A stand-in {@link ISessionLauncher} that RECORDS what it was asked to launch and answers a tagged,
 * attachable handle — the injected backend for the fenced UC2 drive.
 *
 * It is a stand-in for the TERMINAL BACKEND only, and the distinction is the whole honesty argument
 * (see this module's header): the daemon's launch ingress, its pending-launch bookkeeping, its §2
 * claim correlation and its registry are all REAL here. What this replaces is the thing on the far
 * side of a port the daemon calls OUT through — and it must be replaced, because the repo ships no
 * packaged patched worker, so a real tmux window would run nothing that could ever register and AC2
 * would be unreachable on every run.
 *
 * Its `launched()` record is what makes AC1 receiver-grounded rather than a self-report: the phone
 * POSTing a body proves the phone sent it; the DAEMON'S OWN launcher receiving those options proves
 * the launch request crossed the tunnel and drove a launch.
 *
 * `liveness` answers `alive-server-owned` so the daemon's own teardown (`releaseLaunchedSession`,
 * #35) treats the surface as still its own and closes it — the same path a real backend takes.
 */
export function createRecordingLauncher(): RecordingLauncher {
  const launches: SessionLaunchOptions[] = [];
  const launcher: ISessionLauncher = {
    // Not `async`: nothing here awaits, and the port is satisfied by the promise itself. A real
    // backend shells out to tmux or forks a pty; this one only records.
    launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launches.push(options);
      return Promise.resolve({
        attachment: { attachable: true, hint: "tmux attach -t ccctl:e2e-uc2" },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
        close: (): Promise<void> => Promise.resolve(),
      });
    },
  };
  return { launcher, launched: (): readonly SessionLaunchOptions[] => launches };
}

// --- drive (impure, fenced) ---

/** How long an over-tunnel HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The registration window the fenced UC2 e2e must run its server with — deliberately far above the
 * daemon's 10s default (`DEFAULT_REGISTRATION_TIMEOUT_MS`).
 *
 * The default is a PRODUCT decision about how long a launched session may sit `registering` before it
 * is reaped as a ghost, and it is exactly right there. It is wrong for THIS oracle, because the drive
 * must launch, read a born list, and register a worker — with two HTTPS round-trips over a real
 * tailnet in between — before the timer fires. A slow tunnel would evict the pending launch mid-flow,
 * the §2 claim would then miss, and the classifier would read a perfectly faithful daemon as
 * `drift`: a FALSE RED manufactured by infra latency, which is the mirror image of the fabricated
 * green this oracle's whole posture exists to refuse.
 *
 * Raising it weakens no AC — the eviction window is #33's contract, unit-proven in
 * `pending-launch.test.ts`, and nothing about UC2's ACs concerns how long a ghost lingers. Exported so
 * the e2e names the coupling rather than re-hardcoding a number whose reason lives here.
 */
export const LAUNCH_REGISTRATION_TIMEOUT_MS = 120_000;

/**
 * The prompt the phone seeds its launch with — distinct text, so a dropped or mangled optional is
 * visible as an AC1 intent mismatch rather than passing unnoticed. Exported because the e2e builds the
 * request with the REAL browser module ({@link LaunchRequestBuilder}) and must seed it with this.
 */
export const LAUNCH_INITIAL_PROMPT = "ccctl e2e: seed prompt from the phone over the tunnel";

/** The project the phone names in its launch — as above, a distinct optional the daemon must carry through. */
export const LAUNCH_PROJECT = "ccctl-e2e-uc2";

/** The distinct steer text the phone sends — so a mis-delivered steer is detectable by content. */
const STEER_TEXT = "steer-the-launched-session";

/** The distinct transcript the launched worker emits — so a mis-viewed transcript is detectable by content. */
const TRANSCRIPT_EVENT: ControlEvent = {
  type: "control_event",
  subtype: "message",
  payload: { text: "transcript-from-the-launched-session" },
};

/** Inputs to drive the UC2-launch-over-a-real-tunnel flow. */
export interface LaunchTunnelFlowOptions {
  /** The real local ccctl server the flow runs against — MUST be configured with `recorder.launcher`. */
  readonly server: CcctlServer;
  /** The tunnel to expose the server through — a real {@link TailscaleTunnel} in the e2e, injectable for the fence's sake. */
  readonly tunnel: Tunnel;
  /** The account Bearer presented on the §1/§2 control POSTs ONLY (never the §3 poll, never the phone legs). */
  readonly bearer: string;
  /** The recording launcher injected into `server` — its record is the AC1 receiver-grounded read. */
  readonly recorder: RecordingLauncher;
  /**
   * Builds the phone's "New session" body for the drive's freshly-minted cwd — the e2e passes the REAL
   * `@ccctl/web-ui` `launchRequest`. See {@link LaunchRequestBuilder} for why it is injected.
   */
  readonly buildLaunchRequest: LaunchRequestBuilder;
}

/**
 * Drive UC2 over a REAL tunnel and self-classify — NEVER throwing on a divergence or a missing leg
 * (it returns a {@link LaunchReport}).
 *
 * Establishes the tunnel, then: the phone LAUNCHES over it (the real `launchRequest` body), reads the
 * born list over it, the launched worker registers on-box over the bridge (§1→§2→§3, as in reality),
 * and the phone re-lists / views / steers the launched session over the tunnel. Every hop is
 * receiver-grounded. A setup / transport failure (no tailnet, an unreachable base) is captured as
 * `inconclusive`; an observed contract violation as `drift`; a clean run as `verified`. Always tears
 * the tunnel, the stand-ins and the temp directory down before returning, so a serial e2e run never
 * leaks a socket, a serve mapping or a directory.
 *
 * The launch cwd is a FRESH, CANONICAL temp directory, and both properties are load-bearing:
 *
 *   - **Real + canonical**, because the ingress refuses a non-existent path (`invalid-cwd`) before any
 *     backend runs, and roots the terminal at the RESOLVED path — so a raw path would make the daemon's
 *     faithful `/private/var/...` read as an AC1 intent mismatch (see {@link sameLaunchIntent}).
 *   - **Fresh**, because the §2 claim key is `(cwd, permissionMode)`: a second pending launch on the
 *     same pair would mark the group AMBIGUOUS and the daemon would then — correctly — refuse to lend
 *     the launch its id (`pending-launch.ts` § Correlation), which this oracle would read as a claim
 *     miss. A directory nothing else has launched in keeps the key decisive, so the run measures UC2
 *     rather than the ambiguity rule.
 */
export async function driveLaunchTunnelFlow(options: LaunchTunnelFlowOptions): Promise<LaunchReport> {
  const { server, tunnel, bearer, recorder, buildLaunchRequest } = options;
  let tunnelUp = false;
  let publicHost: string | undefined;
  let publicSurface: boolean | undefined;
  let launchedSessionId: string | undefined;
  let requestedLaunch: LaunchIntent | undefined;
  let launcherInvokedWith: LaunchIntent | undefined;
  let bornListed = false;
  let bornStatus: string | undefined;
  let bornStatusOk = false;
  let registeredSessionId: string | undefined;
  let registeredListedIds: readonly string[] | undefined;
  let registeredStatus: string | undefined;
  let steered: boolean | undefined;
  let viewed: boolean | undefined;

  let cwd: string | undefined;
  let worker: FakeWorker | undefined;
  let phone: UiClient | undefined;

  try {
    // 0. A fresh, canonical directory for this launch — see the doc comment above for why both.
    //    Canonicalized through `realpathSync.native` SPECIFICALLY: it is the very call both sides of
    //    the daemon's claim key go through (`pending-launch.ts` § canonicalCwd / resolveLaunchCwd),
    //    and it is not interchangeable with the JS `realpath` — the native one goes through
    //    `realpath(3)` and normalizes CASE, which on a case-insensitive disk is the difference
    //    between a key that matches and one that silently never does. `fs/promises` ships no
    //    `.native` variant, hence the sync call; it runs once per drive, on a path just created.
    cwd = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-e2e-uc2-")));

    // 1. Establish the real tunnel and read its status — the reachable base the phone dials.
    const established = await tunnel.establish(server.address);
    const status = await tunnel.status();
    if (status.up) {
      tunnelUp = true;
      publicHost = status.publicHost;
      // The reachable base MUST be tailnet-scoped — the receiver-grounded "no public IP" AC.
      publicSurface = !isTailnetHost(status.publicHost);
    }

    // Only proceed with the over-tunnel legs once the tunnel is genuinely up on a base to dial.
    if (tunnelUp && publicHost !== undefined) {
      const base = tunnelPhoneBaseUrl(established);

      // 2. LAUNCH from the phone, OVER THE TUNNEL (AC1) — the body is the REAL browser module's.
      //    The intent is read back off the bytes actually POSTed, so BOTH sides of the AC1
      //    comparison are observations rather than one observation against an assumption.
      const request = buildLaunchRequest(cwd);
      requestedLaunch = parseLaunchIntent(request) ?? undefined;
      if (requestedLaunch === undefined) {
        throw new Error("ccctl e2e: the phone's launch-request builder produced no well-formed body");
      }
      const accepted = await launchOverTunnel(base, request);
      launchedSessionId = accepted.sessionId;
      // Receiver-grounded AC1: the DAEMON'S OWN launcher ran, and with the phone's own options.
      launcherInvokedWith = firstLaunchIntent(recorder);

      // 3. LISTED FROM BIRTH, over the tunnel (AC2) — read BEFORE any worker registers, so the
      //    `registering` birth status is deterministic rather than a race against a claim.
      const bornList = await listSessionsOverTunnel(base);
      bornListed = true;
      const bornEntry = bornList.find((entry) => entry.id === launchedSessionId);
      bornStatus = bornEntry?.status;
      bornStatusOk = bornEntry !== undefined && hasPerSessionStatus(bornEntry);

      // 4. The launched session's worker REGISTERS (AC2) — on-box over loopback, exactly as in
      //    reality (the patched worker runs in the terminal the daemon just spawned, beside it).
      //    It registers at the cwd it was LAUNCHED at, which is what the daemon correlates its
      //    pending launch on; the id it gets back is the claim's own receipt.
      const { environmentId } = await registerEnvironment(server, bearer);
      const created = await createSession(server, bearer, cwd);
      registeredSessionId = created.sessionId;
      const delivered = await pollWork(server, environmentId);
      if (delivered.item.data.type !== "session" || delivered.item.data.id !== registeredSessionId) {
        throw new Error(`ccctl e2e: §3 poll did not deliver the session-dispatch item for ${registeredSessionId}`);
      }
      worker = await connectFakeWorker({ server, sessionId: registeredSessionId });
      await worker.putStatus("idle");

      // 5. The launched row ADVANCED, read back over the tunnel (AC2) — the phone's own view of the
      //    row it created: same id, no longer `registering`, and no second row beside it.
      const registeredList = await listSessionsOverTunnel(base);
      registeredListedIds = registeredList.map((entry) => entry.id);
      registeredStatus = registeredList.find((entry) => entry.id === launchedSessionId)?.status;

      // 6. VIEWABLE + STEERABLE over the tunnel (AC2) — the phone drives the session it launched.
      phone = await connectTunnelPhone(base, launchedSessionId);
      const ack = await phone.steer({ subtype: "prompt", payload: { text: STEER_TEXT } });
      if (ack.status !== 202) {
        throw new Error(`ccctl e2e: over-tunnel steer of the launched session expected 202, got ${ack.status}`);
      }
      await waitFor(() => (worker?.received().length ?? 0) >= 1);
      steered = assessSteer(worker, launchedSessionId);

      await worker.emitEvent(TRANSCRIPT_EVENT);
      await waitFor(() => (phone?.viewed().length ?? 0) >= 1);
      viewed = assessView(phone);
    }
  } catch {
    // A setup / transport failure leaves whatever was captured intact; the classifier turns the gaps
    // into `inconclusive`. NEVER a fabricated green — the missing legs stay missing.
  } finally {
    await phone?.close();
    await worker?.close();
    // Always release the serve mapping, even on a mid-flow failure.
    await tunnel.teardown().catch(() => {});
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  return classifyLaunchFlow({
    tunnelUp,
    publicHost,
    publicSurface,
    launchedSessionId,
    requestedLaunch,
    launcherInvokedWith,
    bornListed,
    bornStatus,
    bornStatusOk,
    registeredSessionId,
    registeredListedIds,
    registeredStatus,
    steered,
    viewed,
  });
}

/** Project a launch request body (or the daemon's own launch options) onto its comparable intent. */
function toLaunchIntent(options: SessionLaunchOptions): LaunchIntent {
  return {
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
  };
}

/**
 * The intent the daemon's launcher was invoked with on its FIRST (and, for this flow, only) launch,
 * or `undefined` when it never ran — the `inconclusive` gap. A run that somehow launched more than
 * once is not silently reduced to its first: the extra launches are a divergence the intent
 * comparison would miss, so they read as `undefined` (never captured a single unambiguous launch)
 * rather than as a confirmation.
 */
function firstLaunchIntent(recorder: RecordingLauncher): LaunchIntent | undefined {
  const launches = recorder.launched();
  const first = launches[0];
  return launches.length === 1 && first !== undefined ? toLaunchIntent(first) : undefined;
}

/**
 * Assess the steer, receiver-grounded: the launched session's worker received EXACTLY one frame,
 * carrying ITS OWN session id and the phone's OWN steer text. `false` on any missing / extra /
 * mis-addressed delivery.
 */
function assessSteer(worker: FakeWorker | undefined, sessionId: string): boolean {
  const frames = worker?.received() ?? [];
  const frame = frames[0];
  if (frames.length !== 1 || frame === undefined) {
    return false;
  }
  return userTurnSessionId(frame.payload) === sessionId && userTurnText(frame.payload) === STEER_TEXT;
}

/**
 * Assess the view, receiver-grounded: the phone viewed EXACTLY one transcript and its relayed SSE
 * bytes EXACTLY equal the launched worker's emitted event (the server relays `JSON.stringify(event)`).
 * Exact-bytes match proves the phone saw its own session's transcript without depending on the
 * untyped UI decode.
 */
function assessView(phone: UiClient | undefined): boolean {
  const views = phone?.viewed() ?? [];
  const view = views[0];
  if (views.length !== 1 || view === undefined) {
    return false;
  }
  return view.data === JSON.stringify(TRANSCRIPT_EVENT);
}

/**
 * POST one "New session" launch OVER THE TUNNEL and read the daemon's `201` {@link LaunchAccepted}.
 * Throws on any non-201, so a refused launch never masquerades as one that minted an id — the drive
 * catches it and the classifier reads the absent id as the `inconclusive` launch gap.
 */
export async function launchOverTunnel(base: string, request: unknown): Promise<LaunchAccepted> {
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 201) {
    throw new Error(`ccctl e2e: over-tunnel POST /api/sessions expected 201, got ${res.status}`);
  }
  return parseLaunchAcceptedBody(await res.json());
}
