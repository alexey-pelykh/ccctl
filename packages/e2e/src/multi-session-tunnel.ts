// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fenced, self-classifying MULTI-SESSION-OVER-A-REAL-TAILSCALE-TUNNEL oracle —
 * UC1 exercised over a real tailnet (issue #65, traces E2E-B-001).
 *
 * The hermetic multi-session flow (`multi-session-harness.ts`, asserted in
 * `multi-session-flow.e2e.test.ts`, #20) already proves the daemon MULTIPLEXES ≥2
 * concurrent sessions end-to-end — list + view + steer each, never cross-wired — but
 * only over LOOPBACK. UC1's third acceptance criterion is that the SAME flow runs over
 * a **real Tailscale tunnel** (no public IP, no open inbound ports): the phone is a
 * remote tailnet device reaching the loopback-bound {@link CcctlServer} through the
 * tunnel, not on-box.
 *
 * This oracle graduates that hermetic skeleton to a real tunnel, in the exact posture
 * the credentialed LIVE-WORKER oracle (`live-worker-oracle.ts`, #133) holds for the real
 * worker — three properties, each load-bearing:
 *
 *   - **Fenced / opt-in.** {@link resolveTunnelE2EEnv} gates the whole run on
 *     `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE` (both truthy). Absent → the caller SKIPS the
 *     suite (`describe.skipIf`); this oracle lives OUTSIDE the credential-free CI `e2e`
 *     lane and never runs — nor fails — there. The fence LOGIC itself is proven
 *     credential-free in the `test` lane (`multi-session-tunnel.test.ts`).
 *   - **Self-classifying.** Every driven run yields exactly one {@link TunnelVerdict}:
 *     `verified` (≥2 sessions carried; the phone listed all with per-session status,
 *     viewed + steered each — all OVER THE TUNNEL — with no cross-wiring, over a
 *     tailnet-scoped reachable base), `drift` (a definitive contract violation was
 *     OBSERVED while the flow ran — a steer/transcript crossed sessions, the listed set
 *     diverged, or the reachable base was a PUBLIC host, not a tailnet one), or
 *     `inconclusive` (a required leg was never captured — no real tunnel, fewer than two
 *     sessions carried, or the phone never reached a leg over the tunnel).
 *     {@link classifyTunnelFlow} is the pure decision.
 *   - **Skips-never-fakes.** When a real tailnet is absent the fence SKIPS; when a leg
 *     cannot be captured the drive self-classifies `inconclusive` — it NEVER substitutes
 *     a synthetic tunnel or a loopback stand-in to make an absent tailnet look green (the
 *     circular-fixture failure #131 removed). A missing leg is `inconclusive`, never a
 *     fabricated pass.
 *
 * Receiver-grounded, exactly as the hermetic harnesses: every "reached X" is read from
 * the endpoint that actually took the traffic — the server's own session records, each
 * worker's own inbound `client_event` frames, each phone's own SSE log — never a
 * sender's self-report. The phone reaches the server ONLY through the tunnel's resolved
 * public base (`https://<tailnet-host>`), so a successful list/view/steer through it IS
 * the proof the leg traversed the tunnel; and the reachable base being a tailnet-scoped
 * host ({@link isTailnetHost}) — combined with {@link TailscaleTunnel}'s serve-not-funnel
 * guarantee (unit-proven in `@ccctl/tunnel-adapters`) — IS the "no public IP / open
 * ports" AC. View isolation is proven by an EXACT match of each phone's relayed SSE bytes
 * to its OWN worker's emitted transcript (the server relays `JSON.stringify(event)`); the
 * UI decode's correctness is a separate concern already covered hermetically by #20 and
 * `@ccctl/web-ui`'s own `transcript.test.js`.
 *
 * The bridge + worker legs stay on LOOPBACK, as in reality: the patched worker runs
 * on-box with the daemon, so its channel is loopback; only the PHONE is off-box and
 * therefore over the tunnel. The per-session building blocks ({@link connectFakeWorker},
 * {@link registerEnvironment}, {@link createSession}, {@link pollWork}) are REUSED, not
 * re-implemented — this oracle composes them N-fold and points the phone at the tunnel.
 *
 * Forward-looking seam: the {@link Tunnel} is injected, so the pure fence + classifier are
 * fully unit-testable WITHOUT a tailnet, and the e2e supplies a real {@link TailscaleTunnel}
 * (default {@link CommandRunner}, real `tailscale` binary). A backend that cannot bring a
 * real tunnel up surfaces SAFELY as `inconclusive`, never a fake green.
 */

import { formatAuthority, type ControlEvent, type JsonValue } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import type { EstablishedTunnel, Tunnel } from "@ccctl/tunnel-adapters";
import { createSession, pollWork, registerEnvironment } from "./bridge-wire-conformance.js";
import {
  connectFakeWorker,
  parseSseBlock,
  waitFor,
  type FakeWorker,
  type UiClient,
  type UiSteerAck,
  type UiSteerCommand,
  type ViewedSseEvent,
} from "./one-session-harness.js";
import type { SessionListEntry } from "./multi-session-harness.js";

// --- fencing (pure) ---

/** The two env vars that fence the real-tunnel oracle — both must be present and truthy. */
export const TUNNEL_ENV_VARS = ["CCCTL_E2E", "CCCTL_E2E_TAILSCALE"] as const;

/** The fence verdict: ready (both env vars truthy) or not (naming the absent ones). */
export type TunnelFence = { readonly ready: true } | { readonly ready: false; readonly missing: readonly string[] };

/**
 * Resolve the real-tunnel-oracle fence from an environment. READY only when BOTH
 * `CCCTL_E2E` (the shared credentialed-wave master switch) and `CCCTL_E2E_TAILSCALE`
 * (the tunnel arm: "a real, authenticated tailnet is available on this box") are truthy
 * — present and not one of the conventional OFF spellings (`""` / `"0"` / `"false"` /
 * `"no"`). Otherwise NOT ready, naming every absent var. Pure over the injected `env`
 * (defaults to `process.env`) so the fence is unit-testable without mutating the process
 * environment — the caller wraps this in `describe.skipIf(!fence.ready)` so an unfenced
 * run SKIPS (never fails, never fakes) and never enters the credential-free CI lane.
 */
export function resolveTunnelE2EEnv(env: NodeJS.ProcessEnv = process.env): TunnelFence {
  const missing: string[] = [];
  if (!isTruthyFlag(env.CCCTL_E2E)) {
    missing.push("CCCTL_E2E");
  }
  if (!isTruthyFlag(env.CCCTL_E2E_TAILSCALE)) {
    missing.push("CCCTL_E2E_TAILSCALE");
  }
  return missing.length > 0 ? { ready: false, missing } : { ready: true };
}

/** A one-line human reason for a fence hit/miss — used by the caller's skip note. */
export function describeTunnelFence(fence: TunnelFence): string {
  return fence.ready
    ? "real-tunnel oracle armed (CCCTL_E2E + CCCTL_E2E_TAILSCALE present)"
    : `real-tunnel oracle fenced off — missing ${fence.missing.join(", ")}`;
}

/**
 * Whether an env flag reads as ON — present and not one of the conventional OFF
 * spellings. Mirrors the `live-worker-oracle.ts` fence convention; each oracle owns its
 * own fence, so the tiny predicate is duplicated rather than cross-coupling the modules.
 */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

// --- reachable-base resolution (pure) ---

/** The HTTPS port `tailscale serve` exposes the tunnel on (never a public port — tailnet-only). */
const TAILNET_HTTPS_PORT = 443;

/** The MagicDNS suffix every tailnet node's DNS name carries. */
const MAGIC_DNS_SUFFIX = ".ts.net";

/** The Tailscale IPv6 ULA prefix (`fd7a:115c:a1e0::/48`) every tailnet node's v6 address carries. */
const TAILSCALE_ULA_PREFIX = "fd7a:115c:a1e0";

/**
 * The base URL the phone reaches the daemon at THROUGH the tunnel: `https://<host>:443`,
 * where `host` is the tunnel's resolved {@link EstablishedTunnel.publicHost} (a MagicDNS
 * name or a tailnet IP), IPv6-bracketed by {@link formatAuthority}. `serve` exposes the
 * loopback target over tailnet HTTPS/443, so this is exactly what a remote tailnet device
 * — or this node reaching its own serve endpoint — dials. Pure; unit-testable.
 */
export function tunnelPhoneBaseUrl(established: EstablishedTunnel): string {
  return `https://${formatAuthority(established.publicHost, TAILNET_HTTPS_PORT)}`;
}

/**
 * Whether `host` is a TAILNET-SCOPED reachable base — a MagicDNS `*.ts.net` name, a
 * CGNAT `100.64.0.0/10` tailnet IPv4, or a `fd7a:115c:a1e0::/48` Tailscale IPv6 — and
 * therefore NOT a public IP / publicly-routable host. This is the receiver-grounded
 * encoding of UC1's "no public IP / open ports": the base the phone actually dials must
 * be tailnet-scoped. A public host resolved as the base is a definitive `drift`. Pure;
 * unit-testable. Tolerates a trailing dot and case, as the untrusted status output may
 * carry either.
 */
export function isTailnetHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "") {
    return false;
  }
  if (normalized.endsWith(MAGIC_DNS_SUFFIX)) {
    return true;
  }
  if (normalized.startsWith(TAILSCALE_ULA_PREFIX)) {
    return true;
  }
  return isCgnatIpv4(normalized);
}

/** Whether `host` is a dotted IPv4 in the CGNAT `100.64.0.0/10` range Tailscale draws tailnet IPs from. */
function isCgnatIpv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }
  // `\d{1,3}` can only yield 0–999, so an upper bound is the only range check needed.
  const parsed = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
  if (parsed.some((value) => Number.isNaN(value) || value > 255)) {
    return false;
  }
  // 100.64.0.0/10 spans 100.64.0.0 – 100.127.255.255: first octet 100, second in [64, 127].
  const [first, second] = parsed;
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

// --- session-list parsing (pure) ---

/**
 * Parse a `GET /api/sessions` response body into its `{ sessions }` array, defensively —
 * the daemon's carried-session list the phone reads over the tunnel. Throws on a
 * malformed body (not an object, or no `sessions` array) so a broken list read cannot
 * masquerade as an empty carried-session list. Pure; unit-testable without a live server.
 */
export function parseSessionsListBody(body: unknown): SessionListEntry[] {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) {
    throw new Error("ccctl e2e: GET /api/sessions did not return a { sessions: [...] } body");
  }
  return (body as { sessions: SessionListEntry[] }).sessions;
}

