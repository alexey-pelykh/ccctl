// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { ENVIRONMENTS_BRIDGE_PATH, environmentWorkPollPath, SESSIONS_PATH, type LogEvent } from "@ccctl/core";
import { DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";

// The structured-log trail (#61) driven through the REAL server over the bridge flow (§1 register →
// §2 create → §3 work-poll), with a capturing sink injected via `config.logger`. Two things are proven
// here that the unit suites (session-close / pending-launch / core `logging.test.ts`) cannot:
//
//   1. COVERAGE — the registration legs actually EMIT their structured events through the live handlers.
//   2. REDACTION BY CONSTRUCTION, observationally — the §1/§2 legs present a DISTINCTIVE account Bearer
//      and the §2 leg mints a session-ingress token (delivered on §3). Neither appears in ANY emitted
//      log line. The compile-time proof (`LogEventJsonProofs`) forbids the Bearer a field; this is the
//      runtime witness that the SHAPE carries no credential, targeted at exactly the legs where the
//      credentials are present. Complements the e2e bearer canary (full lifecycle) with a focused,
//      in-package redaction check on the registration trail.

// A distinctive account Bearer so a hit in the logs is unambiguously the presented credential, not
// incidental noise — presented on §1/§2 only.
const CANARY_BEARER = "ccctl-account-bearer-CANARY-never-log-61";

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

const started: CcctlServer[] = [];

/** A capturing sink plus its serialized-line view — the needle-grep surface for the redaction check. */
function captureLogger(): { logger: { log: (event: LogEvent) => void }; events: LogEvent[]; serialized: () => string } {
  const events: LogEvent[] = [];
  return {
    logger: { log: (event) => events.push(event) },
    events,
    serialized: () => events.map((event) => JSON.stringify(event)).join("\n"),
  };
}

async function startCapturingServer(): Promise<{ server: CcctlServer; events: LogEvent[]; serialized: () => string }> {
  const { logger, events, serialized } = captureLogger();
  const server = await startServer({ port: 0, host: DEFAULT_HOST, workPollTimeoutMs: 200, logger });
  started.push(server);
  return { server, events, serialized };
}

function base(server: CcctlServer): string {
  const { host, port } = server.address;
  return `http://${host}:${port}`;
}

function postJson(url: string, authorization: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization !== null) {
    headers.Authorization = authorization;
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Drive §1 register → §2 create → §3 work-poll, returning the delivered work item's encoded secret. */
async function driveRegistrationFlow(server: CcctlServer): Promise<string> {
  const register = await postJson(
    `${base(server)}${ENVIRONMENTS_BRIDGE_PATH}`,
    `Bearer ${CANARY_BEARER}`,
    REGISTER_BODY,
  );
  expect(register.status).toBe(200);
  const environmentId = ((await register.json()) as { environment_id: string }).environment_id;

  const create = await postJson(`${base(server)}${SESSIONS_PATH}`, `Bearer ${CANARY_BEARER}`, SESSION_BODY);
  expect(create.status).toBe(201);

  const poll = await fetch(`${base(server)}${environmentWorkPollPath(environmentId)}`, { method: "GET" });
  expect(poll.status).toBe(200);
  const item = (await poll.json()) as { secret: string };
  return item.secret;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

describe("structured logging over the bridge flow (#61)", () => {
  describe("Rule: the registration legs emit structured events through the live handlers", () => {
    it("emits environment-registered (§1), session-created (§2), and work-delivered (§3)", async () => {
      const { server, events } = await startCapturingServer();

      await driveRegistrationFlow(server);

      const registration = events.filter((event) => event.category === "registration");
      expect(registration.map((event) => event.event)).toEqual([
        "environment-registered",
        "session-created",
        "work-delivered",
      ]);
      // Every registration event carries the environment id, and §2/§3 name the session.
      expect(registration.every((event) => event.category === "registration" && event.environmentId.length > 0)).toBe(
        true,
      );
      const workDelivered = registration.find((event) => event.event === "work-delivered");
      expect(workDelivered).toMatchObject({ category: "registration", sessionId: expect.any(String) });
    });
  });

  describe("Rule: redaction by construction — no credential ever reaches a log line", () => {
    it("finds neither the account Bearer nor the session-ingress token in any emitted event", async () => {
      const { server, events, serialized } = await startCapturingServer();

      const secret = await driveRegistrationFlow(server);
      // Extract the REAL session-ingress token the run minted + delivered on §3 — the second needle.
      const workSecret = JSON.parse(Buffer.from(secret, "base64url").toString("utf8")) as {
        session_ingress_token: string;
      };
      const ingressToken = workSecret.session_ingress_token;

      // Non-vacuous: the run genuinely produced events, presented a non-empty Bearer, and minted a
      // non-empty ingress token — so the greps below are against a real trail, not an empty subject.
      expect(events.length).toBeGreaterThan(0);
      expect(CANARY_BEARER.length).toBeGreaterThan(0);
      expect(ingressToken.length).toBeGreaterThan(0);

      const logs = serialized();
      expect(logs).not.toContain(CANARY_BEARER);
      expect(logs).not.toContain(ingressToken);
      // Also never the encoded work secret itself (which base64url-wraps the token).
      expect(logs).not.toContain(secret);
    });
  });
});

describe("structured logging — error refusals at boot (#61)", () => {
  // Rule: a daemon that refuses to start emits an ERROR event naming why — the error category, on the
  // boot path where no session exists yet (sessionId: null).
  it("emits a `bind-refused` error event when a non-loopback bind is refused (#58)", async () => {
    const events: LogEvent[] = [];
    await expect(
      startServer({ port: 0, host: "0.0.0.0", logger: { log: (event) => events.push(event) } }),
    ).rejects.toThrow();
    expect(events).toContainEqual(
      expect.objectContaining({ category: "error", event: "bind-refused", sessionId: null }),
    );
  });

  it("emits a `boot-rejected` error event when maxSessions is not a positive integer (#36)", async () => {
    const events: LogEvent[] = [];
    await expect(
      startServer({
        port: 0,
        host: DEFAULT_HOST,
        maxSessions: Number.NaN,
        logger: { log: (event) => events.push(event) },
      }),
    ).rejects.toThrow();
    expect(events).toContainEqual(
      expect.objectContaining({ category: "error", event: "boot-rejected", sessionId: null }),
    );
  });
});
