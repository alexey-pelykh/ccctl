// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import {
  ENVIRONMENTS_BRIDGE_PATH,
  environmentWorkPollPath,
  SESSIONS_PATH,
  workAckPath,
  workStopPath,
  type WorkItem,
} from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

// The account OAuth Bearer, presented on §1/§2 (and §4). It must NEVER authorize the
// §3 work-poll leg and must never be persisted or echoed — the two-token boundary.
const ACCOUNT_BEARER = "oauth-account-secret-bridge";

// A short long-poll window so the empty-queue timeout test resolves quickly while the
// immediate-delivery and wake-up-on-enqueue tests still complete well within it.
const POLL_TIMEOUT_MS = 200;

const started: CcctlServer[] = [];

async function startTestServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST, workPollTimeoutMs: POLL_TIMEOUT_MS });
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

function base(server: CcctlServer): string {
  const { host, port } = server.address;
  return `http://${host}:${port}`;
}

const REGISTER_BODY = {
  machine_id: "machine-1",
  directory: "/home/dev/proj",
  branch: "main",
  repository: "owner/repo",
  max_sessions: 4,
};

const SESSION_BODY = {
  context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
  source: "ui",
  permission_mode: "default",
};

interface AuthBody {
  readonly authorization?: string | null;
  readonly body?: unknown;
}

function post(url: string, options: AuthBody): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.authorization != null) {
    headers.Authorization = options.authorization;
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) });
}

function registerEnvironment(server: CcctlServer, options: AuthBody = {}): Promise<Response> {
  const { authorization = `Bearer ${ACCOUNT_BEARER}`, body = REGISTER_BODY } = options;
  return post(`${base(server)}${ENVIRONMENTS_BRIDGE_PATH}`, { authorization, body });
}

function createSession(server: CcctlServer, options: AuthBody = {}): Promise<Response> {
  const { authorization = `Bearer ${ACCOUNT_BEARER}`, body = SESSION_BODY } = options;
  return post(`${base(server)}${SESSIONS_PATH}`, { authorization, body });
}

/** Register an environment and return its id + scoped work-poll token (the happy path). */
async function registeredEnvironment(server: CcctlServer): Promise<{ environmentId: string; token: string }> {
  const res = await registerEnvironment(server);
  expect(res.status).toBe(201);
  const wire = (await res.json()) as { environment_id: string; work_poll_token: string };
  return { environmentId: wire.environment_id, token: wire.work_poll_token };
}

function poll(server: CcctlServer, environmentId: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${base(server)}${environmentWorkPollPath(environmentId)}`, { method: "GET", headers });
}

async function pollWork(server: CcctlServer, environmentId: string, token: string): Promise<WorkItem[]> {
  const res = await poll(server, environmentId, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { work: WorkItem[] }).work;
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("§1 environment register — POST /v1/environments/bridge", () => {
  it("mints an environment id + a scoped work-poll token and records the environment (AC#1)", async () => {
    const server = await startTestServer();
    const res = await registerEnvironment(server);
    expect(res.status).toBe(201);
    const wire = (await res.json()) as { environment_id: string; work_poll_token: string };
    expect(wire.environment_id.length).toBeGreaterThan(0);
    expect(wire.work_poll_token.length).toBeGreaterThan(0);
    expect(server.environments.has(wire.environment_id)).toBe(true);
    // The scoped token is NOT the account Bearer (distinct credential classes).
    expect(wire.work_poll_token).not.toBe(ACCOUNT_BEARER);
  });

  it("receives the account Bearer but never persists or echoes it (AC#3)", async () => {
    const server = await startTestServer();
    const res = await registerEnvironment(server);
    expect(JSON.stringify(await res.json())).not.toContain(ACCOUNT_BEARER);
    const snapshot = JSON.stringify([...server.environments.values()]);
    expect(snapshot).not.toContain(ACCOUNT_BEARER);
  });

  it("fails closed without the account Bearer, on a malformed body, and on the wrong method (AC#3, AC#4)", async () => {
    const server = await startTestServer();
    expect((await registerEnvironment(server, { authorization: null })).status).toBe(401);
    expect((await registerEnvironment(server, { authorization: "Basic x" })).status).toBe(401);
    expect((await registerEnvironment(server, { body: { machine_id: "m" } })).status).toBe(400);
    expect((await registerEnvironment(server, { body: { ...REGISTER_BODY, max_sessions: 0 } })).status).toBe(400);
    const wrongMethod = await fetch(`${base(server)}${ENVIRONMENTS_BRIDGE_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ACCOUNT_BEARER}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(server.environments.size).toBe(0);
  });
});