/**
 * Whether a listed entry carries a usable per-session status — a non-empty `status` and
 * `activity.kind`. Reads each field as `unknown` first (the entry came off the untrusted
 * wire, so a malformed one must read `false`, not throw), so the shape checks are real.
 */
export function hasPerSessionStatus(entry: SessionListEntry): boolean {
  const status: unknown = entry.status;
  const activity: unknown = entry.activity;
  if (typeof status !== "string" || status === "") {
    return false;
  }
  if (typeof activity !== "object" || activity === null) {
    return false;
  }
  const kind = (activity as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "";
}

// --- injected-turn extraction (pure) ---

/**
 * Extract the prompt text from an injected `{ type: "user" }` turn payload
 * (`{ type: "user", message: { content: [{ text }] }, … }`), or `null` when it is not a
 * well-formed user turn. The receiver-grounded read used to confirm a phone's `prompt`
 * steer landed as ITS worker's turn (carrying ITS text). Pure; unit-testable.
 */
export function userTurnText(payload: JsonValue): string | null {
  const message = userTurnMessage(payload);
  if (message === null) {
    return null;
  }
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return null;
  }
  const text = (first as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

/**
 * Extract the `session_id` from an injected `{ type: "user" }` turn payload, or `null`
 * when absent / not a user turn. The receiver-grounded read used to confirm a steer
 * reached ONLY its addressed session's worker (no cross-wiring). Pure; unit-testable.
 */
export function userTurnSessionId(payload: JsonValue): string | null {
  if (!isUserTurn(payload)) {
    return null;
  }
  const sessionId = (payload as Record<string, unknown>).session_id;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
}

/** Whether `payload` is a `{ type: "user", … }` object turn. */
function isUserTurn(payload: JsonValue): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).type === "user"
  );
}

