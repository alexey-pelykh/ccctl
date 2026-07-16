// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SESSIONS_PATH } from "@ccctl/core";
import { DEFAULT_HOST, DEFAULT_MAX_SESSIONS, startServer, type CcctlServer, type ServerConfig } from "./index.js";
import {
  isLaunchFailureCode,
  LAUNCH_FAILURE_CODES,
  SessionLaunchError,
  type ISessionLauncher,
  type LaunchedSession,
  type SessionLaunchOptions,
  type SurfaceLiveness,
} from "./session-launcher.js";

// The "New session" launch path (#31) and its failure handling (#33), exercised END TO END through
// the wired server: a real HTTP `POST /api/sessions` (routing + handler + launcher wiring + the
// `registering` session it registers + teardown), plus the programmatic `CcctlServer.launchSession`.
// The launcher is a recording FAKE — no tmux / pty is spawned. The launched worker's own registration
// (§2) ships in `ccctl-patch` and is proven end-to-end by the fenced live-worker oracle; here it is
// DRIVEN directly against the bridge leg, which is exactly what a real worker does.

/** Two REAL directories — the launch pre-flight (#33) rejects a cwd that does not exist, so a test cwd must. */
const CWD = process.cwd();
const OTHER_CWD = tmpdir();
/** A path that certainly does not exist — the Gherkin's "invalid working directory". */
const MISSING_CWD = join(tmpdir(), "ccctl-does-not-exist-3f2a9c1b");

/**
 * A REAL symlinked directory — the operator's spelling of a cwd, next to the resolved one the WORKER
 * will report. The two are what the claim has to reconcile (#33): `CWD` above is `process.cwd()`,
 * which is already canonical, so a claim test written against it can pass while the correlation is
 * broken for every symlinked, trailing-slashed, or `/tmp` path an operator actually types. This
 * fixture is the one that bites — and each test asserts the two spellings really differ before
 * relying on them, so it can never silently degenerate into comparing a string with itself.
 */
let fixtureRoot = "";
let LINKED_CWD = "";
let RESOLVED_CWD = "";

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "ccctl-launch-"));
  const target = join(fixtureRoot, "target");
  mkdirSync(target);
  LINKED_CWD = join(fixtureRoot, "link");
  symlinkSync(target, LINKED_CWD, "dir");
  RESOLVED_CWD = realpathSync(LINKED_CWD);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * A recording fake launcher: resolves with a tagged handle, remembers launches, counts closes.
 *
 * Every handle it hands out reports the launcher's CURRENT `liveness` reading, which a test can flip
 * at any time (`launcher.liveness = "taken-over"`) — that is how "the operator attached to it AFTER it
 * was launched" is expressed, which is the whole hazard #35 addresses. Defaults to
 * `alive-server-owned`: an ordinary launched surface nobody has touched, which teardown may reap.
 */
function fakeLauncher({ hint = "tmux attach -t ccctl:1", attachable = true, launchDelayMs = 0 } = {}) {
  const launches: SessionLaunchOptions[] = [];
  let closes = 0;
  const state = { liveness: "alive-server-owned" as SurfaceLiveness };
  const launcher: ISessionLauncher = {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launches.push(options);
      // `launchDelayMs` models how long a REAL backend takes to bring a surface up — tmux shells out,
      // the pty forks — and defaults to 0 because no other test needs it. The cap's concurrency test
      // (#36) does, and cannot be written without it: a launcher that resolves in a MICROTASK lets each
      // request run to its registry write before the next is dequeued, so a burst against a
      // zero-delay fake serializes itself and the check-then-act window never opens. The race that
      // fake hides is real on both backends — so a delay here is the honest fake, not a contrived one.
      if (launchDelayMs > 0) {
        await sleep(launchDelayMs);
      }
      return {
        attachment: { attachable, hint },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve(state.liveness),
        close: (): Promise<void> => {
          closes += 1;
          return Promise.resolve();
        },
      };
    },
  };
  return {
    launcher,
    launches,
    closeCount: (): number => closes,
    /** Flip what every handle from this launcher reports — e.g. the operator just took the session over. */
    setLiveness: (liveness: SurfaceLiveness): void => {
      state.liveness = liveness;
    },
  };
}

/** A launcher that always rejects with `error` — the "no surface could be brought up" family (#33). */
function failingLauncher(error: unknown): ISessionLauncher {
  return { launch: (): Promise<LaunchedSession> => Promise.reject(error) };
}

const started: CcctlServer[] = [];

