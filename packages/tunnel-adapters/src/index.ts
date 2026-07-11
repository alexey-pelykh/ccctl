// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/tunnel-adapters` — pluggable tunnel adapters.
 *
 * One {@link ITunnel} lifecycle contract with interchangeable implementations,
 * so the CLI can expose the loopback-bound {@link https://ccctl | @ccctl/server}
 * through the user's tunnel of choice (Tailscale, Cloudflare, Headscale, …)
 * without the rest of the system knowing which. A tunnel's job is to make the
 * local {@link HostEndpoint} reachable and report back the public host the
 * worker's `--sdk-url` allowlist must then be told to permit.
 *
 * This slice implements Tailscale {@link TailscaleTunnel.establish | establish}
 * — bringing the tunnel up over the tailnet, reachable with no public IP and no
 * open inbound port. The rest of the {@link ITunnel} lifecycle (`status`,
 * `teardown`) and the Cloudflare / Headscale backends are still typed stubs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatAuthority, isLoopbackHost, type HostEndpoint } from "@ccctl/core";

/** Identifiers for the tunnel backends ccctl ships adapters for. */
export type TunnelKind = "tailscale" | "cloudflare" | "headscale";

/**
 * A tunnel brought up by {@link ITunnel.establish}: the public host clients
 * reach the loopback-bound server at. This host is exactly what the patched
 * worker's `--sdk-url` allowlist must then be told to permit.
 */
export interface EstablishedTunnel {
  /** Which backend produced this tunnel. */
  readonly kind: TunnelKind;
  /**
   * Public host clients reach the server at (goes into the SDK allowlist) — a
   * bare host (a MagicDNS name or a tailnet IP), so whoever renders it into a
   * URL brackets an IPv6 itself, exactly as {@link HostEndpoint.host} is treated.
   */
  readonly publicHost: string;
}

/**
 * Pluggable tunnel backend — one lifecycle contract, interchangeable
 * implementations. This slice defines `establish`; the rest of the lifecycle
 * (`status`, `teardown`) lands in a later item.
 */
export interface ITunnel {
  /** Which backend this tunnel drives. */
  readonly kind: TunnelKind;
  /**
   * Expose `local` through the tunnel and resolve, once it is reachable, with
   * the public host to permit. `local` must be a loopback endpoint — the server
   * binds loopback and the tunnel is its only path from off-box.
   */
  establish(local: HostEndpoint): Promise<EstablishedTunnel>;
}

// ---------------------------------------------------------------------------
// command-execution seam
//
// A tunnel that drives a CLI (Tailscale, below) spawns a child process. That
// spawn sits behind this injectable seam so `establish` is unit-testable with a
// fake runner — the codebase's determinism discipline: I/O is injected, never
// ambient. The real runner shells out; a test runner returns canned output.
// ---------------------------------------------------------------------------

/** The captured result of running a command to completion. */
export interface CommandOutput {
  /** Everything the command wrote to stdout. */
  readonly stdout: string;
  /** Everything the command wrote to stderr. */
  readonly stderr: string;
}

/** Runs a command to completion, rejecting if it exits non-zero. */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandOutput>;
}

const execFileAsync = promisify(execFile);

/**
 * stdout/stderr buffer cap for the default runner. `execFile`'s 1 MiB default
 * can be exceeded by `tailscale status --json` on a large tailnet (every peer is
 * serialized), which would reject `establish` for a purely environmental reason;
 * 16 MiB leaves ample headroom.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * The default {@link CommandRunner}: spawns via `node:child_process` `execFile`
 * — no shell, so arguments are never word-split or glob-expanded. `execFile`
 * rejects on a non-zero exit, which surfaces as the `establish` rejecting.
 */
export const defaultCommandRunner: CommandRunner = {
  async run(command: string, args: readonly string[]): Promise<CommandOutput> {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { stdout, stderr };
  },
};

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

/** The `tailscale` CLI binary the adapter drives. */
const TAILSCALE_BIN = "tailscale";

/**
 * The `Self` fields the adapter reads out of `tailscale status --json`. The CLI
 * emits far more; this is only the slice host resolution needs, and each field
 * is `unknown` because the process output is untrusted and read back defensively.
 */
interface TailscaleSelf {
  readonly DNSName?: unknown;
  readonly TailscaleIPs?: unknown;
}

/**
 * Tailscale {@link ITunnel}. `establish` brings the loopback endpoint up over
 * the tailnet with `tailscale serve` — reachable only inside the tailnet, so no
 * public IP and no open inbound port (in deliberate contrast to `tailscale
 * funnel`, which is public and is NOT used) — then resolves the node's tailnet
 * host from `tailscale status`.
 *
 * This is the thin `establish` slice: ACL provisioning and mandatory
 * tunnel-auth land with the complete adapter, and `status` / `teardown` with
 * the rest of the lifecycle.
 */