/** Pull the `message` object out of a user turn, or `null` when malformed. */
function userTurnMessage(payload: JsonValue): { content?: unknown } | null {
  if (!isUserTurn(payload)) {
    return null;
  }
  const message: unknown = (payload as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return null;
  }
  return message;
}

// --- classification (pure) ---

/** The self-classifying verdict of one driven real-tunnel run. */
export type TunnelVerdict = "verified" | "drift" | "inconclusive";

/** Canonical check labels — named in `drift` violations and `inconclusive` gap reports. */
export const TUNNEL_CHECK = {
  tunnel: "tunnel-up (AC3)",
  publicSurface: "no-public-surface (AC3)",
  list: "phone-list-over-tunnel (AC1)",
  steer: "phone-steer-over-tunnel (AC2)",
  view: "phone-view-over-tunnel (AC2)",
  isolation: "session-isolation (AC1/AC2)",
} as const;

/**
 * The receiver-grounded observation of ONE driven run, fed to {@link classifyTunnelFlow}.
 *
 * Every field is read from the endpoint that took the traffic — the tunnel's own status,
 * the phone's own list/SSE record over the tunnel, each worker's own inbound frames —
 * never a self-report. Booleans that gate an `inconclusive` "never captured" verdict are
 * `undefined` when the leg was never reached (e.g. the tunnel never came up), so a missing
 * leg is a gap, not a silent `false`.
 */
