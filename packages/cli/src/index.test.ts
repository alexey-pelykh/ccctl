// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_STORE_SNAPSHOT_VERSION, deviceTokenHash, pairedDevice } from "@ccctl/core";
import type { DeviceStoreSnapshot, HostEndpoint, IDeviceStore, Logger } from "@ccctl/core";
import {
  LOCAL_SERVER_AUTH_ENV,
  XDG_CONFIG_HOME_ENV,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchAcceptedWire,
  type LaunchedSession,
  type ReleasableTunnel,
  type SessionLaunchOptions,
  type SessionStopOptions,
  type SessionSummaryWire,
  type StopAcceptedWire,
  type SurfaceLiveness,
} from "@ccctl/server";
import type { EstablishedTunnel, Tunnel, TunnelKind } from "@ccctl/tunnel-adapters";
import type { CliDependencies } from "./dependencies.js";
import type { SessionClient, SteerCommand } from "./session-client.js";
import { buildProgram } from "./index.js";

// The verbs orchestrate three real capabilities (daemon, tunnels, patcher) behind the
// injectable seams of `CliDependencies`. These tests substitute fakes so the command
// tree is exercised WITHOUT binding a socket or spawning a process — the resolved port,
// the tunnel establish call, and the patcher delegation are all asserted on spies.
//
// A verb throws (guard refusal, unknown tunnel, bad port, or a rejected seam), and
// commander surfaces that as a rejected `parseAsync`, which `cli.ts` turns into a
// non-zero exit code. So a "refuses" expectation is exercised here as "parseAsync rejects".

/** A minimal fake {@link CcctlServer}; the CLI reads `address` and (on tunnel failure) `close`. */
function makeServer(host: string, port: number, close: () => Promise<void>): CcctlServer {
  return {
    address: { host, port },
    sessions: new Map(),
    environments: new Map(),
    injectTurn: () => undefined,
    hasLiveWorker: () => false,
    close,
  };
}

interface FakeDepsOptions {
  /** Override the tunnel `establish` (e.g. to reject); defaults to a successful Tailscale host. */
  readonly establish?: (local: { host: string; port: number }) => Promise<EstablishedTunnel>;
  /** Override the tunnel `teardown` (e.g. to reject, for the `--off` failure path); defaults to a clean release. */
  readonly teardown?: () => Promise<void>;
  /** Override the daemon `close` (e.g. to reject, for #255's cleanup-must-not-mask path); defaults to a clean close. */
  readonly close?: () => Promise<void>;
  /** Override the session-client `launch` (e.g. to reject); defaults to an attachable tmux surface. */
  readonly launch?: (target: HostEndpoint, options: SessionLaunchOptions) => Promise<LaunchAcceptedWire>;
  /** Override the session-client `list` (e.g. to reject or seed sessions); defaults to an empty list. */
  readonly list?: (target: HostEndpoint) => Promise<SessionSummaryWire[]>;
  /** Override the session-client `steer` (e.g. to reject); defaults to an accepted steer returning a correlation id. */
  readonly steer?: (target: HostEndpoint, sessionId: string, command: SteerCommand) => Promise<string>;
  /** Override the session-client `stop` (e.g. to reject with a typed refusal); defaults to a successful kill. */
  readonly stop?: (target: HostEndpoint, sessionId: string, options: SessionStopOptions) => Promise<StopAcceptedWire>;
  /** Seed the `revoke-all` device store (#88); defaults to `null` — a never-paired store. */
  readonly deviceSnapshot?: DeviceStoreSnapshot | null;
}

/**
 * The tunnel a fake `establish` resolves with — the shape the real adapter returns. Module-scoped so
 * {@link makeDeps}' default and the tests that drive their own gated establish resolve the SAME value
 * by construction, rather than by two literals agreeing.
 */
const ESTABLISHED: EstablishedTunnel = { kind: "tailscale", publicHost: "oracle-node.tailnet.ts.net" };

