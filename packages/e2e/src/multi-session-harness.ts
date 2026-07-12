// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The multi-session control-plane flow harness — carrying ≥2 concurrent sessions
 * end-to-end (issue #20, traces SRV-B-002).
 *
 * Where `one-session-harness.ts` drives ONE session's round-trip, this drives N of them
 * against the SAME real {@link CcctlServer}, hermetically (loopback only; stand-in workers
 * + stand-in phones, no patched worker, no credentials, no egress), to prove the daemon
 * multiplexes concurrent sessions WITHOUT cross-wiring:
 *
 *   1. **One environment, N sessions** — register the environment once (§1), then for
 *      each session create it (§2, account Bearer), poll its auto-enqueued work item (§3,
 *      uncredentialed), open a stand-in worker channel (§4/§5), and subscribe a stand-in
 *      phone to THAT session's SSE stream (`GET /api/sessions/{id}/events`, #20).
 *   2. **List** — `GET /api/sessions` enumerates every carried session (the "list" of the
 *      multi-session AC), so a client can pick one to view / steer.
 *   3. **View + steer each, isolated** — the test steers each phone and emits from each
 *      worker; because the UI transport is session-addressed (#20), a steer lands on ONLY
 *      the addressed session's worker and a worker's transcript reaches ONLY that session's
 *      phone. The harness exposes each session's {@link FakeWorker} + {@link UiClient} so the
 *      test asserts that isolation directly, RECEIVER-grounded (the worker's own inbound
 *      frames, the phone's own SSE log) — never a sender's self-report, the same posture
 *      `one-session-harness.ts` holds.
 *
 * The per-session building blocks ({@link connectFakeWorker}, {@link connectUiClient}) and
 * the bridge legs ({@link registerEnvironment}, {@link createSession}, {@link pollWork}) are
 * REUSED, not re-implemented — this harness only composes them N-fold and adds the list read.
 */

import { formatAuthority, type HostEndpoint } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import {
  createSession,
  pollWork,
  registerEnvironment,
  type DecodedWorkSecret,
  type WorkItemWire,
} from "./bridge-wire-conformance.js";
import { connectFakeWorker, connectUiClient, type FakeWorker, type UiClient } from "./one-session-harness.js";

/** How long a harness HTTP round-trip waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/** One session carried by the flow: its id, its §3 work item + secret, and its stand-in worker + phone. */
export interface MultiSessionParticipant {
  /** The server-assigned session id from this session's §2 create. */
  readonly sessionId: string;
  /** The SINGLE session-dispatch work item the bridge received for this session over §3. */
  readonly workItem: WorkItemWire;
  /** The decoded §3 work-secret (this session's ingress token + control base). */
  readonly workSecret: DecodedWorkSecret;
  /** This session's stand-in worker (SSE client of its downstream + poster of its upstream legs). */
  readonly worker: FakeWorker;
  /** This session's stand-in phone (subscribed to its SSE stream; steers its command path). */
  readonly ui: UiClient;
}

/** One entry of the `GET /api/sessions` list — a session's id + its own state (#20). */
export interface SessionListEntry {
  readonly id: string;
  readonly status: string;
  readonly activity: { readonly kind: string };
}

/** The receiver-grounded setup of a multi-session flow — the participants + the list read. */
export interface MultiSessionFlow {
  /** The server-assigned environment id shared by every session (one §1 register). */
  readonly environmentId: string;
  /** The carried sessions, in creation order. */
  readonly sessions: readonly MultiSessionParticipant[];
  /** Read `GET /api/sessions` — the sessions the daemon currently reports carrying. */
  listSessions(): Promise<SessionListEntry[]>;
  /** Tear down every stand-in phone + worker (the server is the caller's to close). */
  close(): Promise<void>;
}

/** Inputs to set up the multi-session flow. */
export interface MultiSessionFlowOptions {
  /** The real local ccctl server the flow runs against. */
  readonly server: CcctlServer;
  /** The account Bearer presented on the §1/§2 control POSTs ONLY (never the §3/§4/§5 legs). */
  readonly bearer: string;
  /** How many concurrent sessions to carry (≥2 for the multiplexing AC). */
  readonly sessionCount: number;
}

/**
 * Set up `sessionCount` concurrent sessions against `server` and resolve a
 * {@link MultiSessionFlow}: one environment, then per session a create → poll →
 * worker-channel → phone subscription, each grounded in the receiver's own record (a
 * mis-delivered work item throws before the test runs). Every worker reports `idle` so the
 * server carries N live sessions. On any failure it closes whatever it already opened
 * before rethrowing, so a serial e2e run never leaks a socket.
 */
export async function driveMultiSessionFlow(options: MultiSessionFlowOptions): Promise<MultiSessionFlow> {
  const { server, bearer, sessionCount } = options;
  const opened: { worker?: FakeWorker; ui?: UiClient }[] = [];
  const closeAll = async (): Promise<void> => {
    // Phones first, then workers — the same teardown order one-session-harness holds.
    for (const slot of opened) {
      await slot.ui?.close();
    }
    for (const slot of opened) {
      await slot.worker?.close();
    }
  };

  try {
    // §1 — one environment shared by every session.
    const { environmentId } = await registerEnvironment(server, bearer);

    const participants: MultiSessionParticipant[] = [];
    for (let index = 0; index < sessionCount; index += 1) {
      // §2 — create the session; the server AUTO-ENQUEUES its work item.
      const { sessionId } = await createSession(server, bearer);

      // §3 — the just-created session's item is next on the queue (FIFO); grounded in the
      // poll body the bridge got back, correlated to this session id.
      const delivered = await pollWork(server, environmentId);
      if (delivered.item.data.type !== "session" || delivered.item.data.id !== sessionId) {
        throw new Error(`ccctl e2e: §3 poll #${index} did not deliver the session-dispatch item for ${sessionId}`);
      }

      // §4/§5 — open the stand-in worker channel and report idle so the session is live.
      const worker = await connectFakeWorker({ server, sessionId });
      const slot: { worker?: FakeWorker; ui?: UiClient } = { worker };
      opened.push(slot);
      await worker.putStatus("idle");

      // Phone subscribes to THIS session's SSE stream (#20) — before any emit, so its
      // events are delivered live rather than missed.
      const ui = await connectUiClient({ server, sessionId });
      slot.ui = ui;

      participants.push({ sessionId, workItem: delivered.item, workSecret: delivered.secret, worker, ui });
    }

    return {
      environmentId,
      sessions: participants,
      listSessions: (): Promise<SessionListEntry[]> => listSessions(server.address),
      close: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/** Read `GET /api/sessions` and return its `{ sessions }` array (the daemon's carried-session list). */
export async function listSessions(address: HostEndpoint): Promise<SessionListEntry[]> {
  const res = await fetch(`http://${formatAuthority(address.host, address.port)}/api/sessions`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`ccctl e2e: GET /api/sessions expected 200, got ${res.status}`);
  }
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) {
    throw new Error("ccctl e2e: GET /api/sessions did not return a { sessions: [...] } body");
  }
  return (body as { sessions: SessionListEntry[] }).sessions;
}
