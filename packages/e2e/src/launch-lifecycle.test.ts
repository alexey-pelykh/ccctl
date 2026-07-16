// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type CcctlServer, type ISessionLauncher } from "@ccctl/server";
import { launchRequest } from "@ccctl/web-ui/src/launch.js";
import { createSession, registerEnvironment } from "./bridge-wire-conformance.js";
import { BORN_STATUS, createRecordingLauncher, LAUNCH_REGISTRATION_TIMEOUT_MS } from "./launch-tunnel.js";

// The UC2 LAUNCH LIFECYCLE over LOOPBACK (#66) — the hermetic skeleton the fenced tunnel oracle
// (`launch-tunnel-flow.e2e.test.ts`) graduates to a real tailnet, in the posture every other oracle in
// this package already holds: `multi-session-harness` (#20) is the loopback skeleton #65's tunnel
// oracle graduates, and `one-session-harness` is the one #133's live-worker oracle graduates.
//
// It exists because the fenced oracle's whole judgment rests on ONE composition that, before this
// file, was proven NOWHERE: launch → listed from birth → the launched worker's §2 registration CLAIMS
// the launch → the row advances IN PLACE under the SAME id. `pending-launch.test.ts` pins
// `claimPendingLaunch` as a PURE FUNCTION, called directly; `web-ui-launch-flow.test.ts` pins the
// launch and the born row. Neither drives the claim over the REAL HTTP legs, so nothing pinned that a
// `POST /api/sessions` followed by a `POST /v1/sessions` at the launched cwd actually yields the
// launch's own id.
//
// That gap is what makes this a SELF-GUARD rather than a duplicate — the `probeStandInLiveness` (#134)
// posture the package already uses: prove the composition works when nothing is in the way, so that a
// fenced `drift` reads as "the tunnel leg broke it" rather than "the harness was never right". Without
// it, a harness bug (a §2 body whose cwd never reaches the correlation; a cwd canonicalized in the
// wrong dialect) would surface as a FALSE `drift` against a faithful daemon — and only on an
// operator's tailnet, where nobody is watching CI.
//
// Hermetic and credential-free: loopback only, a FAKE launcher (no tmux / pty spawns), a stand-in
// worker registration, NO tunnel and no claim about one — so it gates on EVERY `test` run, exactly as
// `web-ui-launch-flow.test.ts` and `bridge-wire-conformance.test.ts` do. AC3 (the real tailnet) is the
// one thing it deliberately says nothing about; that is the fenced oracle's job, and faking a tunnel
// here to claim it would be the circular fixture #131 removed.

const ACCOUNT_BEARER = "oauth-account-secret-launch-lifecycle";

const started: CcctlServer[] = [];
const tempDirs: string[] = [];

async function serve(launcher: ISessionLauncher): Promise<CcctlServer> {
  const server = await startServer({
    port: 0,
    launcher,
    // Matches the fenced oracle's own configuration, so the skeleton exercises the same window.
    registrationTimeoutMs: LAUNCH_REGISTRATION_TIMEOUT_MS,
  });
  started.push(server);
  return server;
}

/**
 * A fresh, canonical directory — the same shape (and the same `realpathSync.native` dialect) the
 * fenced drive mints its launch cwd in, since that dialect is exactly what the claim key turns on.
 */
async function freshCanonicalCwd(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ccctl-lifecycle-")));
  tempDirs.push(dir);
  return dir;
}

function origin(server: CcctlServer): string {
  return `http://${server.address.host}:${server.address.port}`;
}