/** Build fake {@link CliDependencies} plus handles to the spies the assertions read. */
function makeDeps(options: FakeDepsOptions = {}): {
  deps: CliDependencies;
  startServer: ReturnType<typeof vi.fn>;
  establish: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  tunnels: Tunnel[];
  runPatcher: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  launcher: ISessionLauncher;
  renderQr: ReturnType<typeof vi.fn>;
  installHeapSnapshotHandler: ReturnType<typeof vi.fn>;
  disposeHeapSnapshotHandler: ReturnType<typeof vi.fn>;
  installInspectorDiagnosticsHandler: ReturnType<typeof vi.fn>;
  disposeInspectorDiagnosticsHandler: ReturnType<typeof vi.fn>;
  installShutdownHandler: ReturnType<typeof vi.fn>;
  disposeShutdownHandler: ReturnType<typeof vi.fn>;
  deviceStore: IDeviceStore;
  deviceSaves: DeviceStoreSnapshot[];
} {
  // A fake bind: echo the requested host, and resolve `--port 0` to a concrete ephemeral
  // port so a test can prove `server.address` (not the requested port) is what's reported.
  const close = vi.fn(options.close ?? (() => Promise.resolve()));
  const startServer = vi.fn((config: { host?: string; port: number }) =>
    Promise.resolve(makeServer(config.host ?? "127.0.0.1", config.port === 0 ? 55555 : config.port, close)),
  );
  const establish = vi.fn(
    options.establish ?? ((_local: { host: string; port: number }) => Promise.resolve(ESTABLISHED)),
  );
  // `adopt` / `teardown` are the tunnel's revert half (#242): `--off` adopts a detached mapping and
  // releases it, and `serve --tunnel`'s shutdown releases the one the daemon retained. Shared spies (like
  // `establish`), so a test asserts on them without reaching for the instance the verb built internally —
  // and `tunnels` records those instances so a test can prove WHICH one reached the shutdown path.
  const adopt = vi.fn((_local: { host: string; port: number }) => undefined);
  const teardown = vi.fn(options.teardown ?? (() => Promise.resolve()));
  const tunnels: Tunnel[] = [];
  const makeTunnel = (kind: TunnelKind): Tunnel => {
    const tunnel: Tunnel = {
      kind,
      establish,
      status: () => Promise.resolve({ kind, up: false }),
      adopt,
      teardown,
    };
    tunnels.push(tunnel);
    return tunnel;
  };
  const adapters: Record<TunnelKind, () => Tunnel> = {
    tailscale: () => makeTunnel("tailscale"),
    cloudflare: () => makeTunnel("cloudflare"),
    headscale: () => makeTunnel("headscale"),
  };
  const runPatcher = vi.fn((_args: readonly string[]) => Promise.resolve());
  // The `/api/sessions` client the launch/attach verbs drive. `launch` defaults to an attachable
  // tmux surface; `list` defaults to empty — a test overrides either to reject or to seed sessions.
  const launch = vi.fn(
    options.launch ??
      ((_target: HostEndpoint, _launchOptions: SessionLaunchOptions) =>
        Promise.resolve({
          // The daemon mints the session id AT launch (#33) and lists the session as `registering`
          // straight away, so a launch answers WHICH session it started — the CLI prints it.
          sessionId: "sess-launched-1",
          attachable: true,
          hint: "tmux attach -t ccctl:1",
        } satisfies LaunchAcceptedWire)),
  );
  const list = vi.fn(options.list ?? ((_target: HostEndpoint) => Promise.resolve([] as SessionSummaryWire[])));
  // The `steer` client the `steer` verb drives. Defaults to an accepted steer returning a
  // daemon-minted correlation id; a test overrides it to reject (404 / 409) or to assert the body sent.
  const steer = vi.fn(
    options.steer ??
      ((_target: HostEndpoint, _sessionId: string, _command: SteerCommand) => Promise.resolve("cmd-corr-1")),
  );
  // The `stop` client the `stop` verb drives (#77). Defaults to a successful kill reporting the
  // terminal state the daemon's transition produced; a test overrides it to reject (a typed refusal)
  // or to assert the body sent — above all whether `force` really rode the request.
  const stop = vi.fn(
    options.stop ??
      ((_target: HostEndpoint, sessionId: string, _stopOptions: SessionStopOptions) =>
        Promise.resolve({ sessionId, outcome: "stopped", status: "closed" } satisfies StopAcceptedWire)),
  );
  const sessionClient: SessionClient = { launch, list, steer, stop };
  // A fake session launcher: the `serve` verb injects it into the daemon (#157); a test asserts the
  // exact instance is passed to `startServer`, without a real tmux window or a spawned worker.
  const launcher: ISessionLauncher = {
    launch: vi.fn((_options: SessionLaunchOptions) =>
      Promise.resolve({
        attachment: { attachable: true, hint: "tmux attach -t ccctl:1" },
        liveness: (): Promise<SurfaceLiveness> => Promise.resolve("alive-server-owned"),
        close: () => Promise.resolve(),
      } satisfies LaunchedSession),
    ),
  };
  // The terminal-QR renderer the onboarding block calls. A fake that echoes its input inside a
  // marker, so an assertion can prove both WHAT was encoded (the pairing URL passed in) and that
  // the rendered block reached the terminal — without drawing a real QR.
  const renderQr = vi.fn((text: string) => `<<QR:${text}>>`);
  // The heap-snapshot signal-arming seam (#62): a fake that records the logger it was handed and
  // returns a spy disposer — so a test asserts `serve` arms the trigger WITHOUT installing a real
  // process-global SIGUSR2 handler that would leak across the test process.
  const disposeHeapSnapshotHandler = vi.fn(() => undefined);
  const installHeapSnapshotHandler = vi.fn((_options: { readonly logger: Logger }) => disposeHeapSnapshotHandler);
  // The inspector-attach + FD/handle-count diagnostics signal-arming seam (#63): same shape as the
  // heap-snapshot seam — records the logger it was handed and returns a spy disposer, so a test asserts
  // `serve` arms the trigger WITHOUT installing a real process-global SIGUSR1 handler or opening a real
  // inspector port, both of which would leak across the test process.
  const disposeInspectorDiagnosticsHandler = vi.fn(() => undefined);
  const installInspectorDiagnosticsHandler = vi.fn(
    (_options: { readonly logger: Logger }) => disposeInspectorDiagnosticsHandler,
  );
  // The local-shutdown signal-arming seam (#82): the SIGTERM/SIGINT graceful-shutdown floor. A fake that
  // records the bound server, the logger, and the tunnel thunk it was handed (#242 — the daemon's revert
  // path) and returns a spy disposer — so a test asserts `serve` arms the trigger WITHOUT installing a
  // real process-global SIGTERM/SIGINT handler (which would leak) or wiring a real `process.exit` (which
  // would kill the test process on a delivered signal).
  const disposeShutdownHandler = vi.fn(() => undefined);
  const installShutdownHandler = vi.fn(
    (_options: {
      readonly server: CcctlServer;
      readonly logger: Logger;
      readonly tunnel: () => ReleasableTunnel | null;
    }) => disposeShutdownHandler,
  );
  // The device store the `revoke-all` verb drives (#88). A minimal in-memory IDeviceStore seeded
  // from `deviceSnapshot` (default `null` — nothing paired) that records every `save`, so a test
  // asserts both the reported count AND whether a save happened (the nothing-to-revoke path must
  // touch no disk) — without a real state file.
  const deviceSaves: DeviceStoreSnapshot[] = [];
  let deviceSnapshot: DeviceStoreSnapshot | null = options.deviceSnapshot ?? null;
  const deviceStore: IDeviceStore = {
    load: () => Promise.resolve(deviceSnapshot),
    save: (snapshot: DeviceStoreSnapshot) => {
      deviceSaves.push(snapshot);
      deviceSnapshot = snapshot;
      return Promise.resolve();
    },
  };
  return {
    deps: {
      startServer,
      adapters,
      runPatcher,
      sessionClient,
      deviceStore,
      launcher,
      installHeapSnapshotHandler,
      installInspectorDiagnosticsHandler,
      installShutdownHandler,
      renderQr,
    },
    startServer,
    establish,
    adopt,
    teardown,
    tunnels,
    runPatcher,
    close,
    launch,
    list,
    steer,
    stop,
    launcher,
    renderQr,
    installHeapSnapshotHandler,
    disposeHeapSnapshotHandler,
    installInspectorDiagnosticsHandler,
    disposeInspectorDiagnosticsHandler,
    installShutdownHandler,
    disposeShutdownHandler,
    deviceStore,
    deviceSaves,
  };
}

const originalAuth = process.env[LOCAL_SERVER_AUTH_ENV];
const originalXdgConfigHome = process.env[XDG_CONFIG_HOME_ENV];
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let xdgConfigDir: string;

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  // stderr is its own channel: the verbs report to `console.log`, but a failure the CLI survives and
  // reports ALONGSIDE the error it is about to rethrow goes to `console.error` (#255's release warning).
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Isolate the #57 config-file auth source: point $XDG_CONFIG_HOME at a fresh empty dir
  // so `serve`'s auth guard never finds a real ~/.config/ccctl/local-server-auth. The env
  // var stays the only auth these tests configure — a refuse-path test that deletes it must
  // deterministically refuse, not silently start off a developer's stray on-disk secret.
  xdgConfigDir = await mkdtemp(join(tmpdir(), "ccctl-cli-xdg-"));
  process.env[XDG_CONFIG_HOME_ENV] = xdgConfigDir;
});

afterEach(async () => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  if (originalAuth === undefined) {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
  } else {
    process.env[LOCAL_SERVER_AUTH_ENV] = originalAuth;
  }
  if (originalXdgConfigHome === undefined) {
    Reflect.deleteProperty(process.env, XDG_CONFIG_HOME_ENV);
  } else {
    process.env[XDG_CONFIG_HOME_ENV] = originalXdgConfigHome;
  }
  await rm(xdgConfigDir, { recursive: true, force: true });
});

