// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEndpoint } from "@ccctl/core";
import {
  LOCAL_SERVER_AUTH_ENV,
  XDG_CONFIG_HOME_ENV,
  type CcctlServer,
  type ISessionLauncher,
  type LaunchAcceptedWire,
  type LaunchedSession,
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
  /** Override the session-client `launch` (e.g. to reject); defaults to an attachable tmux surface. */
  readonly launch?: (target: HostEndpoint, options: SessionLaunchOptions) => Promise<LaunchAcceptedWire>;
  /** Override the session-client `list` (e.g. to reject or seed sessions); defaults to an empty list. */
  readonly list?: (target: HostEndpoint) => Promise<SessionSummaryWire[]>;
  /** Override the session-client `steer` (e.g. to reject); defaults to an accepted steer returning a correlation id. */
  readonly steer?: (target: HostEndpoint, sessionId: string, command: SteerCommand) => Promise<string>;
  /** Override the session-client `stop` (e.g. to reject with a typed refusal); defaults to a successful kill. */
  readonly stop?: (target: HostEndpoint, sessionId: string, options: SessionStopOptions) => Promise<StopAcceptedWire>;
}

/** Build fake {@link CliDependencies} plus handles to the spies the assertions read. */
function makeDeps(options: FakeDepsOptions = {}): {
  deps: CliDependencies;
  startServer: ReturnType<typeof vi.fn>;
  establish: ReturnType<typeof vi.fn>;
  runPatcher: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  launcher: ISessionLauncher;
  renderQr: ReturnType<typeof vi.fn>;
} {
  // A fake bind: echo the requested host, and resolve `--port 0` to a concrete ephemeral
  // port so a test can prove `server.address` (not the requested port) is what's reported.
  const close = vi.fn(() => Promise.resolve());
  const startServer = vi.fn((config: { host?: string; port: number }) =>
    Promise.resolve(makeServer(config.host ?? "127.0.0.1", config.port === 0 ? 55555 : config.port, close)),
  );
  const establish = vi.fn(
    options.establish ??
      ((_local: { host: string; port: number }) =>
        Promise.resolve({ kind: "tailscale", publicHost: "oracle-node.tailnet.ts.net" } satisfies EstablishedTunnel)),
  );
  const makeTunnel = (kind: TunnelKind): Tunnel => ({
    kind,
    establish,
    status: () => Promise.resolve({ kind, up: false }),
    teardown: () => Promise.resolve(),
  });
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
  return {
    deps: { startServer, adapters, runPatcher, sessionClient, launcher, renderQr },
    startServer,
    establish,
    runPatcher,
    close,
    launch,
    list,
    steer,
    stop,
    launcher,
    renderQr,
  };
}

const originalAuth = process.env[LOCAL_SERVER_AUTH_ENV];
const originalXdgConfigHome = process.env[XDG_CONFIG_HOME_ENV];
let logSpy: ReturnType<typeof vi.spyOn>;
let xdgConfigDir: string;

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  // Isolate the #57 config-file auth source: point $XDG_CONFIG_HOME at a fresh empty dir
  // so `serve`'s auth guard never finds a real ~/.config/ccctl/local-server-auth. The env
  // var stays the only auth these tests configure — a refuse-path test that deletes it must
  // deterministically refuse, not silently start off a developer's stray on-disk secret.
  xdgConfigDir = await mkdtemp(join(tmpdir(), "ccctl-cli-xdg-"));
  process.env[XDG_CONFIG_HOME_ENV] = xdgConfigDir;
});

afterEach(async () => {
  logSpy.mockRestore();
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
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321, launcher });
    expect(establish).not.toHaveBeenCalled();
    expect(loggedText()).toContain("http://127.0.0.1:4321");
  });

  it("passes an explicit loopback --host and --port through to the daemon", async () => {
    const { deps, startServer, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--host", "127.0.0.1", "--port", "8080"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8080, launcher });
    expect(loggedText()).toContain("http://127.0.0.1:8080");
  });

  it("reports the RESOLVED ephemeral port (from server.address), not the requested --port 0", async () => {
    const { deps, startServer, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--port", "0"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0, launcher });
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
});

describe("ccctl serve --tunnel — composes daemon + tunnel (AC4)", () => {
  beforeEach(() => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
  });

  it("starts the daemon THEN establishes the tunnel against the bound address, reporting the public host", async () => {
    const { deps, startServer, establish, launcher } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321, launcher });
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