export interface TunnelCapture {
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
  /** The session ids created on-box (the sessions the daemon carries; ≥2 for UC1). */
  readonly expectedSessionIds: readonly string[];
  /** The ids the phone LISTED over the tunnel (`GET /api/sessions` through the tunnel base). */
  readonly listedIds: readonly string[];
  /** Every listed entry carried a usable per-session status (non-empty activity.kind + status). */
  readonly perSessionStatusOk: boolean;
  /**
   * Each phone's steer reached ONLY its own worker, carrying its own text (receiver-grounded).
   * `undefined` when the steer leg was never observed over the tunnel.
   */
  readonly steeredIsolated?: boolean | undefined;
  /**
   * Each phone viewed ONLY its own worker's transcript (receiver-grounded via the real UI decode).
   * `undefined` when the view leg was never observed over the tunnel.
   */
  readonly viewedIsolated?: boolean | undefined;
  /** A steer or transcript crossed sessions — a definitive multiplexing violation. */
  readonly crossWired: boolean;
}

/** The classified report of one driven run: the verdict, the named violations, and a human reason. */
export interface TunnelReport {
  readonly verdict: TunnelVerdict;
  /** The checks whose observed behavior violated the contract — non-empty ONLY for `drift`. */
  readonly violations: readonly string[];
  /** A human-readable explanation: what verified, what drifted, or what was never captured. */
  readonly reason: string;
}