/** All console output this run, joined — for asserting the reported address / host. */
function loggedText(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

/** All stderr output this run, joined — for asserting a reported-alongside failure (#255). */
function erroredText(): string {
  return errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("ccctl patch — delegates to the patcher (AC1)", () => {
  it("runs the patcher with no forwarded args for a bare `patch`", async () => {
    const { deps, runPatcher } = makeDeps();
    await buildProgram(deps).parseAsync(["patch"], { from: "user" });
    expect(runPatcher).toHaveBeenCalledTimes(1);
    expect(runPatcher).toHaveBeenCalledWith([]);
  });

  it("forwards positional args verbatim to the patcher", async () => {
    const { deps, runPatcher } = makeDeps();
    await buildProgram(deps).parseAsync(["patch", "prepare", "claude"], { from: "user" });
    expect(runPatcher).toHaveBeenCalledWith(["prepare", "claude"]);
  });

  it("forwards flags after `--` to the patcher (not parsed as ccctl options)", async () => {
    const { deps, runPatcher } = makeDeps();
    await buildProgram(deps).parseAsync(["patch", "--", "--target", "/opt/claude"], { from: "user" });
    expect(runPatcher).toHaveBeenCalledWith(["--target", "/opt/claude"]);
  });

  it("propagates a patcher failure as a rejection (→ non-zero exit)", async () => {
    const { deps } = makeDeps();
    deps.runPatcher = vi.fn(() => Promise.reject(new Error("ccctl: ccctl-patch exited with code 3")));
    await expect(buildProgram(deps).parseAsync(["patch"], { from: "user" })).rejects.toThrow(/exited with code 3/);
  });
});

describe("ccctl serve — baseline startup guards (#14)", () => {
  it("refuses to start with a clear error when no local-server auth is configured (AC1 / S1)", async () => {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
    const { deps, startServer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["serve"], { from: "user" })).rejects.toThrow(
      /local-server auth is required/,
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("checks auth before the bind — a missing secret refuses even with a bad --host", async () => {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
    const { deps, startServer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["serve", "--host", "0.0.0.0"], { from: "user" })).rejects.toThrow(
      /local-server auth is required/,
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("refuses a 0.0.0.0 bind once auth is configured (AC2 / S2: never 0.0.0.0)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, startServer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["serve", "--host", "0.0.0.0"], { from: "user" })).rejects.toThrow(
      /refusing to bind 0\.0\.0\.0/,
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("rejects an invalid --port before binding", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, startServer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["serve", "--port", "not-a-port"], { from: "user" })).rejects.toThrow(
      /invalid port/,
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("rejects an unknown --tunnel before binding (fail fast, no side effects)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, startServer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "ngrok"], { from: "user" })).rejects.toThrow(
      /unknown tunnel "ngrok"/,
    );
    expect(startServer).not.toHaveBeenCalled();
  });
});

describe("ccctl serve — starts the daemon (AC2)", () => {
  beforeEach(() => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
  });

  it("starts the daemon on the default loopback host + port and reports the bound address", async () => {
    const { deps, startServer, establish, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 4321, launcher }));
    expect(establish).not.toHaveBeenCalled();
    expect(loggedText()).toContain("http://127.0.0.1:4321");
  });

  it("passes an explicit loopback --host and --port through to the daemon", async () => {
    const { deps, startServer, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--host", "127.0.0.1", "--port", "8080"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 8080, launcher }));
    expect(loggedText()).toContain("http://127.0.0.1:8080");
  });

  it("reports the RESOLVED ephemeral port (from server.address), not the requested --port 0", async () => {
    const { deps, startServer, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--port", "0"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 0, launcher }));
    expect(loggedText()).toContain("http://127.0.0.1:55555");
  });

  it("injects the session launcher into the daemon so a New session (UC2) can spawn the patched worker (#157)", async () => {
    // Without the launcher, `POST /api/sessions` fails closed with a 501; with it, the daemon spawns
    // the patched `claude`. The `serve` verb MUST forward the injected launcher to `startServer`.
    const { deps, startServer, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(startServer.mock.calls[0][0]).toHaveProperty("launcher", launcher);
  });

  it("arms the on-demand heap-snapshot trigger (#62) with the SAME sink it gives the daemon, and prints how to trigger it", async () => {
    const { deps, startServer, installHeapSnapshotHandler, disposeHeapSnapshotHandler } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    // Armed exactly once, and NOT torn down at serve-return — the handler lives for the daemon's lifetime.
    expect(installHeapSnapshotHandler).toHaveBeenCalledTimes(1);
    expect(disposeHeapSnapshotHandler).not.toHaveBeenCalled();
    // One shared structured-log sink: the daemon trail (#61) AND heap-snapshot events (#62) ride the
    // same object, so both land on the one JSON stdout.
    const serverLogger = (startServer.mock.calls[0][0] as { logger: unknown }).logger;
    const handlerLogger = (installHeapSnapshotHandler.mock.calls[0][0] as { logger: unknown }).logger;
    expect(handlerLogger).toBe(serverLogger);
    // The one-time operator hint names the signal and how to send it.
    expect(loggedText()).toContain("SIGUSR2");
    expect(loggedText()).toContain("heap snapshot");
  });

  it("arms the inspector-attach + FD/handle-count diagnostics trigger (#63) with the SAME sink, and prints how to trigger it", async () => {
    const { deps, startServer, installInspectorDiagnosticsHandler, disposeInspectorDiagnosticsHandler } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    // Armed exactly once, and NOT torn down at serve-return — the handler lives for the daemon's lifetime.
    expect(installInspectorDiagnosticsHandler).toHaveBeenCalledTimes(1);
    expect(disposeInspectorDiagnosticsHandler).not.toHaveBeenCalled();
    // One shared structured-log sink: the daemon trail (#61), heap-snapshot (#62), AND the inspector /
    // FD-handle report (#63) all ride the same object, so everything lands on the one JSON stdout.
    const serverLogger = (startServer.mock.calls[0][0] as { logger: unknown }).logger;
    const handlerLogger = (installInspectorDiagnosticsHandler.mock.calls[0][0] as { logger: unknown }).logger;
    expect(handlerLogger).toBe(serverLogger);
    // The one-time operator hint names the signal and what it does.
    expect(loggedText()).toContain("SIGUSR1");
    expect(loggedText()).toContain("inspector attach");
    expect(loggedText()).toContain("timer census");
    // "Poke again" is the one instruction an operator cannot infer and would otherwise misread: the
    // FIRST poke only ARMS the census (#238), so its reading is ~0 even on a daemon full of timers.
    // Pinned so a later edit to the hint cannot drop it silently and leave the census unreadable.
    expect(loggedText()).toContain("poke again");
  });

  it("arms the local-shutdown floor (#82) with the bound server + the SAME sink, and prints how to trigger it", async () => {
    const { deps, startServer, installShutdownHandler, disposeShutdownHandler } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    // Armed exactly once, and NOT torn down at serve-return — the handler lives for the daemon's lifetime.
    expect(installShutdownHandler).toHaveBeenCalledTimes(1);
    expect(disposeShutdownHandler).not.toHaveBeenCalled();
    // It is handed the BOUND server to close (the exact object `startServer` resolved) and the SAME
    // structured-log sink the daemon got, so a failed shutdown rides the one #61 trail.
    const resolvedServer = await startServer.mock.results[0]?.value;
    const serverLogger = (startServer.mock.calls[0][0] as { logger: unknown }).logger;
    const handlerArg = installShutdownHandler.mock.calls[0][0] as { server: unknown; logger: unknown };
    expect(handlerArg.server).toBe(resolvedServer);
    expect(handlerArg.logger).toBe(serverLogger);
    // The one-time operator hint names the termination signals and that no device token is needed —
    // the "stop the server from the local machine" floor (AC1/AC2).
    expect(loggedText()).toContain("SIGTERM");
    expect(loggedText()).toContain("SIGINT");
    expect(loggedText()).toContain("no device token needed");
  });
});

describe("ccctl serve --tunnel — composes daemon + tunnel (AC4)", () => {
  beforeEach(() => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
  });

  /**
   * A promise whose settlement the test decides — the only way to hold an establish open and land a
   * signal INSIDE it, which is the window #259 is about and the one no test could reach before.
   */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("starts the daemon THEN establishes the tunnel against the bound address, reporting the public host", async () => {
    const { deps, startServer, establish, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 4321, launcher }));
    expect(establish).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    expect(loggedText()).toContain("oracle-node.tailnet.ts.net");
  });

  it("establishes the tunnel against the RESOLVED ephemeral port, not the requested --port 0", async () => {
    const { deps, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale", "--port", "0"], { from: "user" });
    expect(establish).toHaveBeenCalledWith({ host: "127.0.0.1", port: 55555 });
  });

  it("closes the daemon and rejects when the tunnel fails — atomic, no orphaned half-up server", async () => {
    const { deps, close } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: tailscale is not an authenticated tailnet member")),
    });
    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toThrow(
      /not an authenticated tailnet member/,
    );
    // The started daemon MUST be torn back down — otherwise its listening socket keeps the
    // process alive with the exit code set but never applied (a loopback-only half-up setup).
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does NOT close the daemon on the happy path (the server stays up on its listening socket)", async () => {
    const { deps, close } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    expect(close).not.toHaveBeenCalled();
  });

  // Rule (#255 AC1): the adapter records its serve mapping the moment `tailscale serve --bg` lands —
  // BEFORE the auth gate and the host resolution — precisely so a half-up serve stays releasable. But
  // nothing ever called the `teardown` that releasability was for: `establishAndReport` returned the
  // instance only on SUCCESS, so a rejected establish dropped the one handle to the mapping. Atomicity
  // is BOTH halves — the daemon comes down AND the mapping goes with it.
  it("releases the half-up serve mapping when the establish fails — before closing the daemon", async () => {
    const { deps, close, teardown, tunnels } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: tailscale is not an authenticated tailnet member")),
    });

    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toThrow(
      /not an authenticated tailnet member/,
    );

    // Exactly one tunnel was ever built, so the release necessarily landed on the instance whose
    // establish failed — the one holding the half-up mapping.
    expect(tunnels).toHaveLength(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    // BEFORE the close — plain LIFO, the tunnel having been acquired last. Not a safety property (a
    // mapping pointing at a closed port authorizes nobody, per `shutdown-signal.ts`); pinned so a later
    // edit does not quietly reorder the unwind.
    expect(teardown.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  // Rule (#255 AC2): the operator's question is WHY the tunnel could not be established. A release that
  // also fails is a footnote to that answer, never a replacement for it — `cli.ts` prints `error.message`
  // and nothing else, so an AggregateError / `{ cause }` wrapper would substitute a summary for the one
  // line that explains the failure.
  it("surfaces the establish error verbatim when the release ALSO fails, reporting the release alongside", async () => {
    const establishFailure = new Error("ccctl: tailscale is not an authenticated tailnet member");
    const { deps, close } = makeDeps({
      establish: () => Promise.reject(establishFailure),
      teardown: () => Promise.reject(new Error("tailscale serve off exited 1")),
    });

    // The very instance, not merely a matching message: a wrapper would satisfy a message match on the
    // establish text and still have replaced the error the operator sees.
    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toBe(
      establishFailure,
    );

    // Alongside, on stderr: what may still be up, why the release failed, and the verb that clears it.
    const reported = erroredText();
    expect(reported).toContain("could not release the half-up tailscale tunnel");
    expect(reported).toContain("tailscale serve off exited 1");
    expect(reported).toContain("ccctl tunnel tailscale --off");
    // A failed release must not strand the daemon either — it still comes down.
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Rule: releasing is the FAILURE path's business alone. A tunnel that came up is the daemon's to hold
  // for its lifetime (#242) — tearing it down here would un-expose the server it just exposed.
  it("does NOT release the tunnel on the happy path (the daemon holds it for its lifetime)", async () => {
    const { deps, teardown } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    expect(teardown).not.toHaveBeenCalled();
  });

  // Rule (#255 AC2, applied to its sibling step): `close` is the OTHER cleanup step in the same unwind,
  // so a rejected close masks the establish error exactly as a rejected teardown would. Same defect, one
  // step later — so it gets the same treatment rather than a carefully non-masking release two lines
  // above a silent one.
  it("surfaces the establish error verbatim when the daemon CLOSE fails, reporting the close alongside", async () => {
    const establishFailure = new Error("ccctl: tailscale is not an authenticated tailnet member");
    const { deps } = makeDeps({
      establish: () => Promise.reject(establishFailure),
      close: () => Promise.reject(new Error("ERR_SERVER_NOT_RUNNING")),
    });

    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toBe(
      establishFailure,
    );

    const reported = erroredText();
    expect(reported).toContain("could not close the daemon after the tunnel failed");
    expect(reported).toContain("ERR_SERVER_NOT_RUNNING");
  });

  // Rule: neither cleanup step may skip the other — a broken close is no reason to strand a mapping.
  it("releases the mapping even when the daemon close ALSO fails", async () => {
    const { deps, teardown } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: tailscale is not an authenticated tailnet member")),
      close: () => Promise.reject(new Error("ERR_SERVER_NOT_RUNNING")),
    });
    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toThrow(
      /not an authenticated tailnet member/,
    );
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  // Rule (#242 AC1): the daemon owns the tunnel's lifetime, so it must RETAIN the tunnel and hand it to
  // the shutdown path — the whole defect was that `establishAndReport` dropped the instance the moment
  // `establish` returned, leaving nothing able to call `teardown` and so no way to revert the grant.
  it("retains the established tunnel and hands it to the shutdown path (the grant's revert path)", async () => {
    const { deps, installShutdownHandler, tunnels } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });

    const handlerArg = installShutdownHandler.mock.calls[0][0];
    // Exactly the instance the verb established — resolved through the thunk, as the handler does.
    expect(tunnels).toHaveLength(1);
    expect(handlerArg.tunnel()).toBe(tunnels[0]);
  });

  // Rule: the thunk exists because shutdown is armed BEFORE the tunnel is established (so a Ctrl-C
  // during a slow establish still shuts down gracefully). Proven by reading it at ARM time, when the
  // establish has not run yet — a plain value could not have carried the tunnel at all.
  //
  // Scoped to ARM time, which is before the establish STARTS — not "until it lands". Once it is in
  // flight the answer is a releaser rather than `null`, because by then there may be a mapping to
  // release (#259); this pins the one moment when there provably is not.
  it("arms shutdown before the tunnel exists — the thunk answers null until the establish starts", async () => {
    const resolvedAtArmTime: unknown[] = [];
    const { deps, installShutdownHandler } = makeDeps();
    installShutdownHandler.mockImplementation((options) => {
      resolvedAtArmTime.push(options.tunnel());
      return () => undefined;
    });

    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });

    expect(resolvedAtArmTime).toEqual([null]);
  });

  // Rule: a loopback-only daemon has no tunnel to release — the thunk says so honestly rather than
  // handing the shutdown path something to tear down.
  it("passes a thunk resolving to null when serving without a tunnel", async () => {
    const { deps, installShutdownHandler } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    const handlerArg = installShutdownHandler.mock.calls[0][0];
    expect(handlerArg.tunnel()).toBeNull();
  });

  // Rule: a failed establish that has SETTLED leaves no usable tunnel, so the thunk must not hand the
  // shutdown path a half-up instance to revert a grant that was never provisioned (the adapter records
  // nothing on a failed establish — provisioning runs last). Scoped to the settled case on purpose:
  // while that same establish is still IN FLIGHT the answer is NOT null, because the mapping it may
  // already have landed is releasable and nothing else will release it (#259, the three tests below).
  it("leaves the thunk answering null when the establish fails", async () => {
    const captured: Array<() => unknown> = [];
    const { deps, installShutdownHandler } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: tailscale is not an authenticated tailnet member")),
    });
    installShutdownHandler.mockImplementation((options) => {
      captured.push(options.tunnel);
      return () => undefined;
    });

    await expect(buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" })).rejects.toThrow();

    expect(captured[0]?.()).toBeNull();
  });

  // Rule (#259 AC1): the window between `tailscale serve --bg` landing and `establish` resolving is the
  // one where a mapping exists and the daemon has not been handed anything — so the thunk must answer a
  // RELEASER there, not `null`. Answering `null` is what let a Ctrl-C during a slow establish close the
  // server, release nothing, and exit 0 with the mapping still pointing at the port it just closed.
  it("answers a releaser — not null — while the establish is still in flight", async () => {
    const gate = deferred<EstablishedTunnel>();
    const { deps, installShutdownHandler } = makeDeps({ establish: () => gate.promise });
    const serving = buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    await vi.waitFor(() => expect(installShutdownHandler).toHaveBeenCalled());

    // Mid-establish: the daemon owns no tunnel yet, but has something to release.
    expect(installShutdownHandler.mock.calls[0][0].tunnel()).not.toBeNull();

    gate.resolve(ESTABLISHED);
    await serving;
  });

  // Rule (#259): the releaser WAITS for the establish to settle before releasing, and that ordering is
  // the whole point — not politeness. `teardown` decides the ACL revert from a synchronous read of the
  // grant the adapter records only AFTER its policy write lands, so a teardown that ran mid-establish
  // would read "no grant", skip the revert, and strand the grant the establish went on to write. Proven
  // by ordering: the release cannot be observed until the establish has settled.
  it("waits for the in-flight establish to settle before releasing what it left", async () => {
    const order: string[] = [];
    const gate = deferred<EstablishedTunnel>();
    const { deps, installShutdownHandler, teardown } = makeDeps({
      establish: () => gate.promise,
      teardown: () => {
        order.push("teardown");
        return Promise.resolve();
      },
    });
    const serving = buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    await vi.waitFor(() => expect(installShutdownHandler).toHaveBeenCalled());

    // The signal lands mid-establish: the shutdown path resolves the thunk and starts releasing.
    let released = false;
    const releasing = installShutdownHandler.mock.calls[0][0]
      .tunnel()
      ?.teardown()
      .then(() => {
        released = true;
      });
    // A real timer turn, not a microtask hop. The property under test is that the release is BLOCKED on
    // the establish — and "blocked" and "merely deferred" are indistinguishable across a single
    // `await Promise.resolve()`, so that barrier would also pass a releaser that never waits at all.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Still nothing released, and the releaser itself still pending — the establish has not settled, so
    // there is nothing safe to read yet. Asserting BOTH is the point: the spy alone cannot tell a
    // releaser that is waiting from one that already gave up and resolved having done nothing.
    expect(teardown).not.toHaveBeenCalled();
    expect(released).toBe(false);

    order.push("establish-settled");
    gate.resolve(ESTABLISHED);
    await serving;
    await releasing;

    expect(order).toEqual(["establish-settled", "teardown"]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  // Rule (#259 AC3): a signal landing mid-establish and a FAILED establish both want to release the same
  // half-up mapping — and must not both drive `tailscale serve … off` at once. They cannot: #255's catch
  // releases the instance inline, and the daemon never retains a tunnel it could not establish, so the
  // waiting releaser finds nothing of its own to release. Exactly ONE teardown, from the catch.
  it("leaves the inline release as the only one when the in-flight establish then fails", async () => {
    const gate = deferred<EstablishedTunnel>();
    const { deps, installShutdownHandler, teardown } = makeDeps({ establish: () => gate.promise });
    const serving = buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    await vi.waitFor(() => expect(installShutdownHandler).toHaveBeenCalled());

    const releasing = installShutdownHandler.mock.calls[0][0].tunnel()?.teardown();
    gate.reject(new Error("ccctl: tailscale is not an authenticated tailnet member"));

    await expect(serving).rejects.toThrow(/not an authenticated tailnet member/);
    // The releaser settles rather than propagating the establish error — that error is the establish
    // path's to report, and a shutdown must never be wedged by it.
    await expect(releasing).resolves.toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe("QR-pair onboarding — mint a per-device token + print a terminal QR (#74)", () => {
  /** The one pairing URL the onboarding block passed to `renderQr` (asserts exactly one QR was drawn). */
  function encodedPairingUrl(renderQr: ReturnType<typeof vi.fn>): string {
    expect(renderQr).toHaveBeenCalledTimes(1);
    return String(renderQr.mock.calls[0][0]);
  }

  it("serve --tunnel: renders a QR of the tunnel origin with a minted token in the URL fragment (AC1)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, renderQr } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    const url = encodedPairingUrl(renderQr);
    // The QR encodes the tunnel's public origin with the token in the FRAGMENT — never a query.
    expect(url).toMatch(/^https:\/\/oracle-node\.tailnet\.ts\.net\/#ccctl_token=[A-Za-z0-9_-]+$/);
    expect(url).not.toContain("?");
    // The rendered QR block reaches the terminal (the fake echoes its input inside the marker).
    expect(loggedText()).toContain(`<<QR:${url}>>`);
    expect(loggedText()).toContain("scan to pair a device");
  });

  it("serve --tunnel: prints the pairing URL REDACTED — the raw token is never logged in plaintext (AC4)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, renderQr } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    const token = encodedPairingUrl(renderQr).split("ccctl_token=")[1];
    // The human-readable hint names the URL with the token redacted…
    expect(loggedText()).toContain("pairing URL — https://oracle-node.tailnet.ts.net/#ccctl_token=REDACTED");
    // …and the raw secret appears ONLY inside the QR payload (a scannable image in production),
    // never on a plaintext log line.
    const plaintextLines = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => !line.startsWith("<<QR:"));
    expect(plaintextLines.some((line) => line.includes(token))).toBe(false);
  });

  it("serve WITHOUT a tunnel: prints no pairing QR — the token only ever travels over the tunnel (AC4)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    const { deps, renderQr } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    expect(renderQr).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain("scan to pair");
  });

  it("tunnel: exposing an already-running server is also an onboarding moment — it prints a pairing QR", async () => {
    const { deps, renderQr } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    expect(encodedPairingUrl(renderQr)).toMatch(
      /^https:\/\/oracle-node\.tailnet\.ts\.net\/#ccctl_token=[A-Za-z0-9_-]+$/,
    );
  });

  it("mints a DISTINCT token per invocation — distinct per device (AC3)", async () => {
    const first = makeDeps();
    const second = makeDeps();
    await buildProgram(first.deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    await buildProgram(second.deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    const tokenOf = (renderQr: ReturnType<typeof vi.fn>): string =>
      String(renderQr.mock.calls[0][0]).split("ccctl_token=")[1];
    expect(tokenOf(first.renderQr)).not.toBe(tokenOf(second.renderQr));
  });
});

describe("ccctl tunnel — establishes the tunnel (AC3)", () => {
  it("establishes the named tunnel against the default loopback endpoint and reports the public host", async () => {
    const { deps, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    expect(establish).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    expect(loggedText()).toContain("oracle-node.tailnet.ts.net");
  });

  it("establishes against an explicit --host and --port", async () => {
    const { deps, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale", "--host", "127.0.0.1", "--port", "9999"], {
      from: "user",
    });
    expect(establish).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 });
  });

  it("does NOT require local-server auth (establishing a tunnel is not starting the daemon)", async () => {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
    const { deps, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    expect(establish).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown tunnel kind", async () => {
    const { deps, establish } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["tunnel", "ngrok"], { from: "user" })).rejects.toThrow(
      /unknown tunnel "ngrok"/,
    );
    expect(establish).not.toHaveBeenCalled();
  });

  it("refuses a 0.0.0.0 target host", async () => {
    const { deps, establish } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["tunnel", "tailscale", "--host", "0.0.0.0"], { from: "user" }),
    ).rejects.toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(establish).not.toHaveBeenCalled();
  });

  it("propagates an establish failure from a not-yet-implemented backend", async () => {
    const { deps } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: cloudflare tunnel adapter is not implemented yet (skeleton)")),
    });
    await expect(buildProgram(deps).parseAsync(["tunnel", "cloudflare"], { from: "user" })).rejects.toThrow(
      /not implemented yet \(skeleton\)/,
    );
  });

  // Rule (#255's scope boundary): `serve --tunnel` releases a half-up establish because it is tearing its
  // OWN daemon back down and promises atomicity. This verb exposes a server it does not own and exits by
  // design, so it has no daemon to be atomic with and must not assume the operator wants a mapping cleared
  // on its way out — `--off` is the verb that clears one, deliberately and explicitly (ADR-004).
  it("does NOT release on a failed establish — fire-and-forget has no daemon to be atomic with", async () => {
    const { deps, teardown } = makeDeps({
      establish: () => Promise.reject(new Error("ccctl: tailscale is not an authenticated tailnet member")),
    });
    await expect(buildProgram(deps).parseAsync(["tunnel", "tailscale"], { from: "user" })).rejects.toThrow(
      /not an authenticated tailnet member/,
    );
    expect(teardown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// the down-verb (#242)
//
// `ccctl tunnel` stays FIRE-AND-FORGET — `tailscale serve --bg` is a detached mapping meant to outlive
// the command — so the revert half is `--off` on the same verb rather than a self-bracketing establish.
// It runs in a LATER process with none of the establish's lifecycle state, which is why it adopts.
// ---------------------------------------------------------------------------

describe("ccctl tunnel --off — the down-verb reverts what the establish provisioned (#242 AC2)", () => {
  it("adopts the mapping at the default endpoint and tears it down — never establishing anything", async () => {
    const { deps, adopt, teardown, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale", "--off"], { from: "user" });

    // Adopt rebuilds the release handles a fresh process lacks, THEN teardown reverts the grant and
    // turns the mapping off. `--off` must never bring a tunnel UP.
    expect(adopt).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(establish).not.toHaveBeenCalled();
  });

  it("adopts the SAME --host/--port the establish served — the off-target must name that mapping", async () => {
    const { deps, adopt } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale", "--off", "--host", "127.0.0.1", "--port", "9999"], {
      from: "user",
    });
    expect(adopt).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 });
  });

  it("reports the tunnel is down and says the grant is gone — the operator's confirmation", async () => {
    const { deps } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale", "--off"], { from: "user" });
    expect(loggedText()).toContain("is down");
    expect(loggedText()).toContain("ACL grant");
  });

  it("prints no QR / pairing block — nothing was exposed, so there is no device to onboard", async () => {
    const { deps, renderQr } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale", "--off"], { from: "user" });
    expect(renderQr).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain("scan to pair");
  });

  it("propagates a teardown failure (the adapter leaves it retryable, so a retry is the next move)", async () => {
    const { deps } = makeDeps({ teardown: () => Promise.reject(new Error("ccctl: tailscale ACL save failed")) });
    await expect(buildProgram(deps).parseAsync(["tunnel", "tailscale", "--off"], { from: "user" })).rejects.toThrow(
      /tailscale ACL save failed/,
    );
  });

  it("validates the target before touching anything — an unknown kind or a 0.0.0.0 host adopts nothing", async () => {
    for (const argv of [
      ["tunnel", "ngrok", "--off"],
      ["tunnel", "tailscale", "--off", "--host", "0.0.0.0"],
    ]) {
      const { deps, adopt, teardown } = makeDeps();
      await expect(buildProgram(deps).parseAsync(argv, { from: "user" })).rejects.toThrow();
      expect(adopt).not.toHaveBeenCalled();
      expect(teardown).not.toHaveBeenCalled();
    }
  });

  it("without --off the verb still establishes — the default stays fire-and-forget", async () => {
    const { deps, establish, adopt, teardown } = makeDeps();
    await buildProgram(deps).parseAsync(["tunnel", "tailscale"], { from: "user" });
    expect(establish).toHaveBeenCalledTimes(1);
    // Fire-and-forget: the detached mapping is meant to outlive this process, so the verb never
    // releases what it just brought up.
    expect(adopt).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });
});

describe("ccctl launch — drives a UC2 launch on a running daemon (AC1)", () => {
  it("launches on the default loopback daemon with the working directory + default mode, reporting the attach hint", async () => {
    const { deps, launch } = makeDeps();
    await buildProgram(deps).parseAsync(["launch"], { from: "user" });
    // Default target is the daemon's default loopback host:port; default mode is `default`; the
    // cwd defaults to the process cwd; project / initialPrompt are OMITTED (not `undefined`) when unset.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 4321 },
      { cwd: process.cwd(), permissionMode: "default" },
    );
    // It names the session it started (#33) — the operator can address their own row immediately —
    // and is honest that it is not live until its worker checks in.
    expect(loggedText()).toContain("launched session sess-launched-1 on http://127.0.0.1:4321");
    expect(loggedText()).toContain("attach it with — tmux attach -t ccctl:1");
    expect(loggedText()).toContain("`registering` until its worker checks in");
  });

  it("passes an explicit --host/--port/--cwd/--permission-mode plus --project and --initial-prompt through", async () => {
    const { deps, launch } = makeDeps();
    await buildProgram(deps).parseAsync(
      [
        "launch",
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
        "--cwd",
        "/work/repo",
        "--permission-mode",
        "acceptEdits",
        "--project",
        "oracle",
        "--initial-prompt",
        "ship it",
      ],
      { from: "user" },
    );
    expect(launch).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 8080 },
      { cwd: "/work/repo", permissionMode: "acceptEdits", project: "oracle", initialPrompt: "ship it" },
    );
  });

  it("surfaces a degraded (not fully attachable) surface's hint instead of an attach command", async () => {
    const { deps } = makeDeps({
      launch: () =>
        Promise.resolve({ attachable: false, hint: "owned pty — reachable only from this daemon (degraded)" }),
    });
    await buildProgram(deps).parseAsync(["launch"], { from: "user" });
    expect(loggedText()).toContain("not fully attachable — owned pty — reachable only from this daemon (degraded)");
  });

  it("fails closed on an unknown --permission-mode BEFORE any network round-trip", async () => {
    const { deps, launch } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["launch", "--permission-mode", "yolo"], { from: "user" }),
    ).rejects.toThrow(/invalid permission mode "yolo"/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects an invalid --port before contacting the daemon", async () => {
    const { deps, launch } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["launch", "--port", "not-a-port"], { from: "user" })).rejects.toThrow(
      /invalid port/,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses a 0.0.0.0 daemon host (never the wildcard)", async () => {
    const { deps, launch } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["launch", "--host", "0.0.0.0"], { from: "user" })).rejects.toThrow(
      /refusing to bind 0\.0\.0\.0/,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("propagates a daemon-side launch refusal (e.g. no launcher configured) as a rejection (→ non-zero exit)", async () => {
    const { deps } = makeDeps({
      launch: () =>
        Promise.reject(
          new Error("ccctl: the daemon has no session launcher configured — it cannot launch sessions yet"),
        ),
    });
    await expect(buildProgram(deps).parseAsync(["launch"], { from: "user" })).rejects.toThrow(
      /no session launcher is configured|has no session launcher configured/,
    );
  });
});

