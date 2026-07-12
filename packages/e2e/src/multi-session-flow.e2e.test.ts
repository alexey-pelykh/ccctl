// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { driveMultiSessionFlow, type MultiSessionFlow } from "./multi-session-harness.js";
import { waitFor } from "./one-session-harness.js";
// The REAL phone decode (#15), so the multi-session view is asserted through the actual UI
// classifier, not a re-implemented stand-in of it.
import { processEventData } from "@ccctl/web-ui/src/transcript.js";

// The multi-session control-plane flow (issue #20, traces SRV-B-002): one environment, ≥2
// concurrent sessions, each with its own stand-in worker + phone, driven end-to-end against
// the REAL @ccctl/server on loopback (hermetic — no patched worker, no credentials, no
// egress). It proves the daemon MULTIPLEXES concurrent sessions: `GET /api/sessions` lists
// them all, each phone views + steers its OWN session, and — the load-bearing multiplexing
// guarantee — a steer never reaches another session's worker and a worker's transcript never
// reaches another session's phone. Every "reached X" is grounded in the receiver's OWN record
// (the worker's inbound client_event frames, the phone's SSE log), never a sender's self-report.

const ACCOUNT_BEARER = "oauth-account-secret-multi-e2e";

const ccctlServers: CcctlServer[] = [];
const flows: MultiSessionFlow[] = [];

async function startLocalServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  ccctlServers.push(server);
  return server;
}

// Close each flow's stand-in phones + workers FIRST, then the servers, so no client write
// races a closing server and no listener leaks across the serial e2e run.
afterEach(async () => {
  while (flows.length > 0) {
    await flows.pop()?.close();
  }
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
});

describe("ccctl e2e: multi-session flow — N concurrent sessions, never cross-wired (#20)", () => {
  describe("Rule: the daemon carries ≥2 sessions end-to-end — list + view + steer each", () => {
    it("lists both sessions, and each phone views + steers only its OWN session (AC 3+4)", async () => {
      const server = await startLocalServer();
      const flow = await driveMultiSessionFlow({ server, bearer: ACCOUNT_BEARER, sessionCount: 2 });
      flows.push(flow);
      const [a, b] = flow.sessions;
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // The server itself records exactly two independent sessions, each addressed by its own id.
      expect(server.sessions.size).toBe(2);
      expect(server.sessions.has(a.sessionId)).toBe(true);
      expect(server.sessions.has(b.sessionId)).toBe(true);
      expect(a.sessionId).not.toBe(b.sessionId);

      // LIST (#20) — `GET /api/sessions` enumerates BOTH carried sessions, each idle.
      const listed = await flow.listSessions();
      expect(listed.map((s) => s.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
      for (const entry of listed) {
        expect(entry.activity).toEqual({ kind: "idle" });
      }

      // STEER each (#20) — steer A then B; each worker receives ONLY its own steer, carrying
      // its own text, grounded in the worker's own inbound frames.
      expect((await a.ui.steer({ subtype: "prompt", payload: { text: "for-A" } })).status).toBe(202);
      expect((await b.ui.steer({ subtype: "prompt", payload: { text: "for-B" } })).status).toBe(202);
      await waitFor(() => a.worker.received().length >= 1 && b.worker.received().length >= 1);
      // Give any (erroneous) cross-wired delivery a chance to land before asserting absence.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(a.worker.received()).toHaveLength(1);
      expect(b.worker.received()).toHaveLength(1);
      expect(a.worker.received()[0].payload).toMatchObject({
        type: "user",
        message: { content: [{ text: "for-A" }] },
        session_id: a.sessionId,
      });
      expect(b.worker.received()[0].payload).toMatchObject({
        type: "user",
        message: { content: [{ text: "for-B" }] },
        session_id: b.sessionId,
      });

      // VIEW each (#20) — each worker emits a distinct transcript UPSTREAM; each phone views
      // ONLY its own session's, with an INDEPENDENT per-session Last-Event-ID cursor (both id "1").
      await a.worker.emitEvent({ type: "control_event", subtype: "message", payload: { text: "from-A" } });
      await b.worker.emitEvent({ type: "control_event", subtype: "message", payload: { text: "from-B" } });
      await waitFor(() => a.ui.viewed().length >= 1 && b.ui.viewed().length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(a.ui.viewed()).toHaveLength(1);
      expect(b.ui.viewed()).toHaveLength(1);
      expect(a.ui.viewed()[0].id).toBe("1");
      expect(b.ui.viewed()[0].id).toBe("1");
      // The REAL UI decode classifies each as its own session's transcript line — no bleed.
      expect(processEventData(a.ui.viewed()[0].data)).toEqual({
        kind: "transcript",
        subtype: "message",
        summary: "from-A",
      });
      expect(processEventData(b.ui.viewed()[0].data)).toEqual({
        kind: "transcript",
        subtype: "message",
        summary: "from-B",
      });
    });

    it("derives each session's activity independently — a status on one never moves the other (#20/#21)", async () => {
      const server = await startLocalServer();
      const flow = await driveMultiSessionFlow({ server, bearer: ACCOUNT_BEARER, sessionCount: 2 });
      flows.push(flow);
      const [a, b] = flow.sessions;

      // Drive ONLY session A to `running`; session B is untouched.
      await a.worker.putStatus("running");
      await waitFor(() => server.sessions.get(a.sessionId)?.activity.kind === "running");

      const listed = await flow.listSessions();
      const listedA = listed.find((s) => s.id === a.sessionId);
      const listedB = listed.find((s) => s.id === b.sessionId);
      expect(listedA?.activity).toEqual({ kind: "running" });
      // B keeps its own idle activity — status is never confused across sessions.
      expect(listedB?.activity).toEqual({ kind: "idle" });
      expect(server.sessions.get(b.sessionId)?.activity.kind).toBe("idle");
    });
  });
});
