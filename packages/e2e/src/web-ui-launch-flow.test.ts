// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, XDG_STATE_HOME_ENV, type CcctlServer } from "@ccctl/server";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "@ccctl/server/src/session-launcher.js";
import { describeLaunchAccepted, launchFailure, launchRequest } from "@ccctl/web-ui/src/launch.js";
import { autoResolvesPermissions, sessionLabel } from "@ccctl/web-ui/src/sessions.js";

// The "New session" launch flow (#37, `UI-B-004`) driven END TO END: the REAL browser module
// (`@ccctl/web-ui/src/launch.js`) against the REAL wired server ingress (`POST /api/sessions`, #31)
// and its REAL typed-failure branches (#33/#36). The launcher is a FAKE — no tmux / pty is spawned —
// so this needs no live worker and runs on every `test`, exactly as `bridge-wire-conformance.test.ts`
// drives the shape gate without one.
//
// This spec exists because `launch.js` MIRRORS the server's contract rather than importing it (the
// module is served to the browser unbundled, so it must stay dependency-free). A mirror is only as
// good as what pins it, and a web-ui unit test CANNOT pin one: it would assert the module's copy of
// the contract against a hand-written fixture in the same package — a tautology w.r.t. the very
// drift it names, green on both sides the day the server changes. Here the yardstick is the server
// ITSELF. If the ingress renames a field, restatuses a failure, or stops carrying a code this spec
// drives, this fails; the unit tests cannot. What nothing here pins is the SET's MEMBERSHIP, and
// that is deliberate rather than a gap: the reader passes any code through verbatim, so a ninth
// `LaunchFailureCode` needs no UI change — gating on the set would be the stale-and-gates-nothing
// copy `launch.js` exists without.
//
// The sibling to it in the other direction is `one-session-flow.e2e.test.ts`, which drives
// `transcript.js` / `command.js` against a live patched worker.

/** A recording fake launcher: resolves with a tagged handle and remembers what it was asked to launch. */
function fakeLauncher({ attachable = true, hint = "tmux attach -t ccctl:1" } = {}) {
  const launches: SessionLaunchOptions[] = [];
  const launcher: ISessionLauncher = {
    async launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launches.push(options);
      return {
        attachment: { attachable, hint },
        liveness: async () => "alive-server-owned",
        close: async () => {},
      };
    },
  };
  return { launcher, launches };
}

/**
 * A disposable directory THIS FILE's `AskUserQuestion` hook installs are routed to, via
 * `XDG_STATE_HOME` (#262) — mirrors `ui-session-launch.test.ts`'s own fixture. Every `postLaunch()`
 * call below drives a REAL `POST /api/sessions` through the REAL, wired `launchSession`, which
 * installs a REAL hook (synchronous, best-effort, never mocked out); without this override every run
 * of this suite would write settings/handoff files under the developer's own
 * `~/.local/state/ccctl/hooks`.
 */
let hookStateRoot = "";
let previousXdgStateHome: string | undefined;

beforeAll(() => {
  hookStateRoot = mkdtempSync(join(tmpdir(), "ccctl-hook-state-"));
  previousXdgStateHome = process.env[XDG_STATE_HOME_ENV];
  process.env[XDG_STATE_HOME_ENV] = hookStateRoot;
});

afterAll(() => {
  if (previousXdgStateHome === undefined) {
    Reflect.deleteProperty(process.env, XDG_STATE_HOME_ENV);
  } else {
    process.env[XDG_STATE_HOME_ENV] = previousXdgStateHome;
  }
  rmSync(hookStateRoot, { recursive: true, force: true });
});

const started: CcctlServer[] = [];

async function serve(config: Parameters<typeof startServer>[0]): Promise<CcctlServer> {
  const server = await startServer(config);
  started.push(server);
  return server;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.close();
  }
});

function origin(server: CcctlServer): string {
  return `http://${server.address.host}:${server.address.port}`;
}

/** POST a launch exactly as the browser does — the body is whatever the REAL `launchRequest` built. */
function postLaunch(server: CcctlServer, body: unknown): Promise<Response> {
  return fetch(`${origin(server)}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The picker's own view — `GET /api/sessions`, the list #37 AC2's "appears in the list" is about. */
async function listSessions(server: CcctlServer): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${origin(server)}/api/sessions`);
  return ((await res.json()) as { sessions: Array<Record<string, unknown>> }).sessions;
}

