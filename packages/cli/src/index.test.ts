// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SERVER_AUTH_ENV, type CcctlServer } from "@ccctl/server";
import type { EstablishedTunnel, Tunnel, TunnelKind } from "@ccctl/tunnel-adapters";
import type { CliDependencies } from "./dependencies.js";
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
}

/** Build fake {@link CliDependencies} plus handles to the spies the assertions read. */
function makeDeps(options: FakeDepsOptions = {}): {
  deps: CliDependencies;
  startServer: ReturnType<typeof vi.fn>;
  establish: ReturnType<typeof vi.fn>;
  runPatcher: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
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
  return { deps: { startServer, adapters, runPatcher }, startServer, establish, runPatcher, close };
}

const originalAuth = process.env[LOCAL_SERVER_AUTH_ENV];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  if (originalAuth === undefined) {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
  } else {
    process.env[LOCAL_SERVER_AUTH_ENV] = originalAuth;
  }
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
    const { deps, startServer, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["serve"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    expect(establish).not.toHaveBeenCalled();
    expect(loggedText()).toContain("http://127.0.0.1:4321");
  });

  it("passes an explicit loopback --host and --port through to the daemon", async () => {
    const { deps, startServer } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--host", "127.0.0.1", "--port", "8080"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8080 });
    expect(loggedText()).toContain("http://127.0.0.1:8080");
  });

  it("reports the RESOLVED ephemeral port (from server.address), not the requested --port 0", async () => {
    const { deps, startServer } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--port", "0"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });
    expect(loggedText()).toContain("http://127.0.0.1:55555");
  });
});

describe("ccctl serve --tunnel — composes daemon + tunnel (AC4)", () => {
  beforeEach(() => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
  });

  it("starts the daemon THEN establishes the tunnel against the bound address, reporting the public host", async () => {
    const { deps, startServer, establish } = makeDeps();
    await buildProgram(deps).parseAsync(["serve", "--tunnel", "tailscale"], { from: "user" });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
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