/**
 * Classify one {@link TunnelCapture} into a {@link TunnelReport} — the pure heart of the
 * oracle, unit-testable without a tailnet.
 *
 * Precedence is deliberate, mirroring the live-worker oracle: an OBSERVED contract
 * violation is a definitive `drift` (the flow ran and behaved wrong — that is the signal
 * the oracle exists to raise), so it OUTRANKS a missing capture. Only when nothing
 * drifted does an absent leg become `inconclusive` (couldn't capture — no signal, never
 * faked green):
 *
 *   1. **drift** — a cross-wired steer/transcript, a PUBLIC reachable base (not
 *      tailnet-scoped), or a listed set that diverged from the carried sessions while ≥2
 *      were carried. Every violated check is named.
 *   2. **inconclusive** — no drift, but a required leg was never observed: the tunnel
 *      never came up, fewer than two sessions were carried, the phone never listed over
 *      the tunnel, or the steer / view leg was never captured. The gaps are named.
 *   3. **verified** — the tunnel came up tailnet-scoped, ≥2 sessions were carried, the
 *      phone listed all with per-session status, and viewed + steered each over the
 *      tunnel with no cross-wiring.
 */
export function classifyTunnelFlow(capture: TunnelCapture): TunnelReport {
  const expectedSorted = [...capture.expectedSessionIds].sort();
  const listedSorted = [...capture.listedIds].sort();

  // 1. Drift — observed contract violations. Checked FIRST so a present-but-wrong leg is
  //    never masked by a downstream inconclusive gap.
  const violations: string[] = [];
  if (capture.crossWired) {
    violations.push(`${TUNNEL_CHECK.isolation}: a steer or transcript crossed sessions`);
  }
  if (capture.publicSurface === true) {
    violations.push(
      `${TUNNEL_CHECK.publicSurface}: the reachable base ${capture.publicHost ?? "?"} is a PUBLIC host, not a tailnet one`,
    );
  }
  // A diverged list is drift ONLY when the phone actually listed something over the tunnel
  // AND ≥2 sessions were carried (an empty list or a <2 carry is an inconclusive gap, not
  // a wrong-list drift).
  if (
    capture.listedIds.length > 0 &&
    capture.expectedSessionIds.length >= 2 &&
    !sameStringSet(listedSorted, expectedSorted)
  ) {
    violations.push(
      `${TUNNEL_CHECK.list}: the phone listed [${listedSorted.join(", ")}] over the tunnel, expected [${expectedSorted.join(", ")}]`,
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
    gaps.push(`${TUNNEL_CHECK.tunnel}: no real tunnel came up`);
  }
  if (capture.expectedSessionIds.length < 2) {
    gaps.push(`fewer than two sessions were carried (${capture.expectedSessionIds.length})`);
  }
  if (capture.listedIds.length === 0) {
    gaps.push(`${TUNNEL_CHECK.list}: the phone never listed over the tunnel`);
  }
  if (capture.steeredIsolated === undefined) {
    gaps.push(`${TUNNEL_CHECK.steer}: the steer leg was never observed over the tunnel`);
  }
  if (capture.viewedIsolated === undefined) {
    gaps.push(`${TUNNEL_CHECK.view}: the view leg was never observed over the tunnel`);
  }
  if (gaps.length > 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      reason: `could not capture the full flow over a real tunnel: ${gaps.join("; ")}`,
    };
  }

  // 3. Verified — every leg observed and conformant. The remaining booleans are gated
  //    (a `false` here, not `undefined`, would be a captured-but-wrong observation) —
  //    guard them so a stray `false` never reads as verified.
  if (
    capture.perSessionStatusOk &&
    capture.steeredIsolated === true &&
    capture.viewedIsolated === true &&
    capture.publicSurface === false
  ) {
    return {
      verdict: "verified",
      violations: [],
      reason: `≥2 sessions carried; the phone listed all ${listedSorted.length} with per-session status, and viewed + steered each over the tunnel (base ${capture.publicHost ?? "?"}), no cross-wiring`,
    };
  }

  // A captured-but-not-conformant residue (e.g. a listed entry missing its status): treat
  // as inconclusive rather than a false green — the observation was incomplete, not proven.
  const residue: string[] = [];
  if (!capture.perSessionStatusOk) {
    residue.push(`${TUNNEL_CHECK.list}: a listed session was missing its per-session status`);
  }
  if (capture.steeredIsolated !== true) {
    residue.push(`${TUNNEL_CHECK.steer}: the steer isolation was not positively confirmed`);
  }
  if (capture.viewedIsolated !== true) {
    residue.push(`${TUNNEL_CHECK.view}: the view isolation was not positively confirmed`);
  }
  return {
    verdict: "inconclusive",
    violations: [],
    reason: `the flow was captured but not positively confirmed: ${residue.join("; ")}`,
  };
}