describe("§2 session create — POST /v1/sessions", () => {
  it("creates a connecting session and returns { session_id, ws_url } pointing at this server (AC#1)", async () => {
    const server = await startTestServer();
    const res = await createSession(server);
    expect(res.status).toBe(201);
    const wire = (await res.json()) as { session_id: string; ws_url: string };
    expect(wire.session_id.length).toBeGreaterThan(0);
    const { host, port } = server.address;
    expect(wire.ws_url).toBe(`ws://${host}:${port}${SESSIONS_PATH}/${wire.session_id}/ws`);
    const session = server.sessions.get(wire.session_id);
    expect(session?.status).toBe("connecting");
    expect(session?.activity).toEqual({ kind: "idle" });
  });

  it("pins the exact snake_case wire body (ADR-001) with no camelCase leak", async () => {
    const server = await startTestServer();
    const raw = await (await createSession(server)).text();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["session_id", "ws_url"]);
    expect(parsed).not.toHaveProperty("sessionId");
    expect(parsed).not.toHaveProperty("wsUrl");
  });

  it("receives the account Bearer but never persists or echoes it (AC#3)", async () => {
    const server = await startTestServer();
    const res = await createSession(server);
    expect(JSON.stringify(await res.json())).not.toContain(ACCOUNT_BEARER);
    expect(JSON.stringify([...server.sessions.values()])).not.toContain(ACCOUNT_BEARER);
  });

  it("fails closed without the Bearer, on an unknown permission_mode (drift), and on a malformed body (AC#3, AC#4)", async () => {
    const server = await startTestServer();
    expect((await createSession(server, { authorization: null })).status).toBe(401);
    expect((await createSession(server, { body: { ...SESSION_BODY, permission_mode: "yolo" } })).status).toBe(400);
    expect((await createSession(server, { body: { source: "ui" } })).status).toBe(400);
    expect(server.sessions.size).toBe(0);
  });
});

