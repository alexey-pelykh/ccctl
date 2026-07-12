// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { HostEndpoint } from "@ccctl/core";
import {
  ADAPTERS,
  CloudflareTunnel,
  HeadscaleTunnel,
  TailscaleTunnel,
  type CommandOutput,
  type CommandRunner,
  type TunnelKind,
} from "./index.js";

/** A recorded invocation of the {@link CommandRunner}. */
interface RecordedCall {
  command: string;
  args: readonly string[];
}

/**
 * A {@link CommandRunner} that records every call and answers from a handler —
 * the injected I/O seam, so `establish` is exercised with no real `tailscale`
 * binary and no real tailnet.
 */
function fakeRunner(handler: (call: RecordedCall) => CommandOutput): {
  runner: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    run(command, args) {
      const call = { command, args };
      calls.push(call);
      return Promise.resolve(handler(call));
    },
  };
  return { runner, calls };
}

/**
 * `tailscale status --json` output for a node — authenticated (`BackendState:
 * "Running"`) by default, so every existing establish path exercises the happy
 * tunnel-auth case; pass a different `backendState` to exercise the auth gate.
 */
function statusJson(self: Record<string, unknown>, backendState = "Running"): CommandOutput {
  return { stdout: JSON.stringify({ BackendState: backendState, Self: self }), stderr: "" };
}

const LOOPBACK: HostEndpoint = { host: "127.0.0.1", port: 4321 };

/** Route `serve` vs `status` so one handler can answer both `establish` calls. */
function tailscaleHandler(status: CommandOutput): (call: RecordedCall) => CommandOutput {
  return ({ args }) => (args[0] === "status" ? status : { stdout: "", stderr: "" });
}

describe("TailscaleTunnel.establish (AC: brings a Tailscale tunnel up)", () => {
  it("serves the loopback endpoint and reports the MagicDNS host", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "phone-host.tail-scale.ts.net." })));

    const established = await new TailscaleTunnel(runner).establish(LOOPBACK);

    // The trailing dot on the MagicDNS FQDN is stripped for the allowlist host.
    expect(established).toEqual({ kind: "tailscale", publicHost: "phone-host.tail-scale.ts.net" });
    // Brings the endpoint up, then resolves the tailnet host — in that order.
    expect(calls.map((c) => c.args)).toEqual([
      ["serve", "--bg", "http://127.0.0.1:4321"],
      ["status", "--json"],
    ]);
    expect(calls.every((c) => c.command === "tailscale")).toBe(true);
  });

  it("stays tailnet-private: serves, never funnels (AC: no public IP / open ports)", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner).establish(LOOPBACK);

    const verbs = calls.map((c) => c.args[0]);
    expect(verbs).toContain("serve");
    expect(verbs).not.toContain("funnel");
  });

  it("brackets an IPv6 loopback in the serve URL (`::1` → `http://[::1]:port`)", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner).establish({ host: "::1", port: 4321 });

    // Without RFC 3986 bracketing this would be the malformed `http://::1:4321`.
    expect(calls[0].args).toEqual(["serve", "--bg", "http://[::1]:4321"]);
  });

  it("accepts the `localhost` loopback form", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner).establish({ host: "localhost", port: 8080 });

    expect(calls[0].args).toEqual(["serve", "--bg", "http://localhost:8080"]);
  });

  it("falls back to the first tailnet IP when there is no MagicDNS name", async () => {
    const { runner } = fakeRunner(
      tailscaleHandler(statusJson({ DNSName: "", TailscaleIPs: ["100.101.102.103", "fd7a::1"] })),
    );

    const established = await new TailscaleTunnel(runner).establish(LOOPBACK);

    expect(established.publicHost).toBe("100.101.102.103");
  });

  it("treats a whitespace-only DNSName as absent and falls back to the tailnet IP", async () => {
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "   ", TailscaleIPs: ["100.64.0.9"] })));

    const established = await new TailscaleTunnel(runner).establish(LOOPBACK);

    expect(established.publicHost).toBe("100.64.0.9");
  });

  it("rejects a non-loopback endpoint and runs no command", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "", stderr: "" }));

    await expect(new TailscaleTunnel(runner).establish({ host: "10.0.0.5", port: 4321 })).rejects.toThrow(/loopback/);
    expect(calls).toHaveLength(0);
  });

  it("rejects when the node is on no tailnet (no DNSName, no IPs)", async () => {
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ TailscaleIPs: [] })));

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/no tailnet host/);
  });

  it("rejects when `tailscale status` is not valid JSON", async () => {
    const { runner } = fakeRunner(tailscaleHandler({ stdout: "not json", stderr: "" }));

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/valid JSON/);
  });

  it("rejects when `tailscale status` JSON is not an object", async () => {
    const { runner } = fakeRunner(tailscaleHandler({ stdout: "42", stderr: "" }));

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/JSON is not an object/);
  });

  it("rejects when `tailscale status` JSON has no `Self`", async () => {
    // Authenticated (`Running`) so it clears the auth gate and reaches the Self check.
    const { runner } = fakeRunner(
      tailscaleHandler({ stdout: JSON.stringify({ BackendState: "Running", Peer: {} }), stderr: "" }),
    );

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/has no/);
  });

  it("rejects when `tailscale status` `Self` is not an object", async () => {
    const { runner } = fakeRunner(
      tailscaleHandler({ stdout: JSON.stringify({ BackendState: "Running", Self: "nope" }), stderr: "" }),
    );

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/Self.+not an object/);
  });

  it("propagates a runner failure (e.g. tailscale not installed / exits non-zero)", async () => {
    const boom = new Error("spawn tailscale ENOENT");
    const runner: CommandRunner = { run: () => Promise.reject(boom) };

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toBe(boom);
  });
});