/** Set equality for two ALREADY-SORTED string arrays. */
function sameStringSet(sortedA: readonly string[], sortedB: readonly string[]): boolean {
  return sortedA.length === sortedB.length && sortedA.every((value, index) => value === sortedB[index]);
}

// --- drive (impure, fenced) ---

/** How long an over-tunnel HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How long to let an (erroneous) cross-wired delivery land before asserting its absence. */
const CROSS_WIRE_SETTLE_MS = 50;

/** Inputs to drive the multi-session-over-a-real-tunnel flow. */
export interface MultiSessionTunnelFlowOptions {
  /** The real local ccctl server the flow runs against (binds loopback; the tunnel is its only off-box path). */
  readonly server: CcctlServer;
  /** The tunnel to expose the server through — a real {@link TailscaleTunnel} in the e2e, injectable for the fence's sake. */
  readonly tunnel: Tunnel;
  /** The account Bearer presented on the §1/§2 control POSTs ONLY (never the §3/§4/§5 legs, never the phone legs). */
  readonly bearer: string;
  /** How many concurrent sessions to carry (≥2 for UC1). */
  readonly sessionCount: number;
}

/** One session carried by the flow: its id, its on-box worker, and its OVER-THE-TUNNEL phone. */
interface TunnelParticipant {
  readonly sessionId: string;
  readonly worker: FakeWorker;
  readonly phone: UiClient;
}

/**
 * Drive UC1 over a REAL tunnel and self-classify — NEVER throwing on a divergence or a
 * missing leg (it returns a {@link TunnelReport}). Establishes the tunnel, carries
 * `sessionCount` sessions on-box (bridge + worker legs on loopback), and has each phone
 * list / view / steer its own session THROUGH the tunnel's public base — every hop
 * receiver-grounded. A setup / transport failure (no tailnet, an unreachable base) is
 * captured as `inconclusive`; an observed contract violation (cross-wiring, a public
 * base, a wrong list) as `drift`; a clean run as `verified`. Always tears the tunnel and
 * every stand-in down before returning, so a serial e2e run never leaks a socket or a
 * serve mapping.
 */
