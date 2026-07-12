// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/tunnel-adapters` — pluggable tunnel adapters.
 *
 * One {@link Tunnel} lifecycle contract with interchangeable implementations,
 * so the CLI can expose the loopback-bound {@link https://ccctl | @ccctl/server}
 * through the user's tunnel of choice (Tailscale, Cloudflare, Headscale, …)
 * without the rest of the system knowing which. A tunnel's job is to make the
 * local {@link HostEndpoint} reachable and report back the public host the
 * worker's `--sdk-url` allowlist must then be told to permit.
 *
 * This item completes the Tailscale {@link Tunnel} adapter:
 * {@link TailscaleTunnel.establish | establish} brings the tunnel up over the
 * tailnet (no public IP and no open inbound port) and enforces mandatory
 * tunnel-auth — it refuses unless the node is an authenticated, connected
 * tailnet member, so an unauthorized device can never reach the daemon;
 * {@link TailscaleTunnel.status | status} reports whether it is up and the host
 * it is reachable at; and {@link TailscaleTunnel.teardown | teardown} releases
 * it cleanly. Which authenticated devices may reach the endpoint is governed by
 * the tailnet's own ACL policy — operator-owned central state the adapter relies
 * on and deliberately never provisions or overwrites. The Cloudflare / Headscale
 * backends are still to come.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatAuthority, isLoopbackHost, type HostEndpoint } from "@ccctl/core";

/** Identifiers for the tunnel backends ccctl ships adapters for. */
export type TunnelKind = "tailscale" | "cloudflare" | "headscale";

/**
 * A tunnel brought up by {@link Tunnel.establish}: the public host clients
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
 * The current lifecycle state of a {@link Tunnel}, as reported by
 * {@link Tunnel.status}: whether it is `up` and, when it is, the same
 * `publicHost` {@link Tunnel.establish} resolved — the AC's "reachable base",
 * the host the SDK allowlist is permitting right now. A discriminated union, so
 * an `up` status always carries a reachable host and a `down` one never claims a
 * base it lacks (illegal states unrepresentable, as elsewhere in this codebase).
 */
export type TunnelStatus =
  | { readonly kind: TunnelKind; readonly up: true; readonly publicHost: string }
  | { readonly kind: TunnelKind; readonly up: false };

/**
 * The `down` {@link TunnelStatus} for a backend — the one shape shared by a
 * torn-down (or never-established) Tailscale tunnel and the not-yet-implemented
 * stub backends.
 */
function downStatus(kind: TunnelKind): TunnelStatus {
  return { kind, up: false };
}

/**
 * Pluggable tunnel backend — one lifecycle contract, interchangeable
 * implementations: bring a loopback endpoint up ({@link establish}), report
 * whether it is up ({@link status}), and release it ({@link teardown}).
 */
export interface Tunnel {
  /** Which backend this tunnel drives. */
  readonly kind: TunnelKind;
  /**
   * Expose `local` through the tunnel and resolve, once it is reachable, with
   * the public host to permit. `local` must be a loopback endpoint — the server
   * binds loopback and the tunnel is its only path from off-box.
   */
  establish(local: HostEndpoint): Promise<EstablishedTunnel>;
  /**
   * Report the tunnel's current state — `up` (with the reachable public host)
   * once {@link establish} has succeeded, `down` before it has or after
   * {@link teardown}. Async at the interface level because a backend may have to
   * query a remote control plane to answer; a CLI-driven backend such as
   * Tailscale answers from the lifecycle state it tracks in-process.
   */
  status(): Promise<TunnelStatus>;
  /**
   * Release the tunnel {@link establish} brought up, leaving no mapping behind,
   * and return it to `down`. A clean no-op when nothing is established, so it is
   * always safe to call — e.g. from a shutdown path that does not know whether
   * {@link establish} ran.
   */
  teardown(): Promise<void>;
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
 * The one `BackendState` (from `tailscale status --json`) that means the node is
 * an authenticated, connected member of a tailnet. Every other state
 * (`NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting`, `NoState`, …) means
 * the tailnet's authentication is not in force, so the reachability guarantee
 * mandatory tunnel-auth rests on does not hold — {@link requireTailnetAuth}
 * refuses to establish in any of them.
 */
const TAILNET_RUNNING_STATE = "Running";

/**
 * The fields the adapter reads out of `tailscale status --json`. The CLI emits
 * far more; this is only the slice establish needs — `BackendState` to enforce
 * mandatory tunnel-auth and `Self` to resolve the reachable host — and each is
 * `unknown` because the process output is untrusted and read back defensively.
 */
interface TailscaleStatus {
  readonly BackendState?: unknown;
  readonly Self?: unknown;
}

/**
 * The `Self` fields host resolution needs, out of {@link TailscaleStatus}. Each
 * is `unknown` for the same reason: the status JSON is untrusted CLI output.
 */
interface TailscaleSelf {
  readonly DNSName?: unknown;
  readonly TailscaleIPs?: unknown;
}

/**
 * Tailscale {@link Tunnel}. `establish` brings the loopback endpoint up over
 * the tailnet with `tailscale serve` — reachable only inside the tailnet, so no
 * public IP and no open inbound port (in deliberate contrast to `tailscale
 * funnel`, which is public and is NOT used) — then reads `tailscale status`
 * once to both enforce mandatory tunnel-auth (it refuses unless the node is an
 * authenticated, connected tailnet member) and resolve the node's tailnet host.
 * `status` reports the tracked lifecycle state (up with the reachable host, or
 * down) and `teardown` turns that same serve mapping back off.
 *
 * The instance tracks what it served, so `status` / `teardown` act on exactly
 * the mapping this `establish` brought up — a fresh instance per `establish`
 * (see {@link ADAPTERS}). Which authenticated devices may actually reach the
 * endpoint is governed by the tailnet's own ACL policy — operator-owned central
 * state the adapter relies on and deliberately never provisions or overwrites
 * (mutating it per-establish would clobber the operator's hand-authored policy,
 * exactly the blunt-instrument reach `teardown` avoids by not running `serve
 * reset`).
 */
export class TailscaleTunnel implements Tunnel {
  readonly kind = "tailscale" as const;