describe("TailscaleTunnel mandatory tunnel-auth (AC: an unauthorized device cannot reach the daemon)", () => {
  it("refuses unless the node is an authenticated tailnet member (BackendState != Running)", async () => {
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." }, "NeedsLogin")));

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/mandatory tunnel-auth/);
  });

  it("names the reported backend state in the refusal, so the operator knows why", async () => {
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." }, "NeedsLogin")));

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/BackendState=NeedsLogin/);
  });

  it("fails closed when the status reports no BackendState at all", async () => {
    // A well-formed status with a resolvable host but no `BackendState`: absence of
    // proof of auth is treated as auth-not-in-force, never waved through.
    const { runner } = fakeRunner(
      tailscaleHandler({ stdout: JSON.stringify({ Self: { DNSName: "host.ts.net." } }), stderr: "" }),
    );

    await expect(new TailscaleTunnel(runner).establish(LOOPBACK)).rejects.toThrow(/mandatory tunnel-auth/);
  });

  it("leaves the serve releasable when the auth gate rejects (half-up, AC: clean release)", async () => {
    // `serve` succeeds, then the auth gate rejects — the mapping is up but is not a
    // usable tunnel. It must stay releasable, exactly like a half-up host-resolution failure.
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." }, "Stopped")));
    const tunnel = new TailscaleTunnel(runner);

    await expect(tunnel.establish(LOOPBACK)).rejects.toThrow(/mandatory tunnel-auth/);
    // Not a usable `up` (auth was never in force) — reports down …
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });

    await tunnel.teardown();
    // … yet teardown still turns the dangling serve mapping off.
    expect(calls.some((c) => c.args.join(" ") === "serve --bg http://127.0.0.1:4321 off")).toBe(true);
  });

  it("provisions no ACL policy — relies on the operator's, driving only `serve` + `status`", async () => {
    // Which authenticated devices may reach the endpoint is the tailnet's own,
    // operator-owned ACL policy; the adapter relies on it and never provisions or
    // overwrites it. A completed establish drives exactly `serve` then `status` —
    // never `set`, `funnel`, `up`, or any other tailnet-policy write.
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner).establish(LOOPBACK);

    expect(calls.map((c) => c.args[0])).toEqual(["serve", "status"]);
  });
});