/** Launch exactly as the phone does — the body is whatever the REAL browser module built. */
async function launch(server: CcctlServer, cwd: string): Promise<{ status: number; sessionId: string }> {
  const res = await fetch(`${origin(server)}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(launchRequest({ cwd, project: "skeleton", initialPrompt: "seed" })),
  });
  const body = (await res.json()) as { sessionId?: string };
  return { status: res.status, sessionId: body.sessionId ?? "" };
}

/** The operator's own view — `GET /api/sessions`, the list AC2's "appears in the list" is about. */
async function listSessions(server: CcctlServer): Promise<Array<{ id: string; status: string }>> {
  const res = await fetch(`${origin(server)}/api/sessions`);
  return ((await res.json()) as { sessions: Array<{ id: string; status: string }> }).sessions;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() ?? "", { recursive: true, force: true }).catch(() => {});
  }
});

describe("the UC2 launch lifecycle the tunnel oracle drives (#66) — over loopback", () => {
  it("launches the phone's own request: the daemon's launcher runs with exactly what the phone sent", async () => {
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();

    const { status } = await launch(server, cwd);

    expect(status).toBe(201);
    // Receiver-grounded, and the pin under the oracle's AC1 intent comparison: launching at an
    // ALREADY-CANONICAL cwd means the ingress's `resolveLaunchCwd` hands the launcher back the very
    // path the phone sent — so an exact comparison is sound rather than forgiving.
    expect(recorder.launched()).toEqual([
      { cwd, permissionMode: "default", project: "skeleton", initialPrompt: "seed" },
    ]);
  });

  it(`lists the launched session FROM BIRTH as \`${BORN_STATUS}\`, before any worker has registered`, async () => {
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();

    const { sessionId } = await launch(server, cwd);
    const sessions = await listSessions(server);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(sessionId);
    expect(sessions[0]?.status).toBe(BORN_STATUS);
  });

  it("CLAIMS the launch when its worker registers at the launched cwd: the §2 leg answers the LAUNCH'S OWN id", async () => {
    // THE pin the whole fenced oracle rests on. A claim that misses is not an error — it silently
    // mints a fresh id and answers 201 either way, so nothing but the id tells the two apart. This is
    // also the pin under `createSession`'s `cwd` override: without it reaching the correlation, the
    // oracle would read a faithful daemon as `drift`, and only ever on an operator's tailnet.
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();

    const { sessionId: launchedId } = await launch(server, cwd);
    await registerEnvironment(server, ACCOUNT_BEARER);
    const { sessionId: registeredId } = await createSession(server, ACCOUNT_BEARER, cwd);

    expect(registeredId).toBe(launchedId);
  });

  it("ADVANCES the launched row in place: same id, no longer `registering`, and NO second row beside it", async () => {
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();

    const { sessionId: launchedId } = await launch(server, cwd);
    await registerEnvironment(server, ACCOUNT_BEARER);
    await createSession(server, ACCOUNT_BEARER, cwd);
    const sessions = await listSessions(server);

    // The phone's own independent read of the claim — the oracle asserts exactly this over the tunnel.
    expect(sessions.map((entry) => entry.id)).toEqual([launchedId]);
    expect(sessions[0]?.status).not.toBe(BORN_STATUS);
  });

  it("does NOT claim a registration from a DIFFERENT directory — that is a UC1 attach, and it mints its own id", async () => {
    // The negative control that makes the positive non-vacuous: if the daemon claimed ANY
    // registration regardless of cwd, the id-continuity pin above would pass for the wrong reason,
    // and the oracle's AC2 verdict would be meaningless. It must be the CORRELATION that claims.
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();
    const elsewhere = await freshCanonicalCwd();

    const { sessionId: launchedId } = await launch(server, cwd);
    await registerEnvironment(server, ACCOUNT_BEARER);
    const { sessionId: attachedId } = await createSession(server, ACCOUNT_BEARER, elsewhere);

    expect(attachedId).not.toBe(launchedId);
    // Two rows now: the still-`registering` launch, and the UC1 attach that minted its own id.
    const sessions = await listSessions(server);
    expect(sessions.map((entry) => entry.id).sort()).toEqual([launchedId, attachedId].sort());
    expect(sessions.find((entry) => entry.id === launchedId)?.status).toBe(BORN_STATUS);
  });

  it("leaves the pinned §2 body untouched when no cwd override is passed — the golden's own run is unperturbed", async () => {
    // `createSession`'s override is additive: every existing caller passes two arguments and must keep
    // POSTing the pinned `/e2e/proj` fixture, which exists nowhere and can therefore claim nothing.
    const recorder = createRecordingLauncher();
    const server = await serve(recorder.launcher);
    const cwd = await freshCanonicalCwd();

    const { sessionId: launchedId } = await launch(server, cwd);
    await registerEnvironment(server, ACCOUNT_BEARER);
    const { sessionId } = await createSession(server, ACCOUNT_BEARER);

    expect(sessionId).not.toBe(launchedId);
  });
});