describe("ccctl attach — the UC1 attach on-ramp lists running sessions (AC1 + AC2)", () => {
  it("lists every session the daemon carries — a phone-driven one and a CLI-launched one side by side (AC2)", async () => {
    // The list is the shared `/api/sessions` collection, so sessions of EVERY origin enumerate
    // together — this is the "appears in the session list alongside phone-driven ones" AC, read
    // from the client side (the CLI renders whatever the unified list returns).
    const { deps, list } = makeDeps({
      list: () =>
        Promise.resolve([
          { id: "phone-sess", status: "ready", activity: { kind: "running" }, notificationsDegraded: false },
          {
            id: "cli-sess",
            status: "busy",
            activity: { kind: "requires_action", detail: "approve edit" },
            notificationsDegraded: false,
          },
        ]),
    });
    await buildProgram(deps).parseAsync(["attach"], { from: "user" });
    expect(list).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    const text = loggedText();
    expect(text).toContain("2 sessions on http://127.0.0.1:4321");
    expect(text).toContain("phone-sess  [ready] running");
    expect(text).toContain("cli-sess  [busy] requires action — approve edit");
  });

  it("reports an empty daemon with a launch hint rather than a bare blank", async () => {
    const { deps } = makeDeps({ list: () => Promise.resolve([]) });
    await buildProgram(deps).parseAsync(["attach"], { from: "user" });
    expect(loggedText()).toContain("no sessions on http://127.0.0.1:4321 yet");
  });

  it("lists against an explicit --host and --port", async () => {
    const { deps, list } = makeDeps();
    await buildProgram(deps).parseAsync(["attach", "--host", "127.0.0.1", "--port", "9999"], { from: "user" });
    expect(list).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 });
  });

  it("rejects an invalid --port before contacting the daemon", async () => {
    const { deps, list } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["attach", "--port", "99999"], { from: "user" })).rejects.toThrow(
      /invalid port/,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("propagates a list failure as a rejection (→ non-zero exit)", async () => {
    const { deps } = makeDeps({
      list: () => Promise.reject(new Error("ccctl: could not list sessions — GET /api/sessions returned 500")),
    });
    await expect(buildProgram(deps).parseAsync(["attach"], { from: "user" })).rejects.toThrow(
      /could not list sessions/,
    );
  });
});