describe("TailscaleTunnel status + teardown (AC: status up/down/reachable base, clean teardown)", () => {
  it("is down before establish, up with the reachable host after, down again after teardown", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "phone-host.tail-scale.ts.net." })));
    const tunnel = new TailscaleTunnel(runner);

    // Fresh instance: nothing established yet.
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });

    await tunnel.establish(LOOPBACK);
    // Up, reporting the reachable base — the same host `establish` resolved.
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: true, publicHost: "phone-host.tail-scale.ts.net" });

    await tunnel.teardown();
    // Turned off exactly what was served (establish args + `off`), back to down.
    expect(calls[calls.length - 1].args).toEqual(["serve", "--bg", "http://127.0.0.1:4321", "off"]);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });
  });

  it("teardown brackets an IPv6 loopback in the off-target too (`::1` → `http://[::1]:port`)", async () => {
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner);

    await tunnel.establish({ host: "::1", port: 4321 });
    await tunnel.teardown();

    expect(calls[calls.length - 1].args).toEqual(["serve", "--bg", "http://[::1]:4321", "off"]);
  });

  it("teardown is a clean no-op before establish (nothing to release, runs no command)", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const tunnel = new TailscaleTunnel(runner);

    await tunnel.teardown();

    expect(calls).toHaveLength(0);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });
  });

  it("teardown still releases a serve that came up but whose host never resolved (AC: clean release)", async () => {
    // `serve` succeeds; `status` reports no tailnet host, so `establish` rejects
    // AFTER the mapping is up. The mapping must remain releasable.
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ TailscaleIPs: [] })));
    const tunnel = new TailscaleTunnel(runner);

    await expect(tunnel.establish(LOOPBACK)).rejects.toThrow(/no tailnet host/);
    // Not a usable `up` (no reachable base was resolved) — reports down …
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });

    await tunnel.teardown();
    // … yet teardown still turns the dangling serve mapping off.
    expect(calls.some((c) => c.args.join(" ") === "serve --bg http://127.0.0.1:4321 off")).toBe(true);
  });

  it("stays up when the teardown off-command fails, so it can be retried", async () => {
    const boom = new Error("tailscale serve off failed");
    const runner: CommandRunner = {
      run(_command, args) {
        if (args.includes("off")) return Promise.reject(boom);
        if (args[0] === "status") return Promise.resolve(statusJson({ DNSName: "host.ts.net." }));
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    };
    const tunnel = new TailscaleTunnel(runner);
    await tunnel.establish(LOOPBACK);

    await expect(tunnel.teardown()).rejects.toBe(boom);
    // Off failed → state not cleared → still up, so a caller can retry teardown.
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: true, publicHost: "host.ts.net" });
  });
});

describe("stub backends (AC: only Tailscale establish is in scope for this slice)", () => {
  it("CloudflareTunnel.establish rejects as not implemented", async () => {
    expect(new CloudflareTunnel().kind).toBe("cloudflare");
    await expect(new CloudflareTunnel().establish(LOOPBACK)).rejects.toThrow(/not implemented yet/);
  });

  it("HeadscaleTunnel.establish rejects as not implemented", async () => {
    expect(new HeadscaleTunnel().kind).toBe("headscale");
    await expect(new HeadscaleTunnel().establish(LOOPBACK)).rejects.toThrow(/not implemented yet/);
  });

  it("a never-established stub reports down and its teardown is a no-op", async () => {
    for (const tunnel of [new CloudflareTunnel(), new HeadscaleTunnel()]) {
      expect(await tunnel.status()).toEqual({ kind: tunnel.kind, up: false });
      await expect(tunnel.teardown()).resolves.toBeUndefined();
    }
  });
});

describe("ADAPTERS registry (consumed by @ccctl/cli)", () => {
  it("has a factory for every tunnel kind", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["cloudflare", "headscale", "tailscale"]);
  });

  it("each factory produces a fresh tunnel of the matching kind", () => {
    for (const kind of Object.keys(ADAPTERS) as TunnelKind[]) {
      const first = ADAPTERS[kind]();
      const second = ADAPTERS[kind]();
      expect(first.kind).toBe(kind);
      // Fresh instance per call — a tunnel is a stateful lifecycle object.
      expect(first).not.toBe(second);
    }
  });
});