  readonly #runner: CommandRunner;

  /**
   * The loopback endpoint currently served, recorded the moment `tailscale
   * serve` succeeds — before the tailnet host is resolved — so `teardown` can
   * turn the mapping back off even if `establish` later rejected while resolving
   * the host (a half-up serve is still cleanly releasable). `null` when nothing
   * is served: before `establish`, or after `teardown`.
   */
  #servedLocal: HostEndpoint | null = null;

  /**
   * The fully-resolved tunnel — set only once `establish` has both served the
   * endpoint and resolved its reachable host. `status` reports `up` exactly when
   * this is non-`null`; a serve that came up but never resolved a host is not a
   * usable `up` (no reachable base to report), though `#servedLocal` still lets
   * `teardown` release it.
   */
  #established: EstablishedTunnel | null = null;

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
    await this.#runner.run(TAILSCALE_BIN, ["serve", "--bg", this.#serveTarget(local)]);
    // The mapping is up now; record it before verifying auth / resolving the host
    // so `teardown` can release it even if either step below throws — a half-up
    // serve (e.g. brought up on a node that turns out not to be authenticated)
    // stays cleanly releasable.
    this.#servedLocal = local;

    const established: EstablishedTunnel = { kind: this.kind, publicHost: await this.#resolveReachableHost() };
    this.#established = established;
    return established;
  }

  status(): Promise<TunnelStatus> {
    // Answered from tracked lifecycle state — no `tailscale` call. The instance
    // owns its serve mapping (a fresh one per `establish`, see ADAPTERS), so its
    // own record IS the current state; `status` is async only to satisfy the
    // backend-agnostic interface (a remote-API backend may need to query).
    const established = this.#established;
    return Promise.resolve(
      established === null ? downStatus(this.kind) : { kind: this.kind, up: true, publicHost: established.publicHost },
    );
  }

  async teardown(): Promise<void> {
    const served = this.#servedLocal;
    if (served === null) {
      return; // Nothing established (or already torn down) — a clean no-op.
    }
    // Turn off exactly the mapping `establish` turned on: the same serve target
    // plus a trailing `off` (`tailscale serve --bg <target> off`). Targeted, so
    // only THIS tunnel is released — never other `tailscale serve` config the
    // user may run, which the blunter `tailscale serve reset` would clobber.
    await this.#runner.run(TAILSCALE_BIN, ["serve", "--bg", this.#serveTarget(served), "off"]);
    // Clear state only after the off command succeeds; if it rejected, the
    // tunnel stays established so the caller can retry `teardown`.
    this.#servedLocal = null;
    this.#established = null;
  }

  /** The `tailscale serve` HTTP target for a loopback endpoint (IPv6 bracketed). */
  #serveTarget(local: HostEndpoint): string {
    return `http://${formatAuthority(local.host, local.port)}`;
  }

