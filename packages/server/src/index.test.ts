// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegisteringSession, createSession } from "@ccctl/core";
import { asLaunchMarker, DEFAULT_HOST, startServer, type CcctlServer } from "./index.js";
import { HOOK_STATE_SUBDIR, hookInstallFileName } from "./hook-settings-installer.js";
import { CCCTL_STATE_DIR, XDG_STATE_HOME_ENV } from "./session-store-file.js";

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
    expect(server.address.host).not.toBe("0.0.0.0");
  });

  it("refuses a non-loopback config.host on the bind path — the guarantee is not overridable (#58)", async () => {
    // The localhost-bind guarantee holds on the ACTUAL bind path, not only the `ccctl serve` CLI
    // edge: an embedder handing startServer a non-loopback host is REJECTED before any socket binds
    // (never a live off-box listener), with the same branded ccctl guardrail. This is the AC that
    // the prior slice missed — startServer took `config.host` straight to listen() ungated.
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      const rejection = startServer({ port: 0, host });
      await expect(rejection).rejects.toThrow(/refusing to bind/);
      await expect(rejection).rejects.toThrow(/loopback only/);
    }
  });

  it("routes an unknown path to a fail-closed 404", async () => {
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/v1/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("fails closed (404) on the speculative attach-side GET /v1/sessions/{id} (#165)", async () => {
    // §2 matches `/v1/sessions` EXACTLY (POST create), so an id-suffixed bare-resource GET is
    // unrouted and falls through to the handler's fail-closed 404. #154 speculated this attach-side
    // leg "likely also applies" (empty 200 tolerated), extrapolating from the real §4 worker-state
    // restore `GET /v1/code/sessions/{id}/worker`. Confirmed against the e2e captured-wire golden
    // (bridge-wire-conformance.ts, #131/#155) and the live-worker oracle (live-worker-oracle.ts,
    // ORACLE_LEG): a real worker's attach/restore is the §4/§5 worker channel, never a bare
    // `GET /v1/sessions/{id}` — so the 404 is intentional, not a gap (#165).
    const server = await startTestServer();
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/v1/sessions/sess-1`, { method: "GET" });
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

  it("reconciles recorded handles against live processes before serving — rehydrates the live, evicts the dead (#34)", async () => {
    // Two handles a previous daemon recorded: one whose surface is still up (the tmux window survived
    // the restart), one whose surface died while the daemon was down. Only `@live` is in the probe's
    // live set, keyed by the launch-marker (never the session id).
    const live = createSession("sess-live", "default", 1_000);
    const dead = createSession("sess-dead", "default", 1_000);
    const liveMarkers = new Set(["@live"]);

    const server = await startServer({
      port: 0,
      host: DEFAULT_HOST,
      recordedLaunches: [
        { session: live, marker: asLaunchMarker("@live") },
        { session: dead, marker: asLaunchMarker("@dead") },
      ],
      livenessProbe: (marker) => liveMarkers.has(marker),
    });
    started.push(server);

    // The registry is already reconciled the moment startServer resolves — the reaper ran BEFORE the
    // listener opened (AC1/AC5): the live handle is rehydrated (AC3), the dead one evicted (AC2).
    expect(server.sessions.has("sess-live")).toBe(true);
    expect(server.sessions.has("sess-dead")).toBe(false);
    expect(server.sessions.get("sess-live")).toBe(live);
  });

  it("does not rehydrate recorded handles when no liveness probe is configured — cannot verify, so does not resurrect (#34)", async () => {
    // A recorded handle with no probe to check it against: alive cannot be told from dead, so the safe
    // reconciliation is to rehydrate nothing rather than resurrect a possibly-dead ghost.
    const server = await startServer({
      port: 0,
      host: DEFAULT_HOST,
      recordedLaunches: [{ session: createSession("sess-x", "default", 1_000), marker: asLaunchMarker("@x") }],
    });
    started.push(server);

    expect(server.sessions.has("sess-x")).toBe(false);
  });

  it("reconciles BEFORE the listener opens — the probe fires synchronously, ahead of listen (#34 AC5)", async () => {
    // Asserting the registry AFTER startServer resolves cannot discriminate WHERE the reconcile ran: it
    // passes just as well with the reconcile moved inside the listen() callback, i.e. after the socket is
    // already accepting. This pins the ordering instead. startServer's reconcile is a synchronous step in its
    // prologue, ahead of createServer/listen — so the probe has necessarily already run by the time the call
    // RETURNS its promise, strictly before any listener exists. Move the reconcile into the listen callback
    // (or anywhere async) and `probedBeforeReturn` is false.
    let probeRan = false;
    const pending = startServer({
      port: 0,
      host: DEFAULT_HOST,
      recordedLaunches: [{ session: createSession("sess-order", "default", 1_000), marker: asLaunchMarker("@order") }],
      livenessProbe: () => {
        probeRan = true;
        return true;
      },
    });
    const probedBeforeReturn = probeRan;

    const server = await pending;
    started.push(server);

    expect(probedBeforeReturn).toBe(true);
    expect(server.sessions.has("sess-order")).toBe(true);
  });

  it("never rehydrates a `registering` recorded handle, even with a live surface — no restored ghost (#34/#33)", async () => {
    // The launch-then-restart race: the terminal came up, the worker had not registered yet, the daemon
    // restarted. The window is still ALIVE, so a liveness-only reaper would restore a `registering` row —
    // which `@ccctl/core` § SessionStatus forbids, because nothing can claim it (rejectIfRegistering 409s the
    // worker leg) and nothing is left to evict it: an immortal ghost in the operator's list. Its surface is
    // left running untouched (the reaper reconciles records only); only its row is refused.
    const server = await startServer({
      port: 0,
      host: DEFAULT_HOST,
      recordedLaunches: [
        { session: createRegisteringSession("sess-ghost", "default", 1_000), marker: asLaunchMarker("@ghost") },
        { session: createSession("sess-real", "default", 1_000), marker: asLaunchMarker("@real") },
      ],
      livenessProbe: () => true, // BOTH surfaces are alive
    });
    started.push(server);

    expect(server.sessions.has("sess-ghost")).toBe(false);
    expect(server.sessions.has("sess-real")).toBe(true);

    // And the ghost is absent from the operator's actual list, not merely from the map.
    const { host, port } = server.address;
    const res = await fetch(`http://${host}:${port}/api/sessions`);
    const body = (await res.json()) as { sessions: readonly { id: string }[] };
    expect(body.sessions.map((session) => session.id)).toEqual(["sess-real"]);
  });

  // The hook-install sweep (#275, ADR-008) — `hook-install-sweep.test.ts` proves WHAT it reaps in
  // isolation; these prove startServer actually RUNS it, runs it before the listener opens, and does
  // NOT run it when no directory was injected. The directory is passed via `hookStateDir` rather than
  // by redirecting `XDG_STATE_HOME`, which is the point of that config existing: the sweep DELETES, so
  // a server that resolved the real path itself would make every bare `startServer()` in this suite
  // mutate the developer's own `$HOME`.
  describe("startup hook-install sweep (#275)", () => {
    let stateHome: string;
    let hookDir: string;
    let priorStateHome: string | undefined;

    /** Start a server that sweeps `hookDir`, tracked for teardown like every other test server here. */
    async function startSweepingServer(): Promise<CcctlServer> {
      const server = await startServer({ port: 0, host: DEFAULT_HOST, hookStateDir: hookDir });
      started.push(server);
      return server;
    }

    beforeEach(() => {
      // `XDG_STATE_HOME` is redirected so that `hookDir` is EXACTLY where an un-gated `startServer`
      // would fall back to (`resolveHookStateDir()`). That is what lets the "does NOT sweep" test
      // below actually observe the gate's removal: without this, an un-gated server would sweep the
      // developer's real `$HOME` while the test watched a temp directory nothing had touched — a
      // green assertion over the wrong directory, on the one test guarding the whole fix.
      priorStateHome = process.env[XDG_STATE_HOME_ENV];
      stateHome = mkdtempSync(join(tmpdir(), "ccctl-index-sweep-"));
      process.env[XDG_STATE_HOME_ENV] = stateHome;
      hookDir = join(stateHome, CCCTL_STATE_DIR, HOOK_STATE_SUBDIR);
      mkdirSync(hookDir, { recursive: true });
    });

    afterEach(() => {
      if (priorStateHome === undefined) {
        Reflect.deleteProperty(process.env, XDG_STATE_HOME_ENV);
      } else {
        process.env[XDG_STATE_HOME_ENV] = priorStateHome;
      }
      rmSync(stateHome, { recursive: true, force: true });
    });

    it("reaps a dead daemon's orphaned hook files on startup (AC1)", async () => {
      // The exact #275 scenario: a daemon was SIGKILLed mid-session, so its in-memory `hookInstalls`
      // died with it and BOTH of its files became unreachable to every #262 cleanup path.
      const settings = join(hookDir, hookInstallFileName(4242, "dead-token", "settings"));
      const handoff = join(hookDir, hookInstallFileName(4242, "dead-token", "handoff"));
      writeFileSync(settings, "{}");
      writeFileSync(handoff, "{}");

      await startSweepingServer();

      expect(existsSync(settings)).toBe(false);
      expect(existsSync(handoff)).toBe(false);
    });

    it("spares an install owned by a live daemon that is not this one (AC2)", async () => {
      // PID 1 is always alive and is never this process — the cleanest stand-in for "another daemon".
      // (It also exercises the EPERM-means-alive branch: `process.kill(1, 0)` throws EPERM here.)
      const otherDaemon = join(hookDir, hookInstallFileName(1, "other-token", "settings"));
      writeFileSync(otherDaemon, "{}");

      await startSweepingServer();

      expect(existsSync(otherDaemon)).toBe(true);
    });

    it("sweeps BEFORE the listener opens — observed synchronously, ahead of the await (#34-style pin)", async () => {
      // Asserting AFTER the promise resolves cannot discriminate WHERE the sweep ran: it passes just as
      // well with the sweep moved into the listen() callback (measured — all four of these tests still
      // passed under that placement). This captures the observation BEFORE the await instead, exactly as
      // the #34 reaper's ordering test above captures `probedBeforeReturn`. startServer's sweep is a
      // synchronous step in its prologue, so the file is already gone by the time the call RETURNS its
      // promise — strictly before any listener exists. Move it into the listen callback and
      // `goneBeforeReturn` is false.
      const orphan = join(hookDir, hookInstallFileName(4242, "ordering-token", "handoff"));
      writeFileSync(orphan, "{}");

      const pending = startSweepingServer();
      const goneBeforeReturn = !existsSync(orphan);

      await pending;

      expect(goneBeforeReturn).toBe(true);
    });

    it("does NOT sweep when no hookStateDir is injected — the fail-closed default (AC2)", async () => {
      // The guarantee the ~20 other startServer callers in this suite depend on: a bare startServer
      // deletes nothing, anywhere. Without it, every one of them would reap the developer's real
      // `$XDG_STATE_HOME/ccctl/hooks` as a side effect of testing something unrelated (measured — a
      // canary planted there was deleted by `ui-sessions.test.ts` before the gate existed).
      //
      // This DISCRIMINATES because of the `XDG_STATE_HOME` redirect in `beforeEach`: `hookDir` is
      // precisely where an un-gated server's `resolveHookStateDir()` fallback would land, so removing
      // the `if (config.hookStateDir !== undefined)` gate makes this orphan disappear and the test go
      // red — rather than sweeping some other directory the assertion cannot see.
      const orphan = join(hookDir, hookInstallFileName(4242, "untouched-token", "settings"));
      writeFileSync(orphan, "{}");

      await startTestServer();

      expect(existsSync(orphan)).toBe(true);
    });

    it("boots normally when the hook state directory does not exist at all", async () => {
      rmSync(hookDir, { recursive: true, force: true });

      const server = await startSweepingServer();

      expect(server.address.port).toBeGreaterThan(0);
    });
  });
});