export class TailscaleTunnel implements ITunnel {
  readonly kind = "tailscale" as const;

  readonly #runner: CommandRunner;

  constructor(runner: CommandRunner = defaultCommandRunner) {
    this.#runner = runner;
  }

  async establish(local: HostEndpoint): Promise<EstablishedTunnel> {
    if (!isLoopbackHost(local.host)) {
      throw new Error(
        `ccctl: tailscale establish expects a loopback endpoint, got "${local.host}" — the server binds loopback and the tunnel is its only off-box path`,
      );
    }

    // Bring the endpoint up over the tailnet. `serve` (never `funnel`) keeps it
    // tailnet-private: reachable by the user's own devices, never the public
    // internet. `--bg` detaches, so `establish` resolves once it is serving.
    // `formatAuthority` brackets an IPv6 loopback (`[::1]:port`), so `::1` — a
    // host `isLoopbackHost` accepts — yields a valid URL, not `http://::1:port`.
    await this.#runner.run(TAILSCALE_BIN, ["serve", "--bg", `http://${formatAuthority(local.host, local.port)}`]);

    return { kind: this.kind, publicHost: await this.#resolveTailnetHost() };
  }

  /** Resolve this node's tailnet host from `tailscale status --json`. */
  async #resolveTailnetHost(): Promise<string> {
    const { stdout } = await this.#runner.run(TAILSCALE_BIN, ["status", "--json"]);
    const host = tailnetHostFromSelf(parseTailscaleSelf(stdout));
    if (host === null) {
      throw new Error(
        "ccctl: tailscale is serving but reported no tailnet host (DNSName / TailscaleIPs) — is it logged in?",
      );
    }
    return host;
  }
}

/** Pull the `Self` object out of `tailscale status --json`, defensively. */
function parseTailscaleSelf(stdout: string): TailscaleSelf {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("ccctl: tailscale status did not return valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ccctl: tailscale status JSON is not an object");
  }
  if (!("Self" in parsed)) {
    throw new Error("ccctl: tailscale status JSON has no `Self` — cannot resolve the tailnet host");
  }
  const self: unknown = parsed.Self;
  if (typeof self !== "object" || self === null) {
    throw new Error("ccctl: tailscale status `Self` is not an object");
  }
  // `self` is a non-null object; `TailscaleSelf`'s fields are all optional
  // `unknown`, so it is already assignable — each field is narrowed at its use.
  return self;
}

/**
 * The tailnet host for a node: its MagicDNS name (trailing dot stripped) when
 * present, else its first tailnet IP. `null` when the node reports neither —
 * i.e. it is not yet on a tailnet.
 */
function tailnetHostFromSelf(self: TailscaleSelf): string | null {
  const { DNSName, TailscaleIPs } = self;
  if (typeof DNSName === "string" && DNSName.trim() !== "") {
    // Strip the MagicDNS FQDN's trailing dot; trim first so no stray whitespace
    // from the (untrusted) status output survives into the allowlist host.
    return DNSName.trim().replace(/\.$/, "");
  }
  if (Array.isArray(TailscaleIPs)) {
    for (const ip of TailscaleIPs as readonly unknown[]) {
      if (typeof ip === "string" && ip.trim() !== "") {
        return ip;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// stubs — the backends this slice does not yet drive
// ---------------------------------------------------------------------------

/**
 * Shared skeleton behaviour for the not-yet-implemented backends: a rejected
 * `establish`, never a synchronous throw — so every {@link ITunnel} reports
 * failure the one way (a rejection a caller's `.catch` sees), matching the real
 * Tailscale path.
 */
function notImplemented(kind: TunnelKind): Promise<never> {
  return Promise.reject(new Error(`ccctl: ${kind} tunnel adapter is not implemented yet (skeleton)`));
}

/** Stub {@link ITunnel} for Cloudflare Tunnel. */
export class CloudflareTunnel implements ITunnel {
  readonly kind = "cloudflare" as const;

  establish(_local: HostEndpoint): Promise<EstablishedTunnel> {
    return notImplemented(this.kind);
  }
}

/** Stub {@link ITunnel} for Headscale (self-hosted Tailscale control plane). */
export class HeadscaleTunnel implements ITunnel {
  readonly kind = "headscale" as const;

  establish(_local: HostEndpoint): Promise<EstablishedTunnel> {
    return notImplemented(this.kind);
  }
}

/**
 * A factory per backend, keyed by {@link TunnelKind}. A factory (not a shared
 * singleton) because a tunnel is a stateful lifecycle object: each `establish`
 * gets its own instance so a later `status` / `teardown` acts on the right one.
 */
export const ADAPTERS: Record<TunnelKind, () => ITunnel> = {
  tailscale: () => new TailscaleTunnel(),
  cloudflare: () => new CloudflareTunnel(),
  headscale: () => new HeadscaleTunnel(),
};