describe("the New session control's launch body (#37 AC1)", () => {
  it("is accepted by the REAL ingress — the mirrored request shape is faithful", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    // Exactly what the form hands `launchRequest`: raw, untrimmed DOM values.
    const request = launchRequest({ cwd: `  ${process.cwd()}  `, project: " checkout ", initialPrompt: " ship it " });
    const res = await postLaunch(server, request);

    expect(res.status).toBe(201);
    // The server's own parse accepted every field, trimmed, and passed them to the launcher — so the
    // browser's optional prompt + working directory/project really do reach the launch.
    expect(launches).toEqual([
      {
        cwd: process.cwd(),
        permissionMode: "default",
        project: "checkout",
        initialPrompt: "ship it",
        // The `AskUserQuestion` hook install (#262) wires a REAL, per-launch settings file under
        // `hookStateRoot` above — a real path, not a fixture, so only its type is pinned here.
        settingsPath: expect.any(String) as unknown as string,
      },
    ]);
  });

  it("launches with the pinned mode — a real end-to-end 201 through the live ingress", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    // The pin (`default`) is accepted by the real ingress and launches end-to-end. ADR-007 removed
    // the mode refusal, so the server now accepts every mode; this still pins that the UI's own
    // launch body round-trips to a 201 against a live server.
    const res = await postLaunch(server, launchRequest({ cwd: process.cwd() }));

    expect(res.status).toBe(201);
  });

  it("omits a blank optional in a way the REAL parse reads as absent, not as an empty value", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    await postLaunch(server, launchRequest({ cwd: process.cwd(), project: "   ", initialPrompt: "" }));

    expect(launches[0]).toEqual({
      cwd: process.cwd(),
      permissionMode: "default",
      settingsPath: expect.any(String) as unknown as string,
    });
  });
});

describe("the launched session appears in the list (#37 AC2)", () => {
  it("is listed as `registering` from birth, keyed by the id the 201 minted, and renders as a picker row", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    const res = await postLaunch(server, launchRequest({ cwd: process.cwd() }));
    const accepted = await res.json();

    // The REAL 201 body, read by the REAL accept-reader the status line shows.
    expect(describeLaunchAccepted(accepted)).toBe(
      `launched ${(accepted as { sessionId: string }).sessionId} — tmux attach -t ccctl:1`,
    );

    // AC2's yardstick: the operator's own list.
    const sessions = await listSessions(server);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe((accepted as { sessionId: string }).sessionId);
    expect(sessions[0].status).toBe("registering");
    // …and it renders through the REAL picker, rather than merely existing on the wire: a row the
    // list could not label would satisfy "is in the response" while failing "appears in the list".
    expect(sessionLabel(sessions[0])).toBe(`${(accepted as { sessionId: string }).sessionId} — registering · idle`);
    // A `default` launch is prompting, so it does not auto-resolve permissions — no spurious badge (#27).
    expect(autoResolvesPermissions(sessions[0])).toBe(false);
  });

  it("surfaces a degraded surface's own note — the fallback backend is not dressed up as tmux", async () => {
    const { launcher } = fakeLauncher({ attachable: false, hint: "owned pty — cannot be attached to" });
    const server = await serve({ port: 0, launcher });

    const accepted = await (await postLaunch(server, launchRequest({ cwd: process.cwd() }))).json();

    expect(describeLaunchAccepted(accepted)).toContain("owned pty — cannot be attached to");
  });
});

describe("a launch failure surfaces the TYPED error (#37 AC3)", () => {
  it("reads `invalid-cwd` off the REAL 400, with the server's path-echoing sentence", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });
    const missing = join(tmpdir(), "ccctl-does-not-exist-3f2a9c1b");

    const res = await postLaunch(server, launchRequest({ cwd: missing }));
    const failure = launchFailure(res.status, await res.json());

    expect(res.status).toBe(400);
    expect(failure.code).toBe("invalid-cwd");
    // The sentence is the SERVER's, echoing the path the operator typed — never re-derived here.
    expect(failure.message).toContain(missing);
  });

  it("reads `at-capacity` off the REAL 429, with the count and cap only the server knows (#36)", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher, maxSessions: 2 });

    await postLaunch(server, launchRequest({ cwd: process.cwd() }));
    await postLaunch(server, launchRequest({ cwd: process.cwd() }));
    const res = await postLaunch(server, launchRequest({ cwd: process.cwd() }));
    const failure = launchFailure(res.status, await res.json());

    expect(res.status).toBe(429);
    expect(failure.code).toBe("at-capacity");
    expect(failure.message).toContain("the cap is 2");
  });

  it("reads `launcher-absent` off the REAL 501 when this server was never wired to launch", async () => {
    const server = await serve({ port: 0 });

    const res = await postLaunch(server, launchRequest({ cwd: process.cwd() }));
    const failure = launchFailure(res.status, await res.json());

    expect(res.status).toBe(501);
    expect(failure.code).toBe("launcher-absent");
  });

  it("reads `malformed-request` off the REAL 400 the UI's own body cannot provoke", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    // A body `launchRequest` would never build (an unknown mode) — the UI must still READ the code
    // correctly, because the server owns the set and another client can raise it. (The old
    // `non-prompting-mode` 400 is gone — ADR-007 launches every mode — so `malformed-request` is the
    // remaining 400 this control's own body cannot provoke.)
    const malformed = await postLaunch(server, { cwd: process.cwd(), permissionMode: "bogus" });
    expect(malformed.status).toBe(400);
    expect(launchFailure(malformed.status, await malformed.json()).code).toBe("malformed-request");
  });

  it("degrades the ingress's 405 — the ONE failure answered with no `code` — instead of throwing", async () => {
    const { launcher } = fakeLauncher();
    const server = await serve({ port: 0, launcher });

    const res = await fetch(`${origin(server)}/api/sessions`, { method: "DELETE" });
    const failure = launchFailure(res.status, await res.json());

    expect(res.status).toBe(405);
    // No launch was attempted, so there is no launch failure to type: the reader must not invent a
    // code, and must still carry the server's prose.
    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("not allowed");
  });
});