describe("ccctl attach <session-id> — selects one session to attach to (UC1 completion)", () => {
  // Two sessions of DIFFERENT origin sit in the shared list; selecting either is identical, which
  // is exactly "attached sessions appear alongside phone-driven ones" read from the select side.
  const seeded = (): SessionSummaryWire[] => [
    { id: "phone-sess", status: "ready", activity: { kind: "running" }, notificationsDegraded: false },
    {
      id: "cli-sess",
      status: "busy",
      activity: { kind: "requires_action", detail: "approve edit" },
      notificationsDegraded: false,
    },
  ];

  it("selects a named session from the shared list and reports how to steer it", async () => {
    const { deps } = makeDeps({ list: () => Promise.resolve(seeded()) });
    await buildProgram(deps).parseAsync(["attach", "cli-sess"], { from: "user" });
    const text = loggedText();
    expect(text).toContain("session cli-sess on http://127.0.0.1:4321 — [busy] requires action — approve edit");
    expect(text).toContain("ccctl steer cli-sess --prompt");
    // The bare-list rendering ("2 sessions on …") is NOT emitted when one is selected.
    expect(text).not.toContain("2 sessions on");
  });

  it("selects a phone-driven session identically (same shared collection)", async () => {
    const { deps } = makeDeps({ list: () => Promise.resolve(seeded()) });
    await buildProgram(deps).parseAsync(["attach", "phone-sess"], { from: "user" });
    expect(loggedText()).toContain("session phone-sess on http://127.0.0.1:4321 — [ready] running");
  });

  it("fails closed when the id is not among the daemon's sessions (→ non-zero exit)", async () => {
    const { deps } = makeDeps({ list: () => Promise.resolve(seeded()) });
    await expect(buildProgram(deps).parseAsync(["attach", "ghost-sess"], { from: "user" })).rejects.toThrow(
      /no session ghost-sess on http:\/\/127\.0\.0\.1:4321/,
    );
  });

  it("resolves the selection against an explicit --host and --port", async () => {
    const { deps, list } = makeDeps({ list: () => Promise.resolve(seeded()) });
    await buildProgram(deps).parseAsync(["attach", "cli-sess", "--host", "127.0.0.1", "--port", "9999"], {
      from: "user",
    });
    expect(list).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 });
    expect(loggedText()).toContain("session cli-sess on http://127.0.0.1:9999");
  });
});