async function startTestServer(config: ServerConfig): Promise<CcctlServer> {
  const server = await startServer(config);
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

function base(server: CcctlServer): string {
  return `http://${server.address.host}:${server.address.port}`;
}

function postLaunch(server: CcctlServer, body: unknown): Promise<Response> {
  return fetch(`${base(server)}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The sessions `GET /api/sessions` currently lists — the operator's own view, the AC's yardstick. */
async function listSessions(server: CcctlServer): Promise<Array<{ id: string; status: string }>> {
  const res = await fetch(`${base(server)}/api/sessions`);
  const body = (await res.json()) as { sessions: Array<{ id: string; status: string }> };
  return body.sessions;
}

/**
 * Drive the §2 registration a launched worker performs — `POST /v1/sessions` with the account
 * Bearer, rooted at the cwd it was launched at and under the mode it was launched with. That pair is
 * what the server matches the registration to its pending launch on (#33).
 */
function registerWorker(server: CcctlServer, cwd: string, permissionMode = "default"): Promise<Response> {
  return fetch(`${base(server)}${SESSIONS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer acct-token" },
    body: JSON.stringify({
      session_context: { model: "claude-opus-4-8", cwd },
      source: "ui",
      permission_mode: permissionMode,
    }),
  });
}

/** Await roughly `ms` of real time — the eviction timers are real one-shots, as in the #173 suite. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("POST /api/sessions (launch)", () => {
  it("launches via the injected launcher and answers 201 with the session id and surface attachment", async () => {
    const { launcher, launches } = fakeLauncher({ hint: "tmux attach -t ccctl:2", attachable: true });
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string; attachable: boolean; hint: string };
    // The id is minted at LAUNCH (#33) — it addresses the `registering` row the launch just created.
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body).toMatchObject({ attachable: true, hint: "tmux attach -t ccctl:2" });
    expect(launches).toHaveLength(1);
  });

  it("surfaces a DEGRADED attachment when the backend that launched is a fallback", async () => {
    const { launcher } = fakeLauncher({ hint: "owned pty: attach is degraded", attachable: false });
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ attachable: false, hint: "owned pty: attach is degraded" });
  });

  it("passes permissionMode, project and initialPrompt through verbatim — and the RESOLVED cwd", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await postLaunch(server, { cwd: LINKED_CWD, permissionMode: "plan", project: "atlas", initialPrompt: "go" });

    // Everything the operator sent reaches the backend as sent — except the cwd, which reaches it
    // RESOLVED (#33). That is not incidental normalization: the worker in that terminal reports its own
    // `getcwd(3)` when it registers, and that report is matched against the cwd this launch recorded —
    // so rooting the terminal at the operator's spelling instead would break the correlation and let
    // the eviction timer reap a live session.
    expect(launches[0]).toEqual({ cwd: RESOLVED_CWD, permissionMode: "plan", project: "atlas", initialPrompt: "go" });
  });

  it("omits project and initialPrompt when the body does not carry them", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    // A prompting mode (`plan`) — a non-prompting one is refused on launch (SRV-C-003 launch half),
    // so this test uses a launchable mode; its point is that the OPTIONALS are omitted when absent.
    await postLaunch(server, { cwd: CWD, permissionMode: "plan" });

    expect(launches[0]).toEqual({ cwd: CWD, permissionMode: "plan" });
    expect(launches[0]).not.toHaveProperty("project");
    expect(launches[0]).not.toHaveProperty("initialPrompt");
  });

  it("fails closed 501 `launcher-absent` when the server has no launcher configured", async () => {
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "launcher-absent", error: expect.stringContaining("ccctl:") });
  });

  it("fails closed 400 `malformed-request` on a malformed body — and does not launch", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    for (const body of [
      { cwd: CWD, permissionMode: "root" },
      { permissionMode: "default" },
      { cwd: "", permissionMode: "default" },
      { cwd: CWD, permissionMode: "default", project: 7 },
      "not json",
    ]) {
      const res = await postLaunch(server, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "malformed-request" });
    }
    expect(launches).toHaveLength(0);
  });

  // SRV-C-003, launch half (#32): a UC2 launch is remotely driven, so the launched session must run
  // under a PROMPTING mode — one that blocks on a decision and can raise the "awaiting input" signal.
  // A non-prompting mode is refused at the ingress (400, never launched); a prompting mode launches.
  it("fails closed 400 `non-prompting-mode` on acceptEdits / bypassPermissions — and does not launch", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    for (const permissionMode of ["acceptEdits", "bypassPermissions"] as const) {
      const res = await postLaunch(server, { cwd: CWD, permissionMode });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "non-prompting-mode" });
    }
    // A non-prompting launch never reaches the launcher — no degraded session is born.
    expect(launches).toHaveLength(0);
  });

  it("launches (201) under every PROMPTING permission-mode — default and plan — so it does not over-refuse", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    for (const permissionMode of ["default", "plan"] as const) {
      const res = await postLaunch(server, { cwd: CWD, permissionMode });
      expect(res.status).toBe(201);
    }
    expect(launches.map((l) => l.permissionMode)).toEqual(["default", "plan"]);
  });

  it("still LISTS on GET /api/sessions — the launch POST does not shadow the list", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await fetch(`${base(server)}/api/sessions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});

// #33 AC1 + AC2 — "A launch that fails to spawn surfaces a TYPED error to the UI", and "a failed
// launch leaves no half-registered ghost session behind". Each scenario asserts BOTH halves: the
// typed code on the wire, and that the registry is untouched.
describe("POST /api/sessions — a failed launch is typed, and leaves nothing behind (#33)", () => {
  // Gherkin: "Launch with an invalid working directory" → a typed launch-failure error is surfaced
  // to the UI, and no session appears in the session list.
  it("answers a typed 400 `invalid-cwd` for a working directory that does not exist — and lists no session", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: MISSING_CWD, permissionMode: "default" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("invalid-cwd");
    // The message names the offending path back at the operator, so a typo is visible at a glance.
    expect(body.error).toContain(MISSING_CWD);
    // Pre-flight: nothing was ever spawned, so nothing can be left behind.
    expect(launches).toHaveLength(0);
    expect(await listSessions(server)).toEqual([]);
  });

  it("answers a typed 400 `invalid-cwd` when the cwd exists but is a FILE, not a directory", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    // This very test file: it exists, `stat` succeeds — but a session cannot be rooted at it.
    const res = await postLaunch(server, { cwd: join(CWD, "package.json"), permissionMode: "default" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-cwd" });
    expect(launches).toHaveLength(0);
  });

  // Gherkin: "Launch when the terminal backend is unavailable" → a typed launch-failure error is
  // surfaced to the UI, and no half-registered session remains.
  it("answers a typed 502 `backend-unavailable` when every backend rejects — and leaves no half-registered session", async () => {
    const launcher = failingLauncher(
      new SessionLaunchError("backend-unavailable", "ccctl: no session-launcher backend could launch a session"),
    );
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "backend-unavailable" });
    // No half-registered session: the registry is written only AFTER a surface actually came up.
    expect(await listSessions(server)).toEqual([]);
  });

  it("answers a typed 502 `worker-not-found` when the backend could not run the patched binary", async () => {
    const launcher = failingLauncher(
      new SessionLaunchError("worker-not-found", "ccctl: could not run `claude` — no such executable"),
    );
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "worker-not-found" });
    expect(await listSessions(server)).toEqual([]);
  });

  // The catch-all is honest, not a dumping ground: a backend that throws something the server cannot
  // NAME must still fail closed with a code from the pinned set — never an invented one, and never a
  // foreign errno (`ENOENT` carries a string `code` too, and must not be mistaken for a launch code).
  it("answers a typed 502 `spawn-failed` for an UNTYPED backend throw — including a bare errno", async () => {
    for (const thrown of [new Error("boom"), Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })]) {
      const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher: failingLauncher(thrown) });

      const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: "spawn-failed" });
      expect(await listSessions(server)).toEqual([]);
    }
  });
});

// #36 — the maxSessions cap. A phone-side loop must not be able to spawn unbounded terminals, so a
// launch past the cap is REFUSED with a typed `at-capacity` (rather than spawning an Nth window and
// hoping). Every test here fills the cap through a REAL path — a launch, or a §2 registration — and
// then asserts the refusal, so none of them can pass against a cap counting the wrong set.
describe("the maxSessions cap (#36)", () => {
  /** Launch `n` sessions that all SUCCEED, asserting each one as it goes — the cap's "below" side. */
  async function fillByLaunching(server: CcctlServer, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
      expect(res.status).toBe(201);
    }
  }

  it("launches while BELOW the cap — including the cap-th launch itself", async () => {
    const { launcher, launches } = fakeLauncher();
    // A long registration timeout: these sessions must stay `registering` (and so keep holding their
    // slots) for the whole test, or an eviction would free one behind our back and hide an off-by-one.
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 3,
      registrationTimeoutMs: 60_000,
    });

    // The boundary from below: the 3rd launch is AT the cap and must still succeed — the cap is the
    // number of sessions allowed, not the number after which one is refused.
    await fillByLaunching(server, 3);

    expect(launches).toHaveLength(3);
    expect(server.sessions.size).toBe(3);
  });

  it("refuses the launch PAST the cap with a typed `at-capacity` — and spawns nothing", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 2,
      registrationTimeoutMs: 60_000,
    });
    await fillByLaunching(server, 2);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    // Typed, and surfaced to the UI: the machine-readable `code` a UI branches on, plus the human
    // sentence every ccctl failure carries. The status is 429 — the request is well-formed and the
    // server REFUSES it by policy (like `non-prompting-mode`, a 4xx), not a host that could not
    // bring a surface up (502).
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "at-capacity", error: expect.stringContaining("ccctl:") });
    // The refusal is a REFUSAL, not a failed attempt: the guard runs before the launcher, so no third
    // terminal was spawned and no ghost row was left behind (#33's invariant, held by the new branch).
    expect(launches).toHaveLength(2);
    expect(server.sessions.size).toBe(2);
    expect(await listSessions(server)).toHaveLength(2);
  });

  it("names the cap and the count in the refusal, so the operator knows WHY and by how much", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 2,
      registrationTimeoutMs: 60_000,
    });
    await fillByLaunching(server, 2);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    // The operator cannot act on "at capacity" alone — the number is what tells them the cap is 2
    // rather than the 8 they assumed, and that raising it (or closing one) is the move.
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/2 sessions are live and the cap is 2/);
  });

  it("stays truthful when live sessions EXCEED the cap — attaching is not a launch, and is not refused", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, maxSessions: 2 });

    // Three UC1 attaches against a cap of 2, all accepted. The cap governs LAUNCHING — the verb this
    // server initiates and can decline. A §2 registration announces a session that ALREADY EXISTS;
    // refusing it would un-spawn nothing and would only blind the list to a terminal that is running.
    // So `live > cap` is a REACHABLE, legitimate state, not a bookkeeping error.
    for (const cwd of [CWD, OTHER_CWD, RESOLVED_CWD]) {
      expect((await registerWorker(server, cwd)).status).toBe(201);
    }
    expect(server.sessions.size).toBe(3);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    // The refusal still fires (`>=`, not `===` — an overflow must not read as "room available")...
    expect(res.status).toBe(429);
    expect(launches).toHaveLength(0);
    // ...and the sentence still reads as the truth rather than as a server that lost count: the
    // earlier phrasing rendered this exact state as "3 of 2 session slots are in use".
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/3 sessions are live and the cap is 2/);
    expect(error).not.toMatch(/3 of 2/);
  });

  it("frees a slot when a session ENDS, and the next launch succeeds again", async () => {
    const { launcher } = fakeLauncher();
    // A short registration timeout is how a session ENDS here: these launches never register, so the
    // ghost-reaper (#33) evicts them — a real end-of-session path, driven rather than simulated.
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 1,
      registrationTimeoutMs: 40,
    });
    await fillByLaunching(server, 1);

    // At the cap: refused.
    expect((await postLaunch(server, { cwd: CWD, permissionMode: "default" })).status).toBe(429);

    // The session ends (its worker never checked in, so it is reaped) — the slot is freed.
    await sleep(120);
    expect(server.sessions.size).toBe(0);

    // ...and the next launch succeeds again. This is the whole point of counting LIVE sessions rather
    // than launches-ever: a cap that counted cumulative launches would still refuse here, forever.
    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    expect(res.status).toBe(201);
  });

  it("counts ATTACHED sessions too — a cap filled by UC1 registrations refuses a launch", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, maxSessions: 2 });

    // Two UC1 ATTACH sessions: workers registering over §2 from a cwd NO launch is pending on, so each
    // mints its own id (`environments-bridge.ts`) — nothing here was launched by this server. This is
    // the test that discriminates: a cap counting only `launchedSurfaces` or only `pendingLaunches`
    // passes every other test in this file and fails this one.
    expect((await registerWorker(server, OTHER_CWD)).status).toBe(201);
    expect((await registerWorker(server, CWD)).status).toBe(201);
    expect(server.sessions.size).toBe(2);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "at-capacity" });
    expect(launches).toHaveLength(0);
  });

  it("defaults the cap to 8 — the 8th launch succeeds, the 9th is refused", async () => {
    const { launcher } = fakeLauncher();
    // No `maxSessions` — this asserts the DEFAULT, which is the half of AC4 a configured test cannot
    // reach. The exported constant is checked below; here the wired server's own behavior is the yardstick.
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    await fillByLaunching(server, DEFAULT_MAX_SESSIONS);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "at-capacity" });
    expect(server.sessions.size).toBe(8);
  });

  it("pins the default at 8 — the constant a caller names instead of re-hardcoding it", () => {
    expect(DEFAULT_MAX_SESSIONS).toBe(8);
  });

  it("is CONFIG-overridable — a cap of 1 refuses the second launch", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 1,
      registrationTimeoutMs: 60_000,
    });
    await fillByLaunching(server, 1);

    // Overriding DOWN is what proves the config is read at all: an implementation that ignored
    // `maxSessions` and always used the default would still pass a test that raised the cap.
    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "at-capacity" });
  });

  it("reads as English at a cap of one — `1 session is live`, not `1 sessions are live`", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 1,
      registrationTimeoutMs: 60_000,
    });
    await fillByLaunching(server, 1);

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    // A cap of 1 is the one an operator actually sets when they want a single session at a time, so
    // the singular is the reachable case rather than a pedantic one.
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/1 session is live and the cap is 1/);
  });

  it("keeps `at-capacity` in the pinned code set, so a client can narrow it structurally", () => {
    // The set is what `isLaunchFailureCode` fails closed on — the CLI (`session-client.ts`) narrows a
    // daemon's `code` through it, so a code missing here is a code the client silently discards.
    expect(LAUNCH_FAILURE_CODES).toContain("at-capacity");
    expect(isLaunchFailureCode("at-capacity")).toBe(true);
  });

  // The cap's whole purpose is to bound a LOOP, and a loop is concurrent — the phone does not await
  // one launch before firing the next, and a replaying tunnel least of all. A cap that holds only for
  // a sequential caller would satisfy every scenario above and still let the hazard through, so the
  // burst is tested directly. These need a launcher with a REAL delay: a zero-delay fake resolves in a
  // microtask, which serializes the burst and hides the window entirely (see `fakeLauncher`).
  describe("under CONCURRENT launches — the loop it exists to bound", () => {
    it("admits exactly `maxSessions` from a simultaneous burst, and refuses the rest", async () => {
      const { launcher, launches } = fakeLauncher({ launchDelayMs: 20 });
      const server = await startTestServer({
        port: 0,
        host: DEFAULT_HOST,
        launcher,
        maxSessions: 2,
        registrationTimeoutMs: 60_000,
      });

      // Eight at once against a cap of 2 — none awaits another, so all eight read the count before any
      // of them has a registry row. Slots must be taken BEFORE the launcher is awaited or every one of
      // them passes the guard.
      const statuses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postLaunch(server, { cwd: CWD, permissionMode: "default" }).then((res) => res.status),
        ),
      );

      expect(statuses.filter((s) => s === 201)).toHaveLength(2);
      expect(statuses.filter((s) => s === 429)).toHaveLength(6);
      // The one that actually matters: a refused launch must never have SPAWNED. Terminals are the
      // resource being protected — six extra 429s on the wire would be cold comfort next to six extra
      // windows on the operator's desk.
      expect(launches).toHaveLength(2);
      expect(server.sessions.size).toBe(2);
    });

    it("bounds a burst at the DEFAULT cap — 40 at once yields 8 terminals, not 40", async () => {
      const { launcher, launches } = fakeLauncher({ launchDelayMs: 20 });
      const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

      // The measured breach, pinned as a regression: before slots were reserved across the launcher's
      // await, this exact burst spawned 40 terminals against a cap of 8 — every request 201.
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () =>
          postLaunch(server, { cwd: CWD, permissionMode: "default" }).then((res) => res.status),
        ),
      );

      expect(launches).toHaveLength(DEFAULT_MAX_SESSIONS);
      expect(statuses.filter((s) => s === 201)).toHaveLength(DEFAULT_MAX_SESSIONS);
      expect(statuses.filter((s) => s === 429)).toHaveLength(32);
      expect(server.sessions.size).toBe(DEFAULT_MAX_SESSIONS);
    });

    it("gives an in-flight slot BACK when the launch fails — a failed burst does not wedge the cap", async () => {
      // Reserving a slot must not leak it: if a failed launch kept its reservation, a server that had
      // merely failed a few launches would refuse forever with nothing live — the cap would become a
      // one-way ratchet rather than a ceiling.
      const server = await startTestServer({
        port: 0,
        host: DEFAULT_HOST,
        launcher: failingLauncher(new SessionLaunchError("spawn-failed", "ccctl: no")),
        maxSessions: 2,
      });

      const failed = await Promise.all(
        Array.from({ length: 6 }, () =>
          postLaunch(server, { cwd: CWD, permissionMode: "default" }).then((res) => res.status),
        ),
      );

      // ALL SIX failed (502) — and that is precisely the proof the slots came back. Six launches
      // against a cap of 2: if a failed launch kept its reservation, the first two would consume the
      // cap and the rest would come back 429 `at-capacity` instead of reaching the launcher at all.
      // Every one reaching the launcher means every one found a free slot.
      expect(failed).toEqual([502, 502, 502, 502, 502, 502]);
      // ...and nothing was left behind — no rows (#33's no-ghost invariant, which the reservation
      // must not weaken: it is not the registry, so a failure writes none).
      expect(server.sessions.size).toBe(0);
    });
  });

  // A cap is a SAFETY control, so a value that cannot bound anything must be refused at the door
  // rather than accepted and silently not enforced. `NaN` is the sharp one: `live >= NaN` is always
  // false, so a NaN cap disables the guard completely — and `Number(process.env.CCCTL_MAX_SESSIONS)`
  // is exactly how an embedder would wire the config-overridability the AC asks for.
  describe("a cap that cannot bound anything is refused at boot", () => {
    it("REJECTS a maxSessions that is not a positive integer — NaN above all", async () => {
      const { launcher } = fakeLauncher();

      for (const maxSessions of [Number.NaN, 0, -1, 2.5, Number.POSITIVE_INFINITY]) {
        await expect(startServer({ port: 0, host: DEFAULT_HOST, launcher, maxSessions })).rejects.toThrow(
          /maxSessions must be a positive integer/,
        );
      }
    });

    it("names the offending value, so the operator can see what their config resolved to", async () => {
      const { launcher } = fakeLauncher();

      // `NaN` is invisible in a config file — it is what a bad `Number(…)` PRODUCED. Echoing it back is
      // what turns "the daemon won't start" into "my env var is unset".
      await expect(startServer({ port: 0, host: DEFAULT_HOST, launcher, maxSessions: Number.NaN })).rejects.toThrow(
        /NaN/,
      );
    });

    it("accepts an absent maxSessions — the default applies, and the server starts", async () => {
      const { launcher } = fakeLauncher();

      // The guard must not over-refuse: `undefined` is not a bad value, it is no value.
      const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

      expect(server.address.port).toBeGreaterThan(0);
    });
  });
});

