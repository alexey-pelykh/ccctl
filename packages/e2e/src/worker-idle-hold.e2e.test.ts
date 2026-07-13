// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { createSession } from "./bridge-wire-conformance.js";
import {
  assertIdleHeldPastLivenessTimeout,
  classifyIdleHold,
  LIVENESS_FRAME_INTERVAL_MS,
  openWorkerLivenessStandIn,
  WORKER_LIVENESS_TIMEOUT_MS,
  type WorkerLivenessStandIn,
} from "./worker-idle-hold.js";

// The #167 idle-hold regression: the hermetic, deterministic layer that verifies the server's
// #166 downstream-liveness fix end-to-end. The captured-wire golden (#131/#155) pins each
// bridge leg's SHAPE but is blind to whether the server HOLDS the worker downstream alive over
// time; this drives a worker STAND-IN embodying the reader's ~45s liveness contract against the
// REAL @ccctl/server (booted with a SHORT liveness interval so the timer fires within the test)
// and asserts the idle downstream stays open past the timeout, with a `client_event` liveness
// frame inside the window and no drop / re-register. Hermetic: loopback only, no patched worker
// or credentials, so it gates on every run — the complement to the fenced live-worker oracle
// (#133) and the inference-untouched canary (#134).

const ACCOUNT_BEARER = "oauth-account-secret-idle-hold";

// A short long-poll window: this flow never polls for work (it only needs a created session for
// the worker channel), so this is a safety net against the default 25s hold, never load-bearing.
const POLL_TIMEOUT_MS = 200;

// The negative control reproduces the pre-#166 behavior WITHIN the hold window by pushing the
// server's liveness interval far above it — so the idle downstream is silent, exactly as it was
// before #166. The stand-in's ~45s-scaled deadline must then fire.
const STARVED_LIVENESS_INTERVAL_MS = 60_000;
const STARVED_HOLD_MS = WORKER_LIVENESS_TIMEOUT_MS * 2;

const servers: CcctlServer[] = [];
const standIns: WorkerLivenessStandIn[] = [];

/** Start a real @ccctl/server whose #166 liveness interval is `workerLivenessIntervalMs`. */
async function startLivenessServer(workerLivenessIntervalMs: number): Promise<CcctlServer> {
  const server = await startServer({
    port: 0,
    host: DEFAULT_HOST,
    workerLivenessIntervalMs,
    workPollTimeoutMs: POLL_TIMEOUT_MS,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (standIns.length > 0) {
    await standIns.pop()?.close();
  }
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("ccctl e2e: the server holds an idle worker downstream past the liveness timeout (#167)", () => {
  describe("Rule: an idle session's downstream stays open across the timeout, with no reconnect / re-register", () => {
    it("holds idle past the liveness timeout with ≥1 client_event liveness frame in the window (AC1/AC2/AC3)", async () => {
      const server = await startLivenessServer(LIVENESS_FRAME_INTERVAL_MS);
      const { sessionId } = await createSession(server, ACCOUNT_BEARER);

      // Drive the stand-in worker to idle and hold its downstream past the modeled ~45s deadline.
      // A returning call is the positive verdict — the stand-in never had to reconnect.
      const observation = await assertIdleHeldPastLivenessTimeout({ server, sessionId });

      // AC1 — held on a SINGLE continuous downstream: the modeled liveness deadline never fired,
      // so a real worker would never have dropped the stream or re-registered.
      expect(observation.drops).toBe(0);
      expect(observation.holdDurationMs).toBeGreaterThan(WORKER_LIVENESS_TIMEOUT_MS);

      // AC2 — ≥1 `client_event` liveness frame landed WITHIN the timeout window.
      expect(observation.livenessFrames).toBeGreaterThanOrEqual(1);
      const firstLiveness = observation.firstLivenessElapsedMs;
      expect(firstLiveness).not.toBeNull();
      expect(firstLiveness ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(WORKER_LIVENESS_TIMEOUT_MS);

      // AC3 — the server still held the worker downstream open at the end (no stream drop).
      expect(observation.streamOpenAtEnd).toBe(true);

      // Receiver-grounded corroboration: the server tracked exactly this one session and it never
      // left idle — the liveness frames are a proven no-op on the session's activity (#166).
      expect(server.sessions.size).toBe(1);
      expect(server.sessions.get(sessionId)?.activity.kind).toBe("idle");
    });

    it("emits SEVERAL liveness frames across the hold — periodic, not a single opening push (AC2)", async () => {
      // The stream survives BECAUSE the server keeps emitting: over a hold spanning multiple
      // deadline windows, more than one frame must land (a lone opening frame would let the
      // second window lapse). This is the temporal property the static golden cannot see.
      const server = await startLivenessServer(LIVENESS_FRAME_INTERVAL_MS);
      const { sessionId } = await createSession(server, ACCOUNT_BEARER);

      const observation = await assertIdleHeldPastLivenessTimeout({ server, sessionId });

      // The hold is 3× the timeout and the interval is well below it, so many frames land; assert
      // conservatively (≥2) to prove periodicity without pinning a jitter-sensitive exact count.
      expect(observation.livenessFrames).toBeGreaterThanOrEqual(2);
      expect(observation.clientEventFrames).toBe(observation.livenessFrames);
    });
  });

  describe("Rule: the stand-in genuinely catches the pre-#166 behavior (self-guard — the #134 posture)", () => {
    it("a starved (pre-#166) downstream drops: no frame in the window and the deadline fires (AC3 fail-closed)", async () => {
      // Reproduce pre-#166 within the window: a liveness interval far above the hold means the idle
      // downstream is silent, exactly as before #166. If the stand-in's monitor did NOT fire here,
      // its `drops === 0` in the positive test would be a vacuous pass — a dead detector always reads
      // clean (the exact circular-fixture trap #131/#134 removed). It MUST record the drop.
      const server = await startLivenessServer(STARVED_LIVENESS_INTERVAL_MS);
      const { sessionId } = await createSession(server, ACCOUNT_BEARER);

      const standIn = await openWorkerLivenessStandIn({ server, sessionId });
      standIns.push(standIn);
      const observation = await standIn.holdIdle(STARVED_HOLD_MS);
      const verdict = classifyIdleHold(observation);

      // The pre-#166 shape: the downstream stayed silent and the modeled deadline fired.
      expect(verdict.held).toBe(false);
      expect(observation.livenessFrames).toBe(0);
      expect(observation.drops).toBeGreaterThanOrEqual(1);
      expect(verdict.violations.join(" ")).toMatch(/deadline fired/);

      // The SERVER-side downstream is still open — the drop is the WORKER's liveness lapse (what
      // forces the reconnect), not the server closing the stream. This is precisely the flap #166
      // eliminates: the server holds the socket, but without a frame the worker abandons it.
      expect(server.hasLiveWorker(sessionId)).toBe(true);
    });
  });
});
