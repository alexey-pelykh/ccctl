// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import {
  ENVIRONMENTS_BRIDGE_PATH,
  environmentWorkPollPath,
  parseWorkSecret,
  SESSIONS_PATH,
  workItemFromValue,
  type WorkSecret,
} from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

// The account OAuth Bearer, presented on §1/§2 ONLY. The §3 work-poll leg carries NO
// credential (issue #130), and the account Bearer must never be persisted or echoed.
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
  machine_name: "dev-laptop",
  directory: "/home/dev/proj",
  branch: "main",
  git_repo_url: "https://github.com/owner/repo.git",
  max_sessions: 4,
  metadata: { worker_type: "claude_code" },
};

const SESSION_BODY = {
  session_context: { model: "claude-opus-4-8", cwd: "/home/dev/proj" },
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

/** Register an environment and return its id (the happy path — 200, no work-poll token, #130/#154). */
async function registeredEnvironment(server: CcctlServer): Promise<string> {
  const res = await registerEnvironment(server);
  expect(res.status).toBe(200);
  return ((await res.json()) as { environment_id: string }).environment_id;
}

/** Create a session and return its id (the §2 response is `{ session_id }`, no ws_url). */
async function createdSession(server: CcctlServer): Promise<string> {
  const res = await createSession(server);
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

/** GET the §3 work-poll — carrying an OPTIONAL authorization header (ignored by the leg). */
function poll(server: CcctlServer, environmentId: string, authorization: string | null = null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (authorization !== null) {
    headers.Authorization = authorization;
  }
  return fetch(`${base(server)}${environmentWorkPollPath(environmentId)}`, { method: "GET", headers });
}

/** Decode a work item's `secret` (base64url(JSON(WorkSecret))) into a validated WorkSecret, or null. */
function decodeSecret(secret: string): WorkSecret | null {
  try {
    return parseWorkSecret(JSON.parse(Buffer.from(secret, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("§1 environment register — POST /v1/environments/bridge", () => {
  it("mints an environment id and records the environment — no work-poll token (#130)", async () => {
    const server = await startTestServer();
    const res = await registerEnvironment(server);
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(wire)).toEqual(["environment_id"]);
    expect(typeof wire.environment_id).toBe("string");
    expect((wire.environment_id as string).length).toBeGreaterThan(0);
    expect(server.environments.has(wire.environment_id as string)).toBe(true);
    // There is no scoped work-poll token on the response any more.
    expect(wire).not.toHaveProperty("work_poll_token");
  });

  it("answers 200, NOT 201 — the observed worker rejects a non-200 register (#154)", async () => {
    // Regression: `handleEnvironmentRegister` used to answer 201, which the worker
    // rejects as `Registration: Failed with status 201`, breaking its handshake.
    const server = await startTestServer();
    const res = await registerEnvironment(server);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(201);
  });

  it("receives the account Bearer but never persists or echoes it", async () => {
    const server = await startTestServer();
    const res = await registerEnvironment(server);
    expect(JSON.stringify(await res.json())).not.toContain(ACCOUNT_BEARER);
    const snapshot = JSON.stringify([...server.environments.values()]);
    expect(snapshot).not.toContain(ACCOUNT_BEARER);
  });

  it("fails closed without the account Bearer, on a malformed body, and on the wrong method", async () => {
    const server = await startTestServer();
    expect((await registerEnvironment(server, { authorization: null })).status).toBe(401);
    expect((await registerEnvironment(server, { authorization: "Basic x" })).status).toBe(401);
    // A body still using the superseded machine_id / required-repository shape fails closed.
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
  it("creates a connecting session and returns { session_id } with NO ws_url (#130)", async () => {
    const server = await startTestServer();
    const res = await createSession(server);
    expect(res.status).toBe(201);
    const wire = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(wire)).toEqual(["session_id"]);
    expect((wire.session_id as string).length).toBeGreaterThan(0);
    expect(wire).not.toHaveProperty("ws_url");
    const session = server.sessions.get(wire.session_id as string);
    expect(session?.status).toBe("connecting");
    expect(session?.activity).toEqual({ kind: "idle" });
  });

  it("pins the exact snake_case wire body (ADR-001) with no camelCase leak", async () => {
    const server = await startTestServer();
    const raw = await (await createSession(server)).text();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["session_id"]);
    expect(parsed).not.toHaveProperty("sessionId");
  });

  it("receives the account Bearer but never persists or echoes it (and the minted secret is not it)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    const res = await createSession(server);
    expect(JSON.stringify(await res.json())).not.toContain(ACCOUNT_BEARER);
    expect(JSON.stringify([...server.sessions.values()])).not.toContain(ACCOUNT_BEARER);
    // The auto-enqueued work item's minted secret must not be the account Bearer either.
    const item = workItemFromValue(await (await poll(server, environmentId)).json());
    expect(item).not.toBeNull();
    expect(item?.secret).not.toContain(ACCOUNT_BEARER);
    expect(decodeSecret(item?.secret ?? "")?.session_ingress_token).not.toBe(ACCOUNT_BEARER);
  });

  it("fails closed without the Bearer, on an unknown permission_mode (drift), and on a malformed body", async () => {
    const server = await startTestServer();
    expect((await createSession(server, { authorization: null })).status).toBe(401);
    expect((await createSession(server, { body: { ...SESSION_BODY, permission_mode: "yolo" } })).status).toBe(400);
    expect((await createSession(server, { body: { source: "ui" } })).status).toBe(400);
    expect(server.sessions.size).toBe(0);
  });
});

describe("§3 work poll — GET /v1/environments/{env}/work/poll (uncredentialed, single item)", () => {
  it("delivers the session-create-enqueued work item as a SINGLE object with a decodable secret (#130)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    const sessionId = await createdSession(server); // §2→§3 auto-enqueue

    const res = await poll(server, environmentId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    // A single item object, NOT a { work: [...] } envelope.
    expect(body).not.toHaveProperty("work");
    const item = workItemFromValue(body);
    expect(item).not.toBeNull();
    expect(item?.data).toEqual({ type: "session", id: sessionId });
    expect((item?.id ?? "").length).toBeGreaterThan(0);

    // secret = base64url(JSON(WorkSecret)) with BOTH inner fields load-bearing.
    const secret = decodeSecret(item?.secret ?? "");
    expect(secret).not.toBeNull();
    expect(secret?.version).toBe(1);
    expect((secret?.session_ingress_token ?? "").length).toBeGreaterThan(0);
    expect(secret?.api_base_url).toBe(base(server));
  });

  it("carries NO credential — an uncredentialed poll is served (the two-credential boundary, #130)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    await createdSession(server);
    // No Authorization header at all → 200 (the real worker presents none).
    expect((await poll(server, environmentId)).status).toBe(200);
    // Presenting the account Bearer on §3 is neither required nor rejected — it is ignored.
    await createdSession(server);
    expect((await poll(server, environmentId, `Bearer ${ACCOUNT_BEARER}`)).status).toBe(200);
  });

  it("long-polls: a poll on an empty queue wakes up when a session-create enqueues work", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);

    const inflight = poll(server, environmentId);
    await tick(20); // let the poll register its waiter before we enqueue.
    const sessionId = await createdSession(server);

    const res = await inflight;
    expect(res.status).toBe(200);
    const item = workItemFromValue(await res.json());
    expect(item?.data).toEqual({ type: "session", id: sessionId });
  });

  it("long-polls: an empty queue answers a 200 with an empty body after the timeout window", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    const start = Date.now();
    const res = await poll(server, environmentId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // empty body = "no work" (no envelope).
    expect(Date.now() - start).toBeGreaterThanOrEqual(POLL_TIMEOUT_MS - 50);
  });

  it("settles a held long-poll on shutdown so close() does not hang (operability)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    // Hold a poll open on an empty queue — it would otherwise stay held for the full window.
    const held = poll(server, environmentId);
    await tick(20); // let the poll register its waiter.

    // close() must resolve promptly (well under the poll window), not wait out the timeout.
    const start = Date.now();
    await server.close();
    expect(Date.now() - start).toBeLessThan(POLL_TIMEOUT_MS);
    // Already closed — drop it from the afterEach teardown to avoid a double close.
    started.splice(started.indexOf(server), 1);

    // The held poll completed with an empty body rather than erroring or hanging.
    const res = await held;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("fails closed on an unknown environment (404) and a version-drifted path (404)", async () => {
    const server = await startTestServer();
    await registeredEnvironment(server);
    expect((await poll(server, "no-such-env")).status).toBe(404);
    // A drifted API version is not a work path → no route → 404 (fail closed on drift).
    const drifted = await fetch(`${base(server)}/v2/environments/env-1/work/poll`, { method: "GET" });
    expect(drifted.status).toBe(404);
  });

  it("rejects the wrong method on the work-poll path (405)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    const res = await fetch(`${base(server)}${environmentWorkPollPath(environmentId)}`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("§3 work-item lifecycle — POST /v1/environments/{env}/work/{workId}/{ack,heartbeat,stop} (#154)", () => {
  /** Build a work-item lifecycle URL for an environment + work id + verb. */
  function lifecycleUrl(server: CcctlServer, environmentId: string, workId: string, verb: string): string {
    return `${base(server)}/v1/environments/${environmentId}/work/${workId}/${verb}`;
  }

  it("acknowledges the delivered item's ack, heartbeat, and stop with 200 (no more 404)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    await createdSession(server); // §2→§3 auto-enqueue
    // Poll to learn the real delivered work id, then drive each of its lifecycle verbs.
    const item = workItemFromValue(await (await poll(server, environmentId)).json());
    expect(item).not.toBeNull();
    const workId = item?.id ?? "";
    for (const verb of ["ack", "heartbeat", "stop"]) {
      const res = await post(lifecycleUrl(server, environmentId, workId, verb), { authorization: null });
      expect(res.status).toBe(200);
    }
  });

  it("carries NO credential and does not track work ids post-delivery — a fresh id is acked too", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    // A never-polled work id is accepted (delivery already dequeued; the reclaim model
    // tracks no in-flight item), and no Authorization header is required (like the §3 poll).
    for (const verb of ["ack", "heartbeat", "stop"]) {
      const res = await post(lifecycleUrl(server, environmentId, "work-xyz", verb), { authorization: null });
      expect(res.status).toBe(200);
    }
  });

  it("fails closed on an unknown environment (404) and the wrong method (405)", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    // Unknown environment → 404 (fail closed, like the poll).
    expect((await post(lifecycleUrl(server, "no-such-env", "w-1", "ack"), { authorization: null })).status).toBe(404);
    // Wrong method (GET) on each lifecycle path → 405.
    for (const verb of ["ack", "heartbeat", "stop"]) {
      const res = await fetch(lifecycleUrl(server, environmentId, "w-1", verb), { method: "GET" });
      expect(res.status).toBe(405);
    }
  });

  it("does not shadow the §3 work-poll path — poll (6 segments) still delivers, lifecycle (7) is separate", async () => {
    const server = await startTestServer();
    const environmentId = await registeredEnvironment(server);
    const sessionId = await createdSession(server);
    const item = workItemFromValue(await (await poll(server, environmentId)).json());
    expect(item?.data).toEqual({ type: "session", id: sessionId });
    // An unknown verb under the 7-segment shape is not a lifecycle route → no route → 404.
    const unknownVerb = await fetch(lifecycleUrl(server, environmentId, item?.id ?? "w", "resume"), { method: "POST" });
    expect(unknownVerb.status).toBe(404);
  });
});
