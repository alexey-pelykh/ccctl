// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Baseline startup guarantees for the local server (security-posture.md §
 * "Baseline posture"). Two properties must hold before the daemon accepts a
 * connection, and they ride along on the walking skeleton (#14):
 *
 *   - **Refuse start without auth.** Authentication is mandatory — there is no
 *     unauthenticated mode, not even on loopback. {@link requireLocalServerAuth}
 *     fails closed when no local-server auth is configured, so the daemon exits
 *     rather than serving open.
 *   - **Localhost-bind.** The listener binds a loopback address ({@link DEFAULT_HOST} by
 *     default) and NEVER a non-loopback one; nothing is reachable off-box until an explicit
 *     tunnel is attached. {@link resolveBindHost} refuses every non-loopback host.
 *
 * The localhost-bind guard is now COMPLETE to spec (#58): {@link resolveBindHost} is an
 * allowlist — it honours only a loopback bind (any `127.0.0.0/8` / `::1` / `localhost`) and
 * refuses EVERY non-loopback address (the `0.0.0.0` wildcard, the `::` IPv6 wildcard, a LAN
 * IP, a public IP), and {@link startServer} applies it on the actual bind path so the
 * guarantee is not silently overridable by an embedder (it holds on every start path, not
 * only the CLI edge). The baseline slice (#14) refused only `0.0.0.0`. The refuse-start-without-auth guard is now
 * COMPLETE to spec (#57): {@link requireLocalServerAuth} reads the secret from either the
 * {@link LOCAL_SERVER_AUTH_ENV} env var or the {@link resolveLocalServerAuthPath} config
 * file, treats a present-but-blank value on EITHER source as no auth, and — when neither
 * is configured — refuses with an actionable error naming the env key AND the config-file
 * path it looked for AND how to configure either. Provisioning, scoping, storage-format,
 * and rotation of the secret (the fuller credential boundary) stay deferred
 * (security-posture.md § "Credential boundary"); this completes only the refusal. Keeping
 * the guards here, pure and injectable, lets both the daemon ({@link https://ccctl |
 * @ccctl/cli}'s `serve`) and any future embedder apply the same baseline, and lets the
 * properties be unit-tested without binding a socket or touching the real filesystem.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isLoopbackHost } from "@ccctl/core";

/**
 * Default loopback bind host — nothing is exposed without an explicit tunnel.
 * The localhost-bind guarantee (security-posture.md) starts here: absent an
 * override the daemon binds loopback, and {@link resolveBindHost} refuses the
 * off-box wildcard.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The environment variable the local server reads the auth secret from — the PRIMARY of
 * the two provisioning sources (#57), taking precedence over the {@link
 * resolveLocalServerAuthPath} config file. Kept as a named constant so the daemon, the
 * refusal message, and the tests all reference the one key.
 */
export const LOCAL_SERVER_AUTH_ENV = "CCCTL_LOCAL_SERVER_AUTH";

/**
 * The environment variable naming the base of the XDG *config* directory (XDG Base
 * Directory spec). Config — as opposed to state or cache — is where an operator-provided,
 * survives-forever secret belongs, so the auth file lives under it (the sibling
 * {@link https://ccctl | session store} lives under XDG *state* for the opposite reason:
 * it is regenerable). Honoured only when set to an ABSOLUTE path, exactly as
 * {@link resolveLocalServerAuthPath} documents.
 */
export const XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME";

/** The per-application subdirectory under the XDG config home that holds ccctl's config. */
export const CCCTL_CONFIG_DIR = "ccctl";

/**
 * The local-server auth secret file's name under {@link CCCTL_CONFIG_DIR}. The whole
 * trimmed file contents ARE the secret — a plain-text source, deliberately not a
 * structured config (a storage FORMAT is part of the deferred credential boundary). Named
 * so the resolver, the refusal message, and the tests reference the one file name.
 */
export const LOCAL_SERVER_AUTH_FILE_NAME = "local-server-auth";

/**
 * The IPv4 wildcard bind. Binding `0.0.0.0` would expose the daemon on every
 * interface — exactly what the localhost-bind guarantee forbids. Named so the
 * guard and its tests reference the one literal.
 */
export const WILDCARD_BIND_HOST = "0.0.0.0";

/**
 * Resolve the local-server auth config file's path:
 * `$XDG_CONFIG_HOME/ccctl/local-server-auth`, falling back to
 * `~/.config/ccctl/local-server-auth`. Per the XDG Base Directory spec,
 * `$XDG_CONFIG_HOME` is honoured ONLY when set to an ABSOLUTE path; unset, empty, or
 * relative all fall back to `$HOME/.config` (a relative XDG base is spec-invalid and
 * would otherwise resolve against the process cwd — a footgun). Mirrors the sibling
 * {@link https://ccctl | resolveSessionStorePath} exactly, one directory over (config vs
 * state).
 *
 * `env` and `home` are injectable seams so the resolution is unit-testable without
 * touching the real environment or home directory — the same pure-and-injectable idiom as
 * {@link requireLocalServerAuth}.
 */
export function resolveLocalServerAuthPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env[XDG_CONFIG_HOME_ENV]?.trim();
  const configHome =
    configured !== undefined && configured !== "" && isAbsolute(configured) ? configured : join(home, ".config");
  return join(configHome, CCCTL_CONFIG_DIR, LOCAL_SERVER_AUTH_FILE_NAME);
}

/**
 * Reads the local-server auth config file, returning its raw contents, or `null` when the
 * file is absent. Injectable so {@link requireLocalServerAuth} is unit-testable without
 * touching the real filesystem; the default reads {@link resolveLocalServerAuthPath}
 * synchronously (the guard runs once, at boot, before anything binds).
 */
export type AuthFileReader = (path: string) => string | null;

/**
 * The production {@link AuthFileReader}: a synchronous read that maps a MISSING file to
 * `null` (absence is not an error — the operator simply provisioned auth via the env var
 * instead), while a REAL I/O failure (EACCES, EISDIR, …) surfaces rather than
 * masquerading as "no auth configured" — silently swallowing it would make the guard
 * refuse for the wrong reason on a transient permission glitch. Mirrors
 * {@link https://ccctl | createFileSessionStore}'s load-time ENOENT-is-`null` handling.
 */
const defaultAuthFileReader: AuthFileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * Assert that local-server auth is configured, returning the secret; throw an actionable
 * error when it is not, so the daemon refuses to start unauthenticated — there is no
 * unauthenticated mode, even on loopback (security-posture.md § "Mandatory local-server
 * auth"). Complete-to-spec (#57): the secret is read from EITHER of two sources —
 *
 *   1. the {@link LOCAL_SERVER_AUTH_ENV} env var (PRIMARY — an explicit env override
 *      wins, the 12-factor precedent), or
 *   2. the {@link resolveLocalServerAuthPath} config file (fallback).
 *
 * A present-but-blank value on EITHER source is treated as "not configured" — an empty
 * secret is trivially not a secret (the AC's "malformed/empty is no auth"). When NEITHER
 * source yields a non-empty secret, the refusal is actionable: it names the exact env key,
 * the exact config-file path it looked for, and how to configure either.
 *
 * `env`, and the injectable `home` / `readAuthFile` seams, keep the guard pure and
 * synchronously unit-testable without mutating the process environment or touching the
 * real filesystem — the daemon and any embedder just call it with the defaults.
 */
export function requireLocalServerAuth(
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; readAuthFile?: AuthFileReader } = {},
): string {
  const { home = homedir(), readAuthFile = defaultAuthFileReader } = options;

  // Source 1 (primary): the env var. An explicit override wins over the on-disk config.
  const fromEnv = env[LOCAL_SERVER_AUTH_ENV]?.trim() ?? "";
  if (fromEnv !== "") {
    return fromEnv;
  }

  // Source 2 (fallback): the config file. Present-but-blank is treated as absent, the same
  // blank-is-no-secret rule as the env var above.
  const authFilePath = resolveLocalServerAuthPath(env, home);
  const fromFile = readAuthFile(authFilePath)?.trim() ?? "";
  if (fromFile !== "") {
    return fromFile;
  }

  // Neither source is configured (absent, blank, or otherwise empty on every start path):
  // refuse to start with an error naming BOTH the env key AND the file path it looked for,
  // and how to configure either.
  throw new Error(
    `ccctl: local-server auth is required — the local server refuses to start without it. ` +
      `Configure it by setting ${LOCAL_SERVER_AUTH_ENV} to a secret, ` +
      `or by writing the secret to ${authFilePath}. ` +
      `A present-but-empty value counts as no auth; there is no unauthenticated mode, even on loopback.`,
  );
}

/**
 * Resolve the daemon's bind host, defaulting to loopback ({@link DEFAULT_HOST}) and
 * refusing EVERY non-loopback address so nothing is exposed off-box
 * (security-posture.md § "Localhost-bind by default": "no implicit LAN or `0.0.0.0`
 * binding"). Returns the host to bind, or throws an actionable error.
 *
 * Complete to spec (#58): an ALLOWLIST, not a denylist. A host is honoured iff it is a
 * loopback bind ({@link isLoopbackHost} — any `127.0.0.0/8` address, `::1`, or `localhost`);
 * anything else is refused — the {@link WILDCARD_BIND_HOST} `0.0.0.0`, the IPv6 wildcard
 * `::`, and any LAN or public address alike (the baseline slice #14 refused only `0.0.0.0`,
 * letting `::`/LAN/public through). {@link startServer} applies this on the actual bind path,
 * so the guarantee is NOT silently overridable by an embedder passing a non-loopback
 * `config.host` — it holds on every start path, not only the CLI edge.
 */
export function resolveBindHost(host: string = DEFAULT_HOST): string {
  if (!isLoopbackHost(host)) {
    const label = host === "" ? "the empty host" : host;
    throw new Error(
      `ccctl: refusing to bind ${label} — the local server binds loopback only ` +
        `(default ${DEFAULT_HOST}; any 127.0.0.0/8 or ::1) and is reached off-box solely through an ` +
        `explicit tunnel. ${WILDCARD_BIND_HOST}, ::, and any LAN or public address are refused.`,
    );
  }
  return host;
}

/**
 * The Node `listen()` error code for "address already in use". Named so the guard
 * below and its tests reference the one literal instead of transcribing it.
 */
export const ADDRESS_IN_USE_CODE = "EADDRINUSE";

/**
 * Rebrand a `listen()` failure into an actionable, branded error. When the port is
 * already bound ({@link ADDRESS_IN_USE_CODE}) the raw Node message ("listen
 * EADDRINUSE: address already in use 127.0.0.1:4321") is replaced with a branded
 * `ccctl:` line that names the port and the fix — a second `ccctl serve` on a
 * held port should read as a guardrail, not a stack-adjacent Node diagnostic
 * (#156). Every other listen error passes through unchanged so its own diagnostics
 * survive. Pure and takes the port explicitly so the branding is unit-testable
 * without binding a socket, exactly like the guards above.
 *
 * Matches their voice ({@link resolveBindHost} / {@link requireLocalServerAuth}):
 * a `ccctl:` prefix, the cause, then what to do. The daemon
 * ({@link https://ccctl | @ccctl/cli}'s `serve`) already prints `error.message`
 * (never the stack) and exits non-zero, so a branded message here is the whole
 * user-visible fix.
 */
export function brandListenError(error: NodeJS.ErrnoException, port: number): Error {
  if (error.code === ADDRESS_IN_USE_CODE) {
    return new Error(
      `ccctl: port ${port} is already in use — another 'ccctl serve' may be running; ` +
        `stop it or pass --port <port>.`,
    );
  }
  return error;
}
