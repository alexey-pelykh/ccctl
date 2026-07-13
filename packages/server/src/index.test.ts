// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

// Every started server is tracked and closed in afterEach so no listener leaks
// across tests (each binds an ephemeral port, so parallel tests never collide).
const started: CcctlServer[] = [];

async function startTestServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    const server = started.pop();
    if (server) {
      await server.close();
    }
  }
});

// startServer's own guarantees: it binds loopback on an ephemeral port and routes
// an unrouted path to a fail-closed 404 (the handler's final fallthrough). The
// per-leg behaviors — §1/§2/§3 and the §4 worker channel — are exercised in their
// own suites (environments-bridge.test.ts, worker-channel.test.ts).
describe("startServer", () => {
  it("binds loopback and exposes its (ephemeral) bound address", async () => {
    const server = await startTestServer();
    expect(server.address.host).toBe(DEFAULT_HOST);
    expect(server.address.port).toBeGreaterThan(0);
  });

  it("routes an unknown path to a fail-closed 404", async () => {
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/v1/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("fails closed (404) on the speculative attach-side GET /v1/sessions/{id} (#165)", async () => {
    // §2 matches `/v1/sessions` EXACTLY (POST create), so an id-suffixed bare-resource GET is
    // unrouted and falls through to the handler's fail-closed 404. #154 speculated this attach-side
    // leg "likely also applies" (empty 200 tolerated), extrapolating from the real §4 worker-state
    // restore `GET /v1/code/sessions/{id}/worker`. Confirmed against the e2e captured-wire golden
    // (bridge-wire-conformance.ts, #131/#155) and the live-worker oracle (live-worker-oracle.ts,
    // ORACLE_LEG): a real worker's attach/restore is the §4/§5 worker channel, never a bare
    // `GET /v1/sessions/{id}` — so the 404 is intentional, not a gap (#165).
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/v1/sessions/sess-1`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("rejects a second bind on a held port with a branded 'port in use' message, not raw EADDRINUSE (#156)", async () => {
    const first = await startTestServer();
    const heldPort = first.address.port;

    // A second serve on the same, now-held port must fail — with the branded,
    // actionable ccctl guardrail the CLI surfaces (cli.ts prints error.message and
    // exits non-zero), never the raw Node "listen EADDRINUSE…" string or a stack.
    const rejection = startServer({ port: heldPort, host: DEFAULT_HOST });
    await expect(rejection).rejects.toThrow(new RegExp(`^ccctl: port ${heldPort} is already in use — .*pass --port`));
    await expect(rejection).rejects.not.toThrow(/EADDRINUSE/);
  });
});