export async function driveMultiSessionTunnelFlow(options: MultiSessionTunnelFlowOptions): Promise<TunnelReport> {
  const { server, tunnel, bearer, sessionCount } = options;
  const participants: TunnelParticipant[] = [];
  let tunnelUp = false;
  let publicHost: string | undefined;
  let publicSurface: boolean | undefined;
  const expectedSessionIds: string[] = [];
  let listedIds: string[] = [];
  let perSessionStatusOk = false;
  let steeredIsolated: boolean | undefined;
  let viewedIsolated: boolean | undefined;
  let crossWired = false;

  try {
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

      // 2. Carry `sessionCount` sessions on-box: one environment, then per session a
      //    create → poll → worker channel (loopback), and a phone bound to the TUNNEL base.
      const { environmentId } = await registerEnvironment(server, bearer);
      for (let index = 0; index < sessionCount; index += 1) {
        const { sessionId } = await createSession(server, bearer);
        const delivered = await pollWork(server, environmentId);
        if (delivered.item.data.type !== "session" || delivered.item.data.id !== sessionId) {
          throw new Error(`ccctl e2e: §3 poll #${index} did not deliver the session-dispatch item for ${sessionId}`);
        }
        const worker = await connectFakeWorker({ server, sessionId });
        await worker.putStatus("idle");
        const phone = await connectTunnelPhone(base, sessionId);
        participants.push({ sessionId, worker, phone });
        expectedSessionIds.push(sessionId);
      }

      // 3. LIST over the tunnel — the phone enumerates every carried session with its status.
      const listed = await listSessionsOverTunnel(base);
      listedIds = listed.map((entry) => entry.id);
      perSessionStatusOk =
        listed.length >= sessionCount &&
        listed.every(hasPerSessionStatus) &&
        expectedSessionIds.every((id) => listed.some((entry) => entry.id === id));

      // 4. STEER each over the tunnel — each phone sends its own distinct prompt; each
      //    worker must receive ONLY its own, carrying its own text + session id.
      for (const [index, participant] of participants.entries()) {
        const ack = await participant.phone.steer({ subtype: "prompt", payload: { text: steerText(index) } });
        if (ack.status !== 202) {
          throw new Error(`ccctl e2e: over-tunnel steer #${index} expected 202, got ${ack.status}`);
        }
      }
      await waitFor(() => participants.every((p) => p.worker.received().length >= 1));
      // Give any (erroneous) cross-wired delivery a chance to land before asserting isolation.
      await sleep(CROSS_WIRE_SETTLE_MS);
      steeredIsolated = assessSteerIsolation(participants);
      if (!steeredIsolated) {
        crossWired = true;
      }

      // 5. VIEW each over the tunnel — each worker emits its own distinct transcript; each
      //    phone must view ONLY its own (proven by an exact relayed-bytes match).
      for (const [index, participant] of participants.entries()) {
        await participant.worker.emitEvent(transcriptEvent(index));
      }
      await waitFor(() => participants.every((p) => p.phone.viewed().length >= 1));
      await sleep(CROSS_WIRE_SETTLE_MS);
      viewedIsolated = assessViewIsolation(participants);
      if (!viewedIsolated) {
        crossWired = true;
      }
    }
  } catch {
    // A setup / transport failure leaves whatever was captured intact; the classifier turns
    // the gaps into `inconclusive`. NEVER a fabricated green — the missing legs stay missing.
  } finally {
    for (const participant of participants) {
      await participant.phone.close();
    }
    for (const participant of participants) {
      await participant.worker.close();
    }
    // Always release the serve mapping, even on a mid-flow failure.
    await tunnel.teardown().catch(() => {});
  }

  return classifyTunnelFlow({
    tunnelUp,
    publicHost,
    publicSurface,
    expectedSessionIds,
    listedIds,
    perSessionStatusOk,
    steeredIsolated,
    viewedIsolated,
    crossWired,
  });
}

/** The distinct steer text phone `index` sends — so a mis-delivered steer is detectable by content. */
function steerText(index: number): string {
  return `steer-for-session-${index}`;
}

/** The distinct transcript event worker `index` emits — so a mis-viewed transcript is detectable by content. */
function transcriptEvent(index: number): ControlEvent {
  return { type: "control_event", subtype: "message", payload: { text: `transcript-from-session-${index}` } };
}

/**
 * Assess steer isolation, receiver-grounded: every worker received EXACTLY one frame,
 * carrying ITS OWN session id and ITS OWN steer text (and no worker received another's).
 * `false` on any cross-wired or missing / extra delivery.
 */
function assessSteerIsolation(participants: readonly TunnelParticipant[]): boolean {
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
 * Assess view isolation, receiver-grounded: every phone viewed EXACTLY one transcript,
 * and its relayed SSE bytes EXACTLY equal ITS OWN worker's emitted event (the server
 * relays `JSON.stringify(event)`). `false` on any cross-wired or missing / extra view.
 * Exact-bytes match proves isolation without depending on the untyped UI decode.
 */