  /**
   * Read `tailscale status --json` ONCE and, from that single read, both enforce
   * mandatory tunnel-auth and resolve this node's reachable tailnet host — in
   * that order, so an unauthenticated node is refused before any reachable base
   * is reported. Reusing the one status read host resolution already needs keeps
   * the auth gate free of extra process I/O.
   */
  async #resolveReachableHost(): Promise<string> {
    const { stdout } = await this.#runner.run(TAILSCALE_BIN, ["status", "--json"]);
    const status = parseTailscaleStatus(stdout);
    // Mandatory tunnel-auth: refuse unless the node is a Running, authenticated
    // tailnet member — the precondition the "unauthorized device cannot reach the
    // daemon" guarantee rests on. Checked before host resolution: never report a
    // reachable base the tailnet's authentication is not actually backing.
    requireTailnetAuth(status);
    const host = tailnetHostFromSelf(selfFromStatus(status));
    if (host === null) {
      throw new Error(
        "ccctl: tailscale is serving but reported no tailnet host (DNSName / TailscaleIPs) — is it logged in?",
      );
    }
    return host;
  }
}

/** Parse `tailscale status --json` into its top-level object, defensively. */
function parseTailscaleStatus(stdout: string): TailscaleStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("ccctl: tailscale status did not return valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ccctl: tailscale status JSON is not an object");
  }
  // A non-null, non-array object; `TailscaleStatus`'s fields are all optional
  // `unknown`, so it is already assignable — each field is narrowed at its use.
  return parsed;
}

/**
 * Enforce mandatory tunnel-auth: throw unless the status reports the node as a
 * {@link TAILNET_RUNNING_STATE | Running} — authenticated and connected —
 * tailnet member. Fail closed: any other, absent, or non-string `BackendState`
 * is treated as auth-not-in-force and rejected, so the tunnel is never reported
 * up in a posture where an unauthorized device might reach the daemon.
 */
function requireTailnetAuth(status: TailscaleStatus): void {
  const { BackendState } = status;
  if (BackendState === TAILNET_RUNNING_STATE) {
    return;
  }
  const reported = typeof BackendState === "string" && BackendState.trim() !== "" ? BackendState : "unset";
  throw new Error(
    `ccctl: tailscale is not an authenticated tailnet member (BackendState=${reported}) — refusing to expose the daemon without mandatory tunnel-auth; run \`tailscale up\` to join a tailnet first`,
  );
}

/** Pull the `Self` object out of a parsed {@link TailscaleStatus}, defensively. */
function selfFromStatus(status: TailscaleStatus): TailscaleSelf {
  if (!("Self" in status)) {
    throw new Error("ccctl: tailscale status JSON has no `Self` — cannot resolve the tailnet host");
  }
  const self: unknown = status.Self;
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
 * `establish`, never a synchronous throw — so every {@link Tunnel} reports
 * failure the one way (a rejection a caller's `.catch` sees), matching the real
 * Tailscale path.
 *
 * Only `establish` is the unimplemented capability, so only it rejects. A
 * backend that never establishes is honestly `down` and has nothing to release,
 * so its `status` / `teardown` answer normally ({@link downStatus} / a no-op)
 * rather than reject — keeping the whole lifecycle total across every backend.
 */
function notImplemented(kind: TunnelKind): Promise<never> {
  return Promise.reject(new Error(`ccctl: ${kind} tunnel adapter is not implemented yet (skeleton)`));
}

/** Stub {@link Tunnel} for Cloudflare Tunnel. */
export class CloudflareTunnel implements Tunnel {
  readonly kind = "cloudflare" as const;

  establish(_local: HostEndpoint): Promise<EstablishedTunnel> {
    return notImplemented(this.kind);
  }

  status(): Promise<TunnelStatus> {
    return Promise.resolve(downStatus(this.kind));
  }

  teardown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Stub {@link Tunnel} for Headscale (self-hosted Tailscale control plane). */
export class HeadscaleTunnel implements Tunnel {
  readonly kind = "headscale" as const;

  establish(_local: HostEndpoint): Promise<EstablishedTunnel> {
    return notImplemented(this.kind);
  }

  status(): Promise<TunnelStatus> {
    return Promise.resolve(downStatus(this.kind));
  }

  teardown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A factory per backend, keyed by {@link TunnelKind}. A factory (not a shared
 * singleton) because a tunnel is a stateful lifecycle object: each `establish`
 * gets its own instance so a later `status` / `teardown` acts on the right one.
 */
export const ADAPTERS: Record<TunnelKind, () => Tunnel> = {
  tailscale: () => new TailscaleTunnel(),
  cloudflare: () => new CloudflareTunnel(),
  headscale: () => new HeadscaleTunnel(),
};
