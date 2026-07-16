// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fenced, self-classifying FULL-FLOW RELEASE GATE — the AC-5 inference-untouched
 * guarantee re-verified inside the release-blocking end-to-end run (issue #67, traces
 * E2E-B-002).
 *
 * The hermetic skeleton (`inference-untouched.e2e.test.ts`, #18) proves the guarantee for
 * ONE session, over loopback, in isolation. That is necessary but not sufficient: the claim a
 * release actually needs is that the split holds in the flow a real operator runs — several
 * concurrent sessions plus one launched from the phone, all multiplexed through one daemon,
 * over a real tunnel. A per-session leak is exactly what the one-session slice cannot see, and
 * exactly what an AGGREGATE claim hides: one session quietly proxied through the local control
 * plane still leaves the aggregate "did inference reach Anthropic?" answering yes, because its
 * siblings' honest traffic answers for it. This gate composes UC1 (#65) and UC2 (#66) into ONE
 * flow and asserts the guarantee ACROSS EVERY SESSION IN IT.
 *
 * **Scope — this gate judges the inference split, not UC1/UC2.** #67's ACs are the three
 * inference ones; the correctness of the multi-session and launch legs themselves belongs to
 * their own oracles (`multi-session-tunnel.ts` #65, `launch-tunnel.ts` #66), which pin them
 * with their own classifiers. Here those legs are the CONTEXT the assertion must run in: this
 * gate carries them, and reads their materialization only as a precondition — if the flow
 * never came up, there is nothing to judge (`inconclusive`), not a UC1 failure to re-report.
 * Re-classifying them here would be a second, drifting copy of a judgment already pinned.
 *
 * The three properties every oracle in this package holds, held here too:
 *
 *   - **Fenced / opt-in.** {@link resolveTunnelE2EEnv} (REUSED from #65 — the infra
 *     prerequisite is the same single real tailnet) gates the run on `CCCTL_E2E` +
 *     `CCCTL_E2E_TAILSCALE`. Absent → the caller SKIPS the suite. The JUDGMENT — the classifier
 *     and the per-session assertion — is unit-tested credential-free in the `test` lane
 *     (`full-flow-gate.test.ts`), so what is fenced is the TRANSPORT, not the verdict.
 *   - **Self-classifying.** Every driven run yields exactly one {@link FullFlowVerdict}:
 *     `verified`, `drift` (a violation was OBSERVED — the run FAILS, naming the check), or
 *     `inconclusive` (a leg was never captured — runtime-skip, never a fabricated green).
 *     Drift OUTRANKS an inconclusive gap, so a present-but-wrong leg is never masked.
 *   - **Receiver-grounded.** Every "session X's inference reached api.anthropic.com" is read
 *     from the stand-in's OWN log (the marker it recorded), never from the sender's variable —
 *     the oracle-independence property `docs/security-posture.md` names as do-not-weaken. The
 *     negative reads are self-guarded by the liveness canary (#134): a session with no record
 *     is only evidence when the same stand-in is proven able to receive.
 *
 * **AC-1 ("runs as part of the gate, not a separate optional check") is STRUCTURAL here, not a
 * convention.** {@link classifyFullFlowGate} cannot return `verified` unless the assertion actually
 * ran over the flow's OWN carried sessions. What enforces that are the INCONCLUSIVE GAP CHECKS: a
 * capture with nothing observed, or with fewer than two concurrent sessions, is `inconclusive`
 * before the verified path is ever reached — and each of those gaps is at least as strict as a
 * condition under which the assertion is skipped, so passing them ENTAILS the assertion having run.
 * {@link FullFlowReport.assertedSessionIds} is the RECEIPT of that property (it names the sessions
 * the assertion actually covered, so a caller can check rather than trust), not the thing enforcing
 * it.
 *
 * **What is real vs stand-in** (the same boundary #66 and #133 document, for the same reason —
 * the repo ships no packaged patched worker): REAL are the tunnel, the `@ccctl/server`, the
 * whole bridge control flow, the launch ingress + pending-launch claim, the registry, the SSE
 * relay, the phone's over-tunnel legs, and the inference legs as real outbound connections
 * carrying `Host: api.anthropic.com`. STAND-IN are the workers, the session launcher, and
 * api.anthropic.com itself (a loopback receiver). So this gate proves the SPLIT and the
 * assertion's integration across a real multi-session flow; it does NOT yet prove a real
 * patched worker's real egress — that leg stays with the credentialed wave, and
 * `docs/security-posture.md` stays PARTIAL until it lands.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAuthority, type ControlEvent } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import type { Tunnel } from "@ccctl/tunnel-adapters";
import { createSession, pollWork, registerEnvironment } from "./bridge-wire-conformance.js";
import {
  assertEverySessionInferenceUntouched,
  InferenceGuaranteeViolation,
  type ObservedConnection,
} from "./inference-guarantee.js";
// REUSED from the UC2 launch oracle (#66) — the phone's own launch transport. Re-declaring it
// would be a second copy of a rule `launch-tunnel.test.ts` already pins.
import { launchOverTunnel, type LaunchRequestBuilder } from "./launch-tunnel.js";
// REUSED from the UC1 tunnel oracle (#65) — the fence, the reachable-base helpers, and the
// over-tunnel phone transport.
import {
  connectTunnelPhone,
  isTailnetHost,
  listSessionsOverTunnel,
  tunnelPhoneBaseUrl,
  userTurnSessionId,
  userTurnText,
} from "./multi-session-tunnel.js";
import { connectFakeWorker, waitFor, type FakeWorker, type UiClient } from "./one-session-harness.js";
import {
  observeInferenceLeg,
  probeStandInLiveness,
  startInferenceStandIn,
  type InferenceStandIn,
} from "./traffic-harness.js";

// --- classification (pure) ---

/** The self-classifying verdict of one driven full-flow gate run. */
export type FullFlowVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const FULL_FLOW_CHECK = {
  tunnel: "tunnel-up (full-flow precondition)",
  publicSurface: "no-public-surface (full-flow precondition)",
  concurrent: "concurrent-sessions-carried (#67 AC-2)",
  launched: "launched-session-carried (#67 AC-2)",
  driven: "phone-drove-list-view-steer (#67 AC-1)",
  standIn: "inference-stand-in-liveness (#134)",
  inference: "inference-untouched-every-session (#67 AC-1/2/3)",
} as const;

/**
 * The receiver-grounded observation of ONE driven gate run, fed to
 * {@link classifyFullFlowGate}.
 *
 * Every field is read from the endpoint that took the traffic — the tunnel's own status, the
 * server's own session records, the stand-in's own request log. Fields that gate an
 * `inconclusive` "never captured" verdict are `undefined` when the leg was never reached, so a
 * missing leg is a gap rather than a silent `false`.
 */
export interface FullFlowCapture {
  /** The real tunnel established AND `status()` reported it up. */
  readonly tunnelUp: boolean;
  /** The reachable base host the phone dialed, or `undefined` if the tunnel never came up. */
  readonly publicHost?: string | undefined;
  /**
   * The reachable base was a PUBLIC host (not tailnet-scoped). `undefined` when the tunnel
   * never came up — no base to judge, which is the tunnel-down gap, not a public-surface drift.
   */
  readonly publicSurface?: boolean | undefined;
  /** The ids of the CONCURRENT (UC1) sessions the flow carried — the gate wants ≥2. */
  readonly runningSessionIds: readonly string[];
  /**
   * The id of the PHONE-LAUNCHED (UC2) session, once its own worker's registration claimed it.
   * `undefined` when the launch leg never materialized as a carried session — an
   * `inconclusive` gap here, never a drift: whether a launch MUST claim its id is #66's
   * judgment, not this gate's.
   */
  readonly launchedSessionId?: string | undefined;
  /**
   * The phone drove list + view + steer across every carried session over the tunnel — the
   * flow the assertion must run "as part of" (AC-1). `undefined` when the leg was never driven.
   */
  readonly drivenOverTunnel?: boolean | undefined;
  /**
   * The Anthropic stand-in answered a liveness canary (#134). Without it a session's ABSENCE
   * from the stand-in's log is not evidence — a dead stand-in reads identically — so the
   * per-session coverage clause would be vacuous. `undefined` when the canary never ran.
   */
  readonly standInLive?: boolean | undefined;
  /**
   * The connections observed across the whole flow (the control leg + one inference leg per
   * carried session). `undefined` when the flow never got far enough to observe any — the gap
   * that makes the gate `inconclusive` rather than falsely green.
   */
  readonly observed?: readonly ObservedConnection[] | undefined;
  /** The host inference MUST reach, unproxied. */
  readonly inferenceHost: string;
}

/** The classified report of one driven gate run. */
export interface FullFlowReport {
  readonly verdict: FullFlowVerdict;
  /** The checks whose observed behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation: what verified, what drifted, or what was never captured. */
  readonly reason: string;
  /**
   * The sessions the inference guarantee was actually asserted across — the AC-1 RECEIPT. Empty
   * unless the assertion ran, so a caller can CHECK "it ran, across these sessions" rather than
   * trust it. What ENFORCES that on a `verified` verdict are the inconclusive gap checks (see
   * {@link classifyFullFlowGate}); this field reports the property, it does not impose it.
   */
  readonly assertedSessionIds: readonly string[];
}

/**
 * Classify one {@link FullFlowCapture} into a {@link FullFlowReport} — the pure heart of the
 * gate, unit-testable without a tailnet.
 *
 * Precedence mirrors every other oracle here: an OBSERVED violation is a definitive `drift`
 * (the flow ran and behaved wrong — the signal the gate exists to raise), so it OUTRANKS a
 * missing capture. Only when nothing drifted does an absent leg become `inconclusive`:
 *
 *   1. **drift** — the per-session inference guarantee was violated (a session's inference
 *      reached the local server, or a carried session's inference was never seen reaching
 *      `inferenceHost`), or the reachable base was PUBLIC. Every violated check is named.
 *   2. **inconclusive** — no drift, but a required leg was never observed: no tunnel, the
 *      reachable base was never judged, fewer than two concurrent sessions, no launched session,
 *      the phone never drove the flow, the stand-in was never proven live, or nothing was
 *      observed at all.
 *   3. **verified** — the flow came up tailnet-scoped carrying ≥2 concurrent sessions plus a
 *      launched one, the phone drove list/view/steer across them, and the inference guarantee
 *      held for EVERY carried session.
 */
export function classifyFullFlowGate(capture: FullFlowCapture): FullFlowReport {
  const carried = [
    ...capture.runningSessionIds,
    ...(capture.launchedSessionId !== undefined ? [capture.launchedSessionId] : []),
  ];

  // The gate's own reason to exist: run the assertion over whatever the flow carried, as soon
  // as there is anything to judge. Deliberately NOT gated on the flow being complete — a
  // partial flow that leaked inference is still a leak, and drift must outrank the gap.
  let assertedSessionIds: readonly string[] = [];
  let inferenceViolation: string | undefined;
  if (capture.observed !== undefined && carried.length > 0) {
    assertedSessionIds = carried;
    try {
      assertEverySessionInferenceUntouched(capture.observed, {
        inferenceHost: capture.inferenceHost,
        expectedSessionIds: carried,
      });
    } catch (error) {
      // A guarantee breach is the drift this gate reports. Any OTHER error would mean the
      // assertion itself failed to run — that is not evidence of a clean split, so it is
      // surfaced too rather than swallowed into a green.
      inferenceViolation =
        error instanceof InferenceGuaranteeViolation
          ? error.message
          : `the assertion could not be evaluated: ${String(error)}`;
    }
  }

  // 1. Drift — observed violations, checked FIRST.
  const violations: string[] = [];
  if (capture.publicSurface === true) {
    violations.push(
      `${FULL_FLOW_CHECK.publicSurface}: the reachable base ${capture.publicHost ?? "?"} is a PUBLIC host, not a tailnet one`,
    );
  }
  if (inferenceViolation !== undefined) {
    violations.push(`${FULL_FLOW_CHECK.inference}: ${inferenceViolation}`);
  }
  if (violations.length > 0) {
    return {
      verdict: "drift",
      violations,
      reason: `the full flow ran but violated ${violations.length} check(s): ${violations.join("; ")}`,
      assertedSessionIds,
    };
  }

  // 2. Inconclusive — nothing drifted, but a required observation is missing.
  const gaps: string[] = [];
  if (!capture.tunnelUp) {
    gaps.push(`${FULL_FLOW_CHECK.tunnel}: no real tunnel came up`);
  }
  if (capture.publicSurface !== false) {
    gaps.push(`${FULL_FLOW_CHECK.publicSurface}: the reachable base was never judged`);
  }
  if (capture.runningSessionIds.length < 2) {
    gaps.push(
      `${FULL_FLOW_CHECK.concurrent}: fewer than two concurrent sessions were carried (${capture.runningSessionIds.length})`,
    );
  }
  if (capture.launchedSessionId === undefined) {
    gaps.push(`${FULL_FLOW_CHECK.launched}: no phone-launched session was carried in the flow`);
  }
  if (capture.drivenOverTunnel !== true) {
    gaps.push(`${FULL_FLOW_CHECK.driven}: the phone never drove list / view / steer across the flow`);
  }
  if (capture.standInLive !== true) {
    gaps.push(`${FULL_FLOW_CHECK.standIn}: the api.anthropic.com stand-in was never proven live`);
  }
  if (capture.observed === undefined) {
    gaps.push(`${FULL_FLOW_CHECK.inference}: no traffic was observed, so the guarantee was never asserted`);
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not capture the full flow over a real tunnel: ${gaps.join("; ")}`,
      assertedSessionIds,
    };
  }

  // 3. Verified — every leg observed and conformant, and (AC-1) the assertion demonstrably ran
  //    over every session the flow carried.
  //
  //    The receipt check below is DEFENCE-IN-DEPTH and is currently unreachable: getting here
  //    requires passing the `observed === undefined` and `runningSessionIds.length < 2` gaps, which
  //    TOGETHER are strictly stronger than the `observed === undefined || carried.length === 0`
  //    condition under which the assertion is skipped (≥2 running sessions means `carried` is
  //    non-empty) — so the receipt always covers `carried` by the time we arrive. It is that
  //    SUBSUMPTION, not an equality, that makes the receipt inert, which is also exactly what it
  //    backstops: loosening a gap check to anything that still implies a non-empty `carried` keeps
  //    the receipt inert, while loosening one PAST that — without noticing it was load-bearing for
  //    AC-1 — is the refactor that would otherwise reintroduce a false green. Nothing can test it
  //    through the public classifier (that is what "unreachable" means), so it is documented as
  //    inert rather than presented as the enforcing mechanism.
  if (assertedSessionIds.length !== carried.length || carried.length === 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason:
        "the flow was captured but the inference guarantee was not asserted across its sessions — " +
        "the gate cannot pass on an assertion it never ran",
      assertedSessionIds,
    };
  }
  return {
    verdict: "verified",
    violations: [],
    reason:
      `${capture.runningSessionIds.length} concurrent sessions plus a phone-launched one were carried over the tunnel ` +
      `(base ${capture.publicHost ?? "?"}); the phone drove list / view / steer across them, and every one of the ` +
      `${carried.length} sessions' inference was observed reaching ${capture.inferenceHost}`,
    assertedSessionIds,
  };
}

// --- drive (impure, fenced) ---

/** How long to let an (erroneous) cross-wired delivery land before asserting its absence. */
const SETTLE_MS = 50;

/** The distinct steer text carried session `index` receives — so a mis-delivery is content-detectable. */
function steerText(index: number): string {
  return `full-flow-steer-for-session-${index}`;
}

/** The distinct transcript worker `index` emits — so a mis-viewed transcript is content-detectable. */
function transcriptEvent(index: number): ControlEvent {
  return { type: "control_event", subtype: "message", payload: { text: `full-flow-transcript-from-${index}` } };
}

/** Inputs to drive the full-flow release gate. */
export interface FullFlowGateOptions {
  /**
   * The real local ccctl server the flow runs against. MUST be configured with a launcher (the
   * `createRecordingLauncher` stand-in in `launch-tunnel.ts`) and a registration timeout above the
   * product default — the UC2 leg launches through it. The launcher is the CALLER's to inject
   * because it is the SERVER's collaborator, not this drive's: nothing here reads it back, since
   * whether the daemon launched with the phone's own options is #66's judgment, not this gate's.
   */
  readonly server: CcctlServer;
  /** The tunnel to expose the server through — a real {@link TailscaleTunnel} in the e2e, injectable for the fence's sake. */
  readonly tunnel: Tunnel;
  /** The account Bearer presented on the §1/§2 control POSTs ONLY (never the §3 poll, never the phone legs). */
  readonly bearer: string;
  /** Builds the phone's "New session" body — the e2e passes the REAL `@ccctl/web-ui` `launchRequest`. */
  readonly buildLaunchRequest: LaunchRequestBuilder;
  /** How many CONCURRENT (UC1) sessions to carry alongside the launched one (≥2 for the gate). */
  readonly concurrentSessions: number;
  /** The host inference must reach, unproxied. */
  readonly inferenceHost: string;
}

/** One session carried by the full flow: its id, its on-box worker, and its OVER-THE-TUNNEL phone. */
interface FlowParticipant {
  readonly sessionId: string;
  readonly worker: FakeWorker;
  readonly phone: UiClient;
}

/**
 * Drive the full-flow release gate over a REAL tunnel and self-classify — NEVER throwing on a
 * divergence or a missing leg (it returns a {@link FullFlowReport}).
 *
 * Establishes the tunnel, carries `concurrentSessions` concurrent sessions PLUS one launched
 * from the phone, has the phone list / view / steer across all of them over the tunnel, then
 * has EVERY carried session perform a model turn and asserts the inference-untouched guarantee
 * across all of them. Always tears the tunnel, the stand-ins and the temp directory down before
 * returning, so a serial e2e run never leaks a socket, a serve mapping or a directory.
 *
 * The launch cwd is a FRESH, CANONICAL temp directory for the two reasons `launch-tunnel.ts`
 * § driveLaunchTunnelFlow documents: the ingress resolves the path (so a raw path would read as
 * an intent mismatch), and the §2 claim key is `(cwd, permissionMode)` (so a reused directory
 * would make the claim ambiguous and the daemon would correctly refuse to lend its id).
 */
export async function driveFullFlowGate(options: FullFlowGateOptions): Promise<FullFlowReport> {
  const { server, tunnel, bearer, buildLaunchRequest, concurrentSessions, inferenceHost } = options;
  const participants: FlowParticipant[] = [];
  let tunnelUp = false;
  let publicHost: string | undefined;
  let publicSurface: boolean | undefined;
  const runningSessionIds: string[] = [];
  let launchedSessionId: string | undefined;
  let drivenOverTunnel: boolean | undefined;
  let standInLive: boolean | undefined;
  let observed: ObservedConnection[] | undefined;

  let cwd: string | undefined;
  let standIn: InferenceStandIn | undefined;

  try {
    // 0. A fresh, canonical directory for the UC2 launch (see the doc comment above for why both).
    cwd = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-e2e-full-flow-")));

    // 1. The loopback stand-in for api.anthropic.com — the receiver whose own log grounds every
    //    per-session "reached Anthropic" read.
    standIn = await startInferenceStandIn();

    // 2. Establish the real tunnel and read its status — the reachable base the phone dials.
    const established = await tunnel.establish(server.address);
    const status = await tunnel.status();
    if (status.up) {
      tunnelUp = true;
      publicHost = status.publicHost;
      // The reachable base MUST be tailnet-scoped — the receiver-grounded "no public IP" AC.
      publicSurface = !isTailnetHost(status.publicHost);
    }

    if (tunnelUp && publicHost !== undefined) {
      const base = tunnelPhoneBaseUrl(established);
      const environmentsBefore = server.environments.size;
      const controlStandInBefore = standIn.received.length;

      // 3. UC1 — carry `concurrentSessions` concurrent sessions on-box (bridge + worker on
      //    loopback, exactly as in reality), each with a phone bound to the TUNNEL base.
      const { environmentId } = await registerEnvironment(server, bearer);
      for (let index = 0; index < concurrentSessions; index += 1) {
        const { sessionId } = await createSession(server, bearer);
        const delivered = await pollWork(server, environmentId);
        if (delivered.item.data.type !== "session" || delivered.item.data.id !== sessionId) {
          throw new Error(`ccctl e2e: §3 poll #${index} did not deliver the session-dispatch item for ${sessionId}`);
        }
        const worker = await connectFakeWorker({ server, sessionId });
        await worker.putStatus("idle");
        const phone = await connectTunnelPhone(base, sessionId);
        participants.push({ sessionId, worker, phone });
        runningSessionIds.push(sessionId);
      }

      // 4. UC2 — the phone LAUNCHES one more session over the tunnel, and its own worker
      //    registers at the launched cwd, CLAIMING it. Id continuity is what makes the launched
      //    session a carried one rather than a ghost row beside a stranger (#66); a claim that
      //    missed leaves `launchedSessionId` unset, which the classifier reads as a gap — whether
      //    a claim MUST land is #66's judgment, not this gate's.
      const launched = await launchOverTunnel(base, buildLaunchRequest(cwd));
      const claimed = await createSession(server, bearer, cwd);
      if (claimed.sessionId === launched.sessionId) {
        const delivered = await pollWork(server, environmentId);
        if (delivered.item.data.type !== "session" || delivered.item.data.id !== claimed.sessionId) {
          throw new Error(`ccctl e2e: §3 poll did not deliver the session-dispatch item for ${claimed.sessionId}`);
        }
        const worker = await connectFakeWorker({ server, sessionId: claimed.sessionId });
        await worker.putStatus("idle");
        const phone = await connectTunnelPhone(base, claimed.sessionId);
        participants.push({ sessionId: claimed.sessionId, worker, phone });
        launchedSessionId = claimed.sessionId;
      }

      // 5. The phone DRIVES the whole flow over the tunnel — list, then steer + view each
      //    carried session. This is the "gate drives list, view, and steer across all sessions"
      //    the assertion below must run as part of (AC-1).
      const listed = await listSessionsOverTunnel(base);
      const listedIds = new Set(listed.map((entry) => entry.id));
      const allListed = participants.every((participant) => listedIds.has(participant.sessionId));

      for (const [index, participant] of participants.entries()) {
        const ack = await participant.phone.steer({ subtype: "prompt", payload: { text: steerText(index) } });
        if (ack.status !== 202) {
          throw new Error(`ccctl e2e: over-tunnel steer #${index} expected 202, got ${ack.status}`);
        }
      }
      await waitFor(() => participants.every((participant) => participant.worker.received().length >= 1));

      for (const [index, participant] of participants.entries()) {
        await participant.worker.emitEvent(transcriptEvent(index));
      }
      await waitFor(() => participants.every((participant) => participant.phone.viewed().length >= 1));
      // Give any (erroneous) cross-wired delivery a chance to land before reading isolation.
      await sleep(SETTLE_MS);
      drivenOverTunnel = allListed && steeredEachOwn(participants) && viewedEachOwn(participants);

      // 6. The CONTROL leg, receiver-grounded in the flow's own receipts: every §1/§2/§4/§5 hop
      //    above was taken by the local server (its own environment + session records prove it),
      //    and none of it reached the Anthropic stand-in (its own log is unchanged). Built from
      //    the flow's OWN control traffic rather than by driving a side-flow through
      //    `observeControlLeg`, which would mint an extra environment + session that the gate
      //    never carries — an orphan row in the very list the phone just enumerated.
      if (
        server.environments.size !== environmentsBefore + 1 ||
        !server.environments.has(environmentId) ||
        !participants.every((participant) => server.sessions.has(participant.sessionId))
      ) {
        throw new Error("ccctl e2e: the local server did not record the flow's own environment + sessions");
      }
      if (standIn.received.length !== controlStandInBefore) {
        throw new Error("ccctl e2e: session-control traffic leaked to the api.anthropic.com stand-in");
      }
      const connections: ObservedConnection[] = [
        {
          leg: "control",
          receivedBy: "local-server",
          intendedHost: formatAuthority(server.address.host, server.address.port),
        },
      ];

      // 7. EVERY carried session performs a model turn (#67 AC-2). Each leg is a real outbound
      //    connection carrying `Host: api.anthropic.com` and its own session marker; the
      //    attribution comes back out of the stand-in's OWN log.
      for (const participant of participants) {
        connections.push(
          await observeInferenceLeg({
            target: standIn.address,
            inferenceHost,
            standIn,
            sessionId: participant.sessionId,
          }),
        );
      }
      observed = connections;

      // 8. Arm the negative space (#134): the per-session coverage clause reads a session's
      //    ABSENCE from the stand-in's log as "its inference did not reach Anthropic". That is
      //    evidence only if this same stand-in can be shown to receive at all — otherwise a dead
      //    stand-in would make every session read as uncovered (a false drift), and, worse, a
      //    stand-in that never recorded markers would make coverage unprovable. Fired AFTER the
      //    inference legs, so it never perturbs their attribution.
      await probeStandInLiveness(standIn);
      standInLive = true;
    }
  } catch {
    // A setup / transport failure leaves whatever was captured intact; the classifier turns the
    // gaps into `inconclusive`. NEVER a fabricated green — the missing legs stay missing.
  } finally {
    for (const participant of participants) {
      await participant.phone.close();
    }
    for (const participant of participants) {
      await participant.worker.close();
    }
    await standIn?.close();
    // Always release the serve mapping, even on a mid-flow failure.
    await tunnel.teardown().catch(() => {});
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  return classifyFullFlowGate({
    tunnelUp,
    publicHost,
    publicSurface,
    runningSessionIds,
    launchedSessionId,
    drivenOverTunnel,
    standInLive,
    observed,
    inferenceHost,
  });
}

/**
 * Each phone's steer reached ONLY its own worker, carrying its own text — receiver-grounded in
 * each worker's own inbound frames.
 */
function steeredEachOwn(participants: readonly FlowParticipant[]): boolean {
  return participants.every((participant, index) => {
    const frames = participant.worker.received();
    const frame = frames[0];
    if (frames.length !== 1 || frame === undefined) {
      return false;
    }
    return (
      userTurnSessionId(frame.payload) === participant.sessionId && userTurnText(frame.payload) === steerText(index)
    );
  });
}

/**
 * Each phone viewed ONLY its own worker's transcript — an exact relayed-bytes match against
 * what that worker emitted (the server relays `JSON.stringify(event)`).
 */
function viewedEachOwn(participants: readonly FlowParticipant[]): boolean {
  return participants.every((participant, index) => {
    const views = participant.phone.viewed();
    const view = views[0];
    if (views.length !== 1 || view === undefined) {
      return false;
    }
    return view.data === JSON.stringify(transcriptEvent(index));
  });
}

/** A promise that resolves after `ms` — the settle window for asserting an absence. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