describe("§3 work poll — GET /v1/environments/{env}/work/poll (scoped-token auth)", () => {
  it("delivers queued work immediately and moves it to in-flight; ack clears it (AC#2)", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);

    const userTurn: WorkItem = { kind: "user_turn", id: "w-1", payload: { text: "run the prompt" } };
    expect(server.enqueueWork(environmentId, userTurn)).toBe(true);

    const work = await pollWork(server, environmentId, token);
    expect(work).toEqual([userTurn]);
    // Delivered → in-flight, awaiting ack/stop.
    expect(server.environments.get(environmentId)?.inFlight.has("w-1")).toBe(true);

    const acked = await post(`${base(server)}${workAckPath(environmentId, "w-1")}`, {
      authorization: `Bearer ${token}`,
    });
    expect(acked.status).toBe(204);
    expect(server.environments.get(environmentId)?.inFlight.has("w-1")).toBe(false);
  });

  it("delivers each of the create_session / user_turn / steer kinds", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);
    const items: WorkItem[] = [
      { kind: "create_session", id: "c-1", payload: { source: "ui" } },
      { kind: "user_turn", id: "u-1", payload: { text: "hi" } },
      { kind: "steer", id: "s-1" },
    ];
    for (const item of items) {
      server.enqueueWork(environmentId, item);
    }
    expect(await pollWork(server, environmentId, token)).toEqual(items);
  });

  it("long-polls: a poll on an empty queue wakes up when work is enqueued (AC#2)", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);

    const inflight = poll(server, environmentId, token);
    await tick(20); // let the poll register its waiter before we enqueue.
    const steer: WorkItem = { kind: "steer", id: "s-9", payload: { text: "stop" } };
    server.enqueueWork(environmentId, steer);

    const res = await inflight;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { work: WorkItem[] }).work).toEqual([steer]);
  });

  it("long-polls: an empty queue answers an empty batch after the timeout window", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);
    const start = Date.now();
    const work = await pollWork(server, environmentId, token);
    expect(work).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(POLL_TIMEOUT_MS - 50);
  });

  it("settles a held long-poll on shutdown so close() does not hang (operability)", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);
    // Hold a poll open on an empty queue — it would otherwise stay held for the full window.
    const held = poll(server, environmentId, token);
    await tick(20); // let the poll register its waiter.

    // close() must resolve promptly (well under the poll window), not wait out the timeout.
    const start = Date.now();
    await server.close();
    expect(Date.now() - start).toBeLessThan(POLL_TIMEOUT_MS);
    // Already closed — drop it from the afterEach teardown to avoid a double close.
    started.splice(started.indexOf(server), 1);

    // The held poll completed with an empty batch rather than erroring or hanging.
    const res = await held;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { work: WorkItem[] }).work).toEqual([]);
  });

  it("is authorized ONLY by the scoped token — the account Bearer does not open it (AC#3, two-token boundary)", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);
    server.enqueueWork(environmentId, { kind: "steer", id: "s-1" });

    // The account Bearer is the WRONG credential for §3.
    expect((await poll(server, environmentId, ACCOUNT_BEARER)).status).toBe(401);
    // No credential at all.
    expect((await poll(server, environmentId, null)).status).toBe(401);
    // A wrong scoped token.
    expect((await poll(server, environmentId, "not-the-token")).status).toBe(401);
    // The correct scoped token works.
    expect((await poll(server, environmentId, token)).status).toBe(200);
  });

  it("fails closed on an unknown environment (404) and a version-drifted path (404)", async () => {
    const server = await startTestServer();
    const { token } = await registeredEnvironment(server);
    expect((await poll(server, "no-such-env", token)).status).toBe(404);
    // A drifted API version is not a work path → no route → 404 (fail closed on drift).
    const drifted = await fetch(`${base(server)}/v2/environments/env-1/work/poll`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(drifted.status).toBe(404);
  });

  it("stop clears in-flight work; ack/stop of unknown work is 404 and a wrong token is 401", async () => {
    const server = await startTestServer();
    const { environmentId, token } = await registeredEnvironment(server);
    server.enqueueWork(environmentId, { kind: "user_turn", id: "w-1" });
    await pollWork(server, environmentId, token); // → in-flight

    // Wrong token cannot stop it.
    expect(
      (
        await post(`${base(server)}${workStopPath(environmentId, "w-1")}`, {
          authorization: `Bearer ${ACCOUNT_BEARER}`,
        })
      ).status,
    ).toBe(401);
    // The scoped token stops it.
    expect(
      (await post(`${base(server)}${workStopPath(environmentId, "w-1")}`, { authorization: `Bearer ${token}` })).status,
    ).toBe(204);
    expect(server.environments.get(environmentId)?.inFlight.has("w-1")).toBe(false);
    // A second stop (nothing in flight) is 404.
    expect(
      (await post(`${base(server)}${workStopPath(environmentId, "w-1")}`, { authorization: `Bearer ${token}` })).status,
    ).toBe(404);
  });

  it("enqueueWork returns false for an unknown environment", async () => {
    const server = await startTestServer();
    expect(server.enqueueWork("no-such-env", { kind: "steer", id: "s-1" })).toBe(false);
  });
});