// #33 AC3 — "A session that enters `registering` but never completes registration within the timeout
// is evicted". The launched session is VISIBLE while it comes up, then either claimed or reaped.
describe("the registering session, and its eviction (#33)", () => {
  it("lists the launched session as `registering` — visible from launch, before its worker checks in", async () => {
    const { launcher } = fakeLauncher();
    // A long timeout: this test is about the state BEFORE eviction, so eviction must not race it.
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const res = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // It is in the list immediately, and it is honestly marked as not-yet-live.
    expect(await listSessions(server)).toEqual([expect.objectContaining({ id: sessionId, status: "registering" })]);
  });

  // Gherkin: "The launched process never registers" → when the registration timeout elapses, the
  // registering session is evicted, and the session list no longer shows it.
  it("evicts the registering session once the registration timeout elapses — and CLOSES its terminal", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });

    await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    // It is there, registering — the worker just never registers.
    expect(await listSessions(server)).toHaveLength(1);
    expect(closeCount()).toBe(0);

    await sleep(TIMEOUT_MS * 4);

    // "the session list no longer shows it" — the ghost is gone…
    expect(await listSessions(server)).toEqual([]);
    // …and, critically, so is the process it left running: the terminal was reaped, not orphaned.
    expect(closeCount()).toBe(1);
  });

  it("evicts EACH stuck launch independently — one ghost's eviction does not disturb another launch", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });

    await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    await postLaunch(server, { cwd: OTHER_CWD, permissionMode: "default" });
    expect(await listSessions(server)).toHaveLength(2);

    await sleep(TIMEOUT_MS * 4);

    expect(await listSessions(server)).toEqual([]);
    expect(closeCount()).toBe(2);
  });

  // The converse of the eviction AC, and the reason the claim exists at all: a session that DID
  // register must NEVER be evicted — that would close a LIVE session's terminal out from under it.
  it("a worker's registration CLAIMS its pending launch — same id, one row, and no eviction", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });

    const launched = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };

    // The launched worker checks in over the bridge, rooted where it was launched.
    const registered = await registerWorker(server, CWD, "default");
    expect(registered.status).toBe(201);
    // The registration REUSES the launch's id — the row advances in place rather than duplicating.
    expect(await registered.json()).toEqual({ session_id: sessionId });

    const afterRegister = await listSessions(server);
    expect(afterRegister).toEqual([expect.objectContaining({ id: sessionId, status: "connecting" })]);

    // Past the timeout the claimed session is STILL there — the eviction timer was disarmed, so the
    // live session's terminal was never closed.
    await sleep(TIMEOUT_MS * 4);

    expect(await listSessions(server)).toEqual([expect.objectContaining({ id: sessionId, status: "connecting" })]);
    expect(closeCount()).toBe(0);
  });

  // The claim test above launches at `process.cwd()`, which is ALREADY canonical — so it would pass
  // even if the server compared raw strings. This is the same scenario with the one difference that
  // makes it real: an operator's cwd whose spelling is not the one the worker will report back.
  it("claims a launch made through a SYMLINKED cwd — the worker reports its RESOLVED `getcwd(3)`", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, launches, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });
    expect(RESOLVED_CWD).not.toBe(LINKED_CWD); // the fixture is only meaningful if the spellings differ

    const launched = await postLaunch(server, { cwd: LINKED_CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };
    // The terminal is rooted at the RESOLVED path, so what the worker reports is what the server
    // launched at — the two sides of the correlation speak one dialect.
    expect(launches[0]?.cwd).toBe(RESOLVED_CWD);

    // The worker checks in with the cwd the OS hands it — always fully resolved, never the operator's
    // symlink spelling. A server that stored the raw string misses here, and the miss is not benign:
    // the eviction timer stays armed and reaps a session that is very much alive.
    const registered = await registerWorker(server, RESOLVED_CWD, "default");
    expect(await registered.json()).toEqual({ session_id: sessionId });

    await sleep(TIMEOUT_MS * 4);

    expect(await listSessions(server)).toEqual([expect.objectContaining({ id: sessionId, status: "connecting" })]);
    expect(closeCount()).toBe(0); // the live session's terminal was never closed
  });

  // Two launches in one directory under one mode: the (cwd, mode) key cannot say which terminal a
  // registration came from. The server must not GUESS — a wrong id would steer the operator into the
  // other conversation (#20). What it must still do is disarm a timer per registration, or a live
  // worker gets reaped as a ghost.
  it("refuses to guess between two launches sharing a cwd+mode — fresh ids, and no live terminal reaped", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });

    const first = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const second = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId: firstId } = (await first.json()) as { sessionId: string };
    const { sessionId: secondId } = (await second.json()) as { sessionId: string };
    expect(await listSessions(server)).toHaveLength(2);

    // Both workers check in. Neither may be handed a launch's id: the pair identifies neither launch,
    // so reusing one is a coin flip against a terminal it may not be running in.
    const registeredA = await registerWorker(server, CWD, "default");
    const registeredB = await registerWorker(server, CWD, "default");
    const { session_id: idA } = (await registeredA.json()) as { session_id: string };
    const { session_id: idB } = (await registeredB.json()) as { session_id: string };

    expect([firstId, secondId]).not.toContain(idA);
    expect([firstId, secondId]).not.toContain(idB);
    expect(idA).not.toBe(idB);

    // Both placeholder rows were retired (nothing would ever advance them), leaving exactly the two
    // live sessions — no ghost row, and no duplicate.
    const listed = await listSessions(server);
    expect(listed).toHaveLength(2);
    expect(listed.every((session) => session.status === "connecting")).toBe(true);

    // And the safety property both registrations bought: each consumed one pending launch, so no
    // eviction timer survives to close a terminal a live worker is sitting in.
    await sleep(TIMEOUT_MS * 4);

    expect(await listSessions(server)).toHaveLength(2);
    expect(closeCount()).toBe(0);
  });

  // The interleaving a 2-launch / 2-registration test cannot reach: only ONE of the two workers comes
  // up. The claim consumes a record but cannot know WHICH launch registered — so neither terminal can
  // be proven dead, and a per-launch eviction would close the live worker's terminal half the time.
  it("evicts the stale row of a half-registered ambiguous pair WITHOUT closing either terminal", async () => {
    const TIMEOUT_MS = 40;
    const { launcher, closeCount } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      registrationTimeoutMs: TIMEOUT_MS,
    });

    await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    await postLaunch(server, { cwd: CWD, permissionMode: "default" });

    // Exactly one worker registers — the other launch's `claude` died on boot. Which is which is
    // precisely what the wire cannot say.
    const registered = await registerWorker(server, CWD, "default");
    const { session_id: liveId } = (await registered.json()) as { session_id: string };

    await sleep(TIMEOUT_MS * 4);

    // AC3 holds on the LIST — every stale `registering` row is gone, leaving only the live session…
    expect(await listSessions(server)).toEqual([expect.objectContaining({ id: liveId, status: "connecting" })]);
    // …and NO terminal was closed. The live worker is in one of those two, and the server will not
    // gamble on which: the stray window is left to shutdown rather than risk killing the session.
    expect(closeCount()).toBe(0);
  });

  // A `registering` session is IN the registry (that is the point — the operator watches it come up),
  // which means the §4 worker channel's "unknown session" 404 does not catch it. It must fail closed
  // anyway: the id was minted server-side and handed to the OPERATOR, never to a worker, and the
  // session is still evictable — a channel opened on it would outlive its own session.
  it("fails closed on the §4 worker channel for a session that has not registered over the bridge", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const launched = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };

    const res = await fetch(`${base(server)}/v1/code/sessions/${sessionId}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("has not registered over the bridge yet") as unknown as string,
    });
  });

  // `register` is the only leg that can CREATE a channel, but the whole §4 surface is closed to a
  // `registering` session — a heartbeat or a state-restore answering 200 for a session no worker can
  // legitimately be holding would undercut the very argument the register-409 rests on.
  it("fails closed on EVERY §4 leg for a session that has not registered — not just `register`", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const launched = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };
    const worker = `${base(server)}/v1/code/sessions/${sessionId}/worker`;

    const heartbeat = await fetch(`${worker}/heartbeat`, { method: "POST", body: "{}" });
    const restore = await fetch(worker, { method: "GET" });

    expect(heartbeat.status).toBe(409);
    expect(restore.status).toBe(409);
  });

  // The operator-facing half of the same new state, and a path they can actually walk into: the
  // `registering` row IS listed, so it can be selected in the web UI and steered inside the eviction
  // window. It has no worker channel, so the steer must fail closed rather than throw or hang.
  it("fails closed on a STEER of a session that has not registered — it has no worker channel yet", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const launched = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };
    expect(await listSessions(server)).toEqual([expect.objectContaining({ id: sessionId, status: "registering" })]);

    const res = await fetch(`${base(server)}/api/sessions/${sessionId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subtype: "interrupt" }),
    });

    expect(res.status).toBe(409);
  });

  it("a registration that matches NO launch mints its own session (a UC1 attach is untouched)", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const launched = await postLaunch(server, { cwd: CWD, permissionMode: "default" });
    const { sessionId } = (await launched.json()) as { sessionId: string };

    // An ATTACHED worker: a different cwd, so it is not this launch's worker.
    const registered = await registerWorker(server, OTHER_CWD, "default");
    const { session_id: attachedId } = (await registered.json()) as { session_id: string };

    expect(attachedId).not.toBe(sessionId);
    // Two distinct sessions: the launch still registering, the attach connecting. The attach did not
    // steal the launch's identity, and the launch's eviction timer is still armed for its own ghost.
    expect(await listSessions(server)).toEqual([
      expect.objectContaining({ id: sessionId, status: "registering" }),
      expect.objectContaining({ id: attachedId, status: "connecting" }),
    ]);
  });
});