describe("ccctl steer — drives one session on a running daemon (AC2: steerable)", () => {
  it("sends a --prompt as a `prompt` steer and reports the daemon's correlation id", async () => {
    const { deps, steer } = makeDeps({ steer: () => Promise.resolve("corr-42") });
    await buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "ship it"], { from: "user" });
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", {
      subtype: "prompt",
      payload: { text: "ship it" },
    });
    const text = loggedText();
    expect(text).toContain("steered sess-1 on http://127.0.0.1:4321 (prompt)");
    expect(text).toContain("correlation corr-42");
  });

  it("preserves the operator's exact prompt text (leading/trailing spacing survives)", async () => {
    const { deps, steer } = makeDeps();
    await buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "  indented\n"], { from: "user" });
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", {
      subtype: "prompt",
      payload: { text: "  indented\n" },
    });
  });

  it("sends a bare --approve as a payload-less `approve` steer", async () => {
    const { deps, steer } = makeDeps();
    await buildProgram(deps).parseAsync(["steer", "sess-1", "--approve"], { from: "user" });
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", { subtype: "approve" });
  });

  it("carries --tool-use-id on an --approve steer's payload", async () => {
    const { deps, steer } = makeDeps();
    await buildProgram(deps).parseAsync(["steer", "sess-1", "--approve", "--tool-use-id", "tool-7"], { from: "user" });
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", {
      subtype: "approve",
      payload: { toolUseId: "tool-7" },
    });
  });

  it("sends an --interrupt as an `interrupt` steer carrying the reason", async () => {
    const { deps, steer } = makeDeps();
    await buildProgram(deps).parseAsync(["steer", "sess-1", "--interrupt", "wrong file"], { from: "user" });
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", {
      subtype: "interrupt",
      payload: { reason: "wrong file" },
    });
  });

  it("steers against an explicit --host and --port", async () => {
    const { deps, steer } = makeDeps();
    await buildProgram(deps).parseAsync(
      ["steer", "sess-1", "--host", "127.0.0.1", "--port", "9999", "--prompt", "go"],
      { from: "user" },
    );
    expect(steer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 }, "sess-1", {
      subtype: "prompt",
      payload: { text: "go" },
    });
  });

  it("requires a steer verb — a bare `steer <id>` fails closed BEFORE any network round-trip", async () => {
    const { deps, steer } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["steer", "sess-1"], { from: "user" })).rejects.toThrow(
      /steer requires one of --prompt/,
    );
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects two steer verbs at once (ambiguous) before any network round-trip", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "go", "--approve"], { from: "user" }),
    ).rejects.toThrow(/exactly one of --prompt, --approve, or --interrupt/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects --tool-use-id without --approve", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "go", "--tool-use-id", "tool-7"], { from: "user" }),
    ).rejects.toThrow(/--tool-use-id is only valid with --approve/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects a blank --prompt before any network round-trip", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "   "], { from: "user" }),
    ).rejects.toThrow(/--prompt requires non-empty text/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects a blank --interrupt before any network round-trip (same non-empty guard)", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--interrupt", "  "], { from: "user" }),
    ).rejects.toThrow(/--interrupt requires non-empty text/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects an invalid --port before contacting the daemon", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "go", "--port", "not-a-port"], { from: "user" }),
    ).rejects.toThrow(/invalid port/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("refuses a 0.0.0.0 daemon host (never the wildcard)", async () => {
    const { deps, steer } = makeDeps();
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "go", "--host", "0.0.0.0"], { from: "user" }),
    ).rejects.toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("propagates a daemon-side steer rejection (e.g. no live worker) as a rejection (→ non-zero exit)", async () => {
    const { deps } = makeDeps({
      steer: () =>
        Promise.reject(
          new Error("ccctl: session sess-1 has no live worker yet — it cannot be steered until its worker connects"),
        ),
    });
    await expect(
      buildProgram(deps).parseAsync(["steer", "sess-1", "--prompt", "go"], { from: "user" }),
    ).rejects.toThrow(/has no live worker yet/);
  });
});

