// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, startServer, type CcctlServer, type ServerConfig } from "./index.js";
import type { ISessionLauncher, LaunchedSession, SessionLaunchOptions } from "./session-launcher.js";

// The "New session" launch path (#31), exercised END TO END through the wired server: a real
// HTTP `POST /api/sessions` (routing + handler + launcher wiring + teardown), plus the
// programmatic `CcctlServer.launchSession`. The launcher is a recording FAKE — no tmux / pty is
// spawned, and the launched worker's own registration (§2) is out of scope here (it ships in
// `ccctl-patch` and is proven by the fenced live-worker oracle).

/** A recording fake launcher: resolves with a tagged handle, remembers launches, counts closes. */
function fakeLauncher(hint = "tmux attach -t ccctl:1", attachable = true) {
  const launches: SessionLaunchOptions[] = [];
  let closes = 0;
  const launcher: ISessionLauncher = {
    launch(options: SessionLaunchOptions): Promise<LaunchedSession> {
      launches.push(options);
      return Promise.resolve({
        attachment: { attachable, hint },
        close: (): Promise<void> => {
          closes += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return { launcher, launches, closeCount: (): number => closes };
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

describe("POST /api/sessions (launch)", () => {
  it("launches via the injected launcher and answers 201 with the surface attachment", async () => {
    const { launcher, launches } = fakeLauncher("tmux attach -t ccctl:2", true);
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: "/repo", permissionMode: "default" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ attachable: true, hint: "tmux attach -t ccctl:2" });
    expect(launches).toHaveLength(1);
  });

  it("surfaces a DEGRADED attachment when the backend that launched is a fallback", async () => {
    const { launcher } = fakeLauncher("owned pty: attach is degraded", false);
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: "/repo", permissionMode: "default" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ attachable: false, hint: "owned pty: attach is degraded" });
  });

  it("passes cwd, permissionMode, project, and initialPrompt through to the launcher", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await postLaunch(server, { cwd: "/work/atlas", permissionMode: "plan", project: "atlas", initialPrompt: "go" });

    expect(launches[0]).toEqual({ cwd: "/work/atlas", permissionMode: "plan", project: "atlas", initialPrompt: "go" });
  });

  it("omits project and initialPrompt when the body does not carry them", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    // A prompting mode (`plan`) — a non-prompting one is refused on launch (SRV-C-003 launch half),
    // so this test uses a launchable mode; its point is that the OPTIONALS are omitted when absent.
    await postLaunch(server, { cwd: "/repo", permissionMode: "plan" });

    expect(launches[0]).toEqual({ cwd: "/repo", permissionMode: "plan" });
    expect(launches[0]).not.toHaveProperty("project");
    expect(launches[0]).not.toHaveProperty("initialPrompt");
  });

  it("fails closed 501 when the server has no launcher configured", async () => {
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST });

    const res = await postLaunch(server, { cwd: "/repo", permissionMode: "default" });

    expect(res.status).toBe(501);
  });

  it("fails closed 400 on a malformed body — bad permissionMode, missing/blank cwd, or non-JSON — and does not launch", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    expect((await postLaunch(server, { cwd: "/repo", permissionMode: "root" })).status).toBe(400);
    expect((await postLaunch(server, { permissionMode: "default" })).status).toBe(400);
    expect((await postLaunch(server, { cwd: "", permissionMode: "default" })).status).toBe(400);
    expect((await postLaunch(server, { cwd: "/repo", permissionMode: "default", project: 7 })).status).toBe(400);
    expect((await postLaunch(server, "not json")).status).toBe(400);
    expect(launches).toHaveLength(0);
  });

  // SRV-C-003, launch half (#32): a UC2 launch is remotely driven, so the launched session must run
  // under a PROMPTING mode — one that blocks on a decision and can raise the "awaiting input" signal.
  // A non-prompting mode is refused at the ingress (400, never launched); a prompting mode launches.
  it("fails closed 400 on a non-prompting permission-mode — acceptEdits / bypassPermissions — and does not launch", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    for (const permissionMode of ["acceptEdits", "bypassPermissions"] as const) {
      const res = await postLaunch(server, { cwd: "/repo", permissionMode });
      expect(res.status).toBe(400);
    }
    // AC1 (negative): a non-prompting launch never reaches the launcher — no degraded session is born.
    expect(launches).toHaveLength(0);
  });

  it("launches (201) under every PROMPTING permission-mode — default and plan — so it does not over-refuse", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    for (const permissionMode of ["default", "plan"] as const) {
      const res = await postLaunch(server, { cwd: "/repo", permissionMode });
      expect(res.status).toBe(201);
    }
    // AC1 (positive): both prompting modes reach the launcher — the guard refuses ONLY the non-prompting
    // pair. A launched session is therefore always prompting, hence able to raise the awaiting-input
    // signal (AC2) — its end-to-end proof is the fenced live-worker oracle, out of scope for this fake.
    expect(launches.map((l) => l.permissionMode)).toEqual(["default", "plan"]);
  });

  it("fails closed 502 when every launcher backend rejects", async () => {
    const launcher: ISessionLauncher = { launch: (): Promise<LaunchedSession> => Promise.reject(new Error("no tmux")) };
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await postLaunch(server, { cwd: "/repo", permissionMode: "default" });

    expect(res.status).toBe(502);
  });

  it("still LISTS on GET /api/sessions — the launch POST does not shadow the list", async () => {
    const { launcher } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const res = await fetch(`${base(server)}/api/sessions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});

describe("CcctlServer.launchSession (programmatic)", () => {
  it("launches, tracks, and returns the handle", async () => {
    const { launcher, launches } = fakeLauncher("tmux attach -t ccctl:9");
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    const launched = await server.launchSession({ cwd: "/repo", permissionMode: "default" });

    expect(launched.attachment.hint).toBe("tmux attach -t ccctl:9");
    expect(launches).toHaveLength(1);
  });

  it("rejects when no launcher is configured", async () => {
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST });

    await expect(server.launchSession({ cwd: "/repo", permissionMode: "default" })).rejects.toThrow(
      /no session launcher/,
    );
  });

  it("rejects a non-prompting permission-mode — the launch-half invariant holds for the programmatic caller too", async () => {
    const { launcher, launches } = fakeLauncher();
    const server = await startTestServer({ port: 0, host: DEFAULT_HOST, launcher });

    await expect(server.launchSession({ cwd: "/repo", permissionMode: "acceptEdits" })).rejects.toThrow(
      /prompting permission-mode/,
    );
    // The shared core (`launchSession`) refuses BEFORE touching the launcher — no degraded session is born.
    expect(launches).toHaveLength(0);
  });

  it("tears down every launched terminal on close()", async () => {
    const { launcher, closeCount } = fakeLauncher();
    // Untracked (not via startTestServer): this test owns close() itself, so afterEach must not
    // double-close it (a second httpServer.close rejects).
    const server = await startServer({ port: 0, host: DEFAULT_HOST, launcher });
    await server.launchSession({ cwd: "/a", permissionMode: "default" });
    await server.launchSession({ cwd: "/b", permissionMode: "default" });

    expect(closeCount()).toBe(0);
    await server.close();
    expect(closeCount()).toBe(2);
  });
});
