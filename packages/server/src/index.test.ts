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
