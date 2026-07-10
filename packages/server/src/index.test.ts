// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { SESSIONS_CREATE_PATH } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

const ACCOUNT_BEARER = "oauth-account-secret-abc123";

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

function sessionsUrl(server: CcctlServer): string {
  const { host, port } = server.address;
  return `http://${host}:${port}${SESSIONS_CREATE_PATH}`;
}

interface RegisterOptions {
  // `null` omits the Authorization header entirely.
  readonly authorization?: string | null;
  readonly body?: unknown;
}

function register(server: CcctlServer, options: RegisterOptions = {}): Promise<Response> {
  const { authorization = `Bearer ${ACCOUNT_BEARER}`, body = { sessionIngressToken: "ingress-token-1" } } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization !== null) {
    headers.Authorization = authorization;
  }
  return fetch(sessionsUrl(server), { method: "POST", headers, body: JSON.stringify(body) });
}

describe("startServer — POST /v1/code/sessions (register)", () => {
  it("binds loopback and exposes its (ephemeral) bound address", async () => {
    const server = await startTestServer();
    expect(server.address.host).toBe(DEFAULT_HOST);
    expect(server.address.port).toBeGreaterThan(0);
  });

  it("accepts a register and returns a session id + ws_url (AC#1, AC#2)", async () => {
    const server = await startTestServer();
    const res = await register(server);
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { sessionId: string; wsUrl: string };
    expect(typeof payload.sessionId).toBe("string");
    expect(payload.sessionId.length).toBeGreaterThan(0);
    const { host, port } = server.address;
    expect(payload.wsUrl).toBe(`ws://${host}:${port}${SESSIONS_CREATE_PATH}/${payload.sessionId}/ws`);
  });

  it("creates and tracks the session keyed by its id (AC#2)", async () => {
    const server = await startTestServer();
    const { sessionId } = (await (await register(server)).json()) as { sessionId: string };
    expect(server.sessions.size).toBe(1);
    const session = server.sessions.get(sessionId);
    expect(session).toBeDefined();
    expect(session?.id).toBe(sessionId);
    expect(session?.status).toBe("connecting");
    expect(session?.activity).toEqual({ kind: "idle" });
  });

  it("mints a fresh session id per registration", async () => {
    const a = await startTestServer();
    const b = await startTestServer();
    const idA = ((await (await register(a)).json()) as { sessionId: string }).sessionId;
    const idB = ((await (await register(b)).json()) as { sessionId: string }).sessionId;
    expect(idA).not.toBe(idB);
  });

  it("receives the account Bearer but never persists or echoes it (AC#3)", async () => {
    const server = await startTestServer();
    const res = await register(server, { authorization: `Bearer ${ACCOUNT_BEARER}` });
    expect(res.status).toBe(201);
    // The response never carries the credential back.
    expect(JSON.stringify(await res.json())).not.toContain(ACCOUNT_BEARER);
    // The persistable session snapshot is provably credential-free.
    const snapshot = JSON.stringify([...server.sessions.values()]);
    expect(snapshot).not.toContain(ACCOUNT_BEARER);
  });

  it("accepts a case-insensitive Bearer scheme (RFC 7235)", async () => {
    const server = await startTestServer();
    const res = await register(server, { authorization: `bearer ${ACCOUNT_BEARER}` });
    expect(res.status).toBe(201);
  });

  it("fails closed when the account Bearer is missing or malformed (AC#3)", async () => {
    const server = await startTestServer();
    expect((await register(server, { authorization: null })).status).toBe(401);
    expect((await register(server, { authorization: "Basic Zm9vOmJhcg==" })).status).toBe(401);
    expect((await register(server, { authorization: "Bearer " })).status).toBe(401);
    // No rejected attempt created a session.
    expect(server.sessions.size).toBe(0);
  });

  it("accepts one session only; a second register fails closed (AC#4)", async () => {
    const server = await startTestServer();
    expect((await register(server)).status).toBe(201);
    const second = await register(server);
    expect(second.status).toBe(409);
    expect(server.sessions.size).toBe(1);
  });

  it("fails closed on the wrong method or path (bridge-protocol §1)", async () => {
    const server = await startTestServer();
    const { host, port } = server.address;
    const wrongMethod = await fetch(sessionsUrl(server), {
      method: "GET",
      headers: { Authorization: `Bearer ${ACCOUNT_BEARER}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    const wrongPath = await fetch(`http://${host}:${port}/v1/code/nope`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCOUNT_BEARER}` },
    });
    expect(wrongPath.status).toBe(404);
  });
});
