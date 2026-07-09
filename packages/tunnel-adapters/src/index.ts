// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/tunnel-adapters` — pluggable tunnel adapters.
 *
 * One {@link TunnelAdapter} interface with interchangeable implementations, so
 * the CLI can expose the loopback-bound {@link https://ccctl | @ccctl/server}
 * through the user's tunnel of choice (Tailscale, Cloudflare, Headscale, …)
 * without the rest of the system knowing which. An adapter's job is to make the
 * local {@link HostEndpoint} reachable and report back the public host the
 * worker's `--sdk-url` allowlist must then be told to permit.
 *
 * This is a skeleton: every adapter's `open` is a typed stub.
 */

import type { HostEndpoint } from "@ccctl/core";

/** Identifiers for the tunnel backends ccctl ships adapters for. */
export type TunnelKind = "tailscale" | "cloudflare" | "headscale";

/** A live tunnel exposing a local endpoint at some public host. */
export interface TunnelHandle {
  /** Which backend produced this tunnel. */
  readonly kind: TunnelKind;
  /** Public host clients reach the server at (goes into the SDK allowlist). */
  readonly publicHost: string;
  /** Tear the tunnel down. */
  close(): Promise<void>;
}

/** Pluggable tunnel backend. Implementations are interchangeable. */
export interface TunnelAdapter {
  /** Which backend this adapter drives. */
  readonly kind: TunnelKind;
  /** Expose `local` through the tunnel and resolve once it is reachable. */
  open(local: HostEndpoint): Promise<TunnelHandle>;
}

/** Shared skeleton behaviour for the stub adapters. */
function notImplemented(kind: TunnelKind): never {
  throw new Error(`ccctl: ${kind} tunnel adapter is not implemented yet (skeleton)`);
}

/** Stub adapter for Tailscale. */
export const tailscaleAdapter: TunnelAdapter = {
  kind: "tailscale",
  open: (_local: HostEndpoint): Promise<TunnelHandle> => notImplemented("tailscale"),
};

/** Stub adapter for Cloudflare Tunnel. */
export const cloudflareAdapter: TunnelAdapter = {
  kind: "cloudflare",
  open: (_local: HostEndpoint): Promise<TunnelHandle> => notImplemented("cloudflare"),
};

/** Stub adapter for Headscale (self-hosted Tailscale control plane). */
export const headscaleAdapter: TunnelAdapter = {
  kind: "headscale",
  open: (_local: HostEndpoint): Promise<TunnelHandle> => notImplemented("headscale"),
};

/** All bundled adapters, keyed by backend. */
export const ADAPTERS: Record<TunnelKind, TunnelAdapter> = {
  tailscale: tailscaleAdapter,
  cloudflare: cloudflareAdapter,
  headscale: headscaleAdapter,
};