describe("CcctlServer.launchSession (programmatic)", () => {
  it("launches, tracks, and returns the minted session id with the handle", async () => {
    const { launcher, launches } = fakeLauncher({ hint: "tmux attach -t ccctl:9" });
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });

    const { sessionId, launched } = await server.launchSession({ cwd: CWD, permissionMode: "default" });

    expect(launched.attachment.hint).toBe("tmux attach -t ccctl:9");
    expect(launches).toHaveLength(1);
    // The programmatic path registers the `registering` session too — it cannot leave a ghost the
    // HTTP path would have tracked (both entry points share one core).
    expect(server.sessions.get(sessionId)?.status).toBe("registering");
  });

  it("rejects a typed `launcher-absent` when no launcher is configured", async () => {
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST });

    await expect(server.launchSession({ cwd: CWD, permissionMode: "default" })).rejects.toMatchObject({
      code: "launcher-absent",
    });
  });

  it("rejects a typed `non-prompting-mode` — the launch-half invariant holds for the programmatic caller too", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await expect(server.launchSession({ cwd: CWD, permissionMode: "acceptEdits" })).rejects.toMatchObject({
      code: "non-prompting-mode",
    });
    // The shared core refuses BEFORE touching the launcher — no degraded session is born.
    expect(launches).toHaveLength(0);
  });

  it("rejects a typed `invalid-cwd` — the pre-flight holds for the programmatic caller too", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await expect(server.launchSession({ cwd: MISSING_CWD, permissionMode: "default" })).rejects.toMatchObject({
      code: "invalid-cwd",
    });
    expect(launches).toHaveLength(0);
    expect(server.sessions.size).toBe(0);
  });

  it("rejects a typed `at-capacity` — the cap holds for the programmatic caller too (#36)", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({
      port: 0,
      host: DEFAULT_HOST,
      launcher,
      maxSessions: 1,
      registrationTimeoutMs: 60_000,
    });
    await server.launchSession({ cwd: CWD, permissionMode: "default" });

    // The cap lives in the SHARED core, not the HTTP handler — so it cannot be walked around by
    // calling the programmatic entry point, which is exactly the loop #36 exists to bound.
    await expect(server.launchSession({ cwd: CWD, permissionMode: "default" })).rejects.toMatchObject({
      code: "at-capacity",
    });
    expect(launches).toHaveLength(1);
    expect(server.sessions.size).toBe(1);
  });

  it("tears down every launched terminal on close() — including one still registering", async () => {
    const { launcher, closeCount } = fakeLauncher();
    // Untracked (not via startTestServer): this test owns close() itself, so afterEach must not
    // double-close it (a second httpServer.close rejects). A long timeout so the terminals are torn
    // down by SHUTDOWN, not by an eviction that raced it.
    const server = await startServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });
    await server.launchSession({ cwd: CWD, permissionMode: "default" });
    await server.launchSession({ cwd: OTHER_CWD, permissionMode: "default" });

    expect(closeCount()).toBe(0);
    await server.close();
    expect(closeCount()).toBe(2);
  });

  // Rule: A taken-over session is not killed — WIRED THROUGH shutdown (#35 AC2).
  //
  // The rule itself is pinned hermetically in `session-release.test.ts`; this proves the daemon's
  // shutdown path actually GOES through it. Without the wiring, `session-release.ts` is a correct
  // rule nothing consults, and shutdown still kills the operator's session.
  it("does NOT kill a session the operator took over, on close() (#35)", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });
    await server.launchSession({ cwd: CWD, permissionMode: "default" });
    // The operator sat down at their desk, attached to the surface, and is now driving it by hand.
    setLiveness("taken-over");

    await server.close();

    // ccctl exited without it. The operator keeps working.
    expect(closeCount()).toBe(0);
  });

  it("does NOT kill a surface whose liveness could not be read, on close() (#35 AC5)", async () => {
    const { launcher, closeCount, setLiveness } = fakeLauncher();
    const server = await startServer({ port: 0, host: DEFAULT_HOST, launcher, registrationTimeoutMs: 60_000 });
    await server.launchSession({ cwd: CWD, permissionMode: "default" });
    // The backend cannot see its own surface (tmux went away mid-shutdown). A leaked terminal is the
    // accepted cost; killing something that might be the operator's is not.
    setLiveness("host-unreachable");

    await server.close();

    expect(closeCount()).toBe(0);
  });
});
