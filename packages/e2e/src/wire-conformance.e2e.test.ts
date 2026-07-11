// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer } from "@ccctl/server";
import { assertServerSpeaksBridgeContract } from "./bridge-wire-conformance.js";

// The AC-2 wire-conformance gate (#124): assert the REAL @ccctl/server speaks the current
// environments-bridge contract face — register → session-create → work-poll, plus the
// two-token credential boundary — so a GREEN hermetic run implies interoperability, not
// just the harness's internal self-consistency. The expected wire shapes are pinned
// independently in `bridge-wire-conformance.ts`; here they are checked against the live
// server, so a server drift off the current face fails this gate on every run. Hermetic:
// loopback only, no patched worker or credentials.

const ACCOUNT_BEARER = "oauth-account-secret-wire-conformance";

// A short long-poll window: the flow enqueues before polling (immediate delivery), so this
// is only a safety net against an accidental empty poll hanging on the default 25 s hold.
const POLL_TIMEOUT_MS = 200;

const ccctlServers: CcctlServer[] = [];

async function startLocalServer(): Promise<CcctlServer> {
  const server = await startServer({ port: 0, host: DEFAULT_HOST, workPollTimeoutMs: POLL_TIMEOUT_MS });
  ccctlServers.push(server);
  return server;
}

afterEach(async () => {
  while (ccctlServers.length > 0) {
    await ccctlServers.pop()?.close();
  }
});

describe("ccctl e2e: the server speaks the current bridge-protocol contract face (#124)", () => {
  describe("Rule: a green hermetic run implies interoperability, not just internal consistency", () => {
    it("the real @ccctl/server conforms to the current register → session-create → work-poll face (AC-2)", async () => {
      const server = await startLocalServer();

      await expect(assertServerSpeaksBridgeContract(server, ACCOUNT_BEARER)).resolves.toBeUndefined();

      // Receiver-grounded corroboration: the assertion registered exactly one environment
      // and created exactly one session on the real server (the no-Bearer boundary probes
      // it also runs fail closed, so they leave no environment/session behind).
      expect(server.environments.size).toBe(1);
      expect(server.sessions.size).toBe(1);
    });
  });
});