function assessViewIsolation(participants: readonly TunnelParticipant[]): boolean {
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

// --- over-tunnel phone transport (impure, fenced) ---

/**
 * Subscribe an over-tunnel phone to the SESSION's SSE stream (`GET
 * {base}/api/sessions/{id}/events`) and resolve a {@link UiClient} — the SAME stand-in
 * phone contract the hermetic harnesses drive (that identity is the point: this oracle
 * runs the #20 flow unchanged, only over a tunnel), but bound to the tunnel base rather
 * than the server's loopback address. It closes over ONLY the tunnel base, so a successful
 * view / steer through it IS the proof the leg traversed the tunnel.
 *
 * Resolves once the response headers arrive — at which point the server has registered the
 * subscriber — so a subsequent worker emit is delivered live rather than missed. Uses
 * `fetch` streaming (not `node:http`) because the base is an HTTPS tailnet URL, and a
 * standard `fetch` validates the tailnet-provisioned cert with no bypass. Rejects if the
 * stream open is refused (a non-200), so a refused open never masquerades as a live stream.
 */
export async function connectTunnelPhone(base: string, sessionId: string): Promise<UiClient> {
  const events: ViewedSseEvent[] = [];
  const stream = await openFetchSse(`${base}/api/sessions/${sessionId}/events`, (event) => {
    events.push({ id: event.id, data: event.data });
  });
  return {
    viewed: (): readonly ViewedSseEvent[] => events,
    steer: (command: UiSteerCommand): Promise<UiSteerAck> =>
      postSteerOverTunnel(`${base}/api/sessions/${sessionId}/command`, command),
    close: (): Promise<void> => stream.close(),
  };
}

/** Read `GET {base}/api/sessions` over the tunnel and return its `{ sessions }` array. */
export async function listSessionsOverTunnel(base: string): Promise<SessionListEntry[]> {
  const res = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status !== 200) {
    throw new Error(`ccctl e2e: over-tunnel GET /api/sessions expected 200, got ${res.status}`);
  }
  return parseSessionsListBody(await res.json());
}

/** A held-open SSE reader over a `fetch` streaming body. */
interface FetchSseStream {
  close(): Promise<void>;
}

/**
 * Open a held-open SSE stream over `fetch` (`GET url`) and invoke `onEvent` for every
 * complete `\n\n`-delimited block (comment-only blocks parse to `null` and are skipped).
 * Resolves after the headers arrive (the subscriber is then registered), then drains the
 * streaming body in the background until closed. `close()` aborts the request, ending the
 * drain. Rejects if the server answers a non-200, so a refused open never masquerades as a
 * live stream. Idempotent buffering reassembles a block split across two chunks.
 */
async function openFetchSse(
  url: string,
  onEvent: (event: { id: string | undefined; data: string }) => void,
): Promise<FetchSseStream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
  if (res.status !== 200 || res.body === null) {
    controller.abort();
    throw new Error(`ccctl e2e: over-tunnel SSE stream ${url} refused with HTTP ${res.status}`);
  }
  // `fetch`'s `Response.body` is typed with an `any` chunk; pin it to `Uint8Array` so the
  // drained chunks (and `TextDecoder.decode`) are type-safe, not `any`.
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  // Drain the body in the background; the read loop ends when the reader is aborted on close.
  void (async (): Promise<void> => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const parsed = parseSseBlock(buffer.slice(0, boundary));
          if (parsed !== null) {
            onEvent({ id: parsed.id, data: parsed.data });
          }
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted on close (or the server ended the stream on shutdown) — a clean end of drain.
    }
  })();
  return {
    close: async (): Promise<void> => {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

/** POST one steer over the tunnel and read the server's `{ id }` ack (best-effort on a refusal). */
async function postSteerOverTunnel(url: string, command: UiSteerCommand): Promise<UiSteerAck> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => ({}));
  const id =
    typeof body === "object" && body !== null && typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : "";
  return { status: res.status, id };
}