describe("ccctl stop — the emergency stop (#77 AC2)", () => {
  it("stops the named session and reports the terminal state the daemon produced", async () => {
    const { deps, stop } = makeDeps();
    await buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" });
    expect(stop).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 }, "sess-1", { force: false });
    const text = loggedText();
    expect(text).toContain("stopped session sess-1 on http://127.0.0.1:4321");
    // The AC's "reflect the resulting terminal state" — carried from the daemon, not asserted here.
    expect(text).toContain("closed");
  });

  it("does NOT force by default — the destructive flag is opt-in, and a literal boolean on the wire", async () => {
    const { deps, stop } = makeDeps();
    await buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" });
    // `false`, not `undefined`: the daemon's parse refuses a non-boolean rather than coercing it, so
    // the destructive field's correctness must not rest on how JSON.stringify treats `undefined`.
    expect(stop).toHaveBeenCalledWith(expect.anything(), "sess-1", { force: false });
  });

  it("forces on --force — the operator saying yes to killing a session they have taken over", async () => {
    const { deps, stop } = makeDeps();
    await buildProgram(deps).parseAsync(["stop", "sess-1", "--force"], { from: "user" });
    expect(stop).toHaveBeenCalledWith(expect.anything(), "sess-1", { force: true });
  });

  it("reports an already-exited surface honestly rather than claiming a kill it did not make", async () => {
    const { deps } = makeDeps({
      stop: (_target, sessionId) => Promise.resolve({ sessionId, outcome: "already-exited", status: "closed" }),
    });
    await buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" });
    const text = loggedText();
    // Names the daemon that answered, like every other branch: `--host`/`--port` exist because there
    // can be more than one.
    expect(text).toContain("session sess-1 on http://127.0.0.1:4321 had already exited — closed");
    // The daemon declined to claim a kill here, so neither may the CLI.
    expect(text).not.toContain("stopped session");
  });

  it("degrades an outcome this build does not recognize instead of calling it an already-exited surface", async () => {
    // `ccctl` can be older than the daemon it drives, so a future outcome is reachable here (the
    // client's reader admits any string). "It had already exited" is a SPECIFIC claim about what
    // happened to the session — the kind this verb must never invent — so an unrecognized outcome
    // gets a neutral sentence instead. The web UI's reader degrades the same way, which is what
    // makes the two surfaces one contract read twice rather than two guesses.
    const { deps } = makeDeps({
      stop: (_target, sessionId) =>
        // Cast: the wire type names two outcomes, and the point of this test is the third one a
        // newer daemon could send.
        Promise.resolve({ sessionId, outcome: "vaporized", status: "closed" } as unknown as StopAcceptedWire),
    });
    await buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" });
    const text = loggedText();
    expect(text).toContain("session sess-1 on http://127.0.0.1:4321 is stopped — closed");
    expect(text).not.toContain("had already exited");
    expect(text).not.toContain("stopped session");
  });

  it("carries an `errored` terminal status rather than flattening every stop to `closed`", async () => {
    const { deps } = makeDeps({
      stop: (_target, sessionId) => Promise.resolve({ sessionId, outcome: "stopped", status: "errored" }),
    });
    await buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" });
    // A stop does not overwrite the diagnosis of a session that had already failed on its own.
    expect(loggedText()).toContain("stopped session sess-1 on http://127.0.0.1:4321 — errored");
  });

  it("stops against an explicit --host and --port", async () => {
    const { deps, stop } = makeDeps();
    await buildProgram(deps).parseAsync(["stop", "sess-1", "--host", "127.0.0.1", "--port", "9999"], { from: "user" });
    expect(stop).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9999 }, "sess-1", { force: false });
  });

  it("surfaces a REFUSED stop as a rejection — never a quiet success over a live session", async () => {
    // The whole value of the verb is that the operator can believe its answer and stop watching, so
    // `ccctl stop X && echo done` must not print `done` for a session that is still running.
    // `cli.ts` turns this rejection into the non-zero exit that makes the `&&` hold.
    const { deps } = makeDeps({
      stop: () => Promise.reject(new Error("ccctl: session sess-1 has been taken over. Re-run with `--force`")),
    });
    await expect(buildProgram(deps).parseAsync(["stop", "sess-1"], { from: "user" })).rejects.toThrow(/taken over/);
    expect(loggedText()).not.toContain("stopped session");
  });

  it("requires a session id — a stop is never inferred (#20)", async () => {
    const { deps, stop } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["stop"], { from: "user" })).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a bad --port BEFORE any network round-trip — no side effects on a usage error", async () => {
    const { deps, stop } = makeDeps();
    await expect(buildProgram(deps).parseAsync(["stop", "sess-1", "--port", "nope"], { from: "user" })).rejects.toThrow(
      /invalid port/,
    );
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("ccctl revoke-all — the panic kill (#88 / W6-20)", () => {
  /** A registry of `count` paired devices, for seeding the fake device store. */
  function seededRegistry(count: number): DeviceStoreSnapshot {
    return {
      version: DEVICE_STORE_SNAPSHOT_VERSION,
      devices: Array.from({ length: count }, (_, index) =>
        pairedDevice({ id: `dev-${index + 1}`, name: `device ${index + 1}`, tokenHash: deviceTokenHash(`h${index}`) }),
      ),
    };
  }

  it("revokes every paired device in one action and reports the count + re-pair instruction (AC1)", async () => {
    const { deps, deviceSaves } = makeDeps({ deviceSnapshot: seededRegistry(3) });

    await buildProgram(deps).parseAsync(["revoke-all"], { from: "user" });

    expect(loggedText()).toContain("revoked 3 devices");
    expect(loggedText()).toContain("must re-pair");
    // The registry the store now holds is empty — every device's token hash is gone.
    expect(deviceSaves).toHaveLength(1);
    expect(deviceSaves[0]?.devices).toEqual([]);
  });

  it("says one device singularly — a panic kill of a single paired device", async () => {
    const { deps } = makeDeps({ deviceSnapshot: seededRegistry(1) });

    await buildProgram(deps).parseAsync(["revoke-all"], { from: "user" });

    expect(loggedText()).toContain("revoked 1 device —");
    expect(loggedText()).not.toContain("1 devices");
  });

  it("reports nothing to revoke — and writes nothing — when no device is paired (never-saved store)", async () => {
    const { deps, deviceSaves } = makeDeps({ deviceSnapshot: null });

    await buildProgram(deps).parseAsync(["revoke-all"], { from: "user" });

    expect(loggedText()).toContain("no devices are paired");
    // The nothing-to-revoke path must touch no disk — no fabricated empty registry saved.
    expect(deviceSaves).toHaveLength(0);
  });

  it("is adapter-agnostic — no tunnel is touched and no daemon is contacted (a local store op)", async () => {
    const { deps, establish, startServer, list } = makeDeps({ deviceSnapshot: seededRegistry(2) });

    await buildProgram(deps).parseAsync(["revoke-all"], { from: "user" });

    // A panic kill reaches neither a tunnel adapter nor the daemon's /api/sessions — it is a
    // direct device-store operation, which is what makes it work even when those are down.
    expect(establish).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
