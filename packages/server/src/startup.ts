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
 *   - **Localhost-bind.** The listener binds loopback ({@link DEFAULT_HOST}) and
 *     never the `0.0.0.0` wildcard; nothing is reachable off-box until an explicit
 *     tunnel is attached. {@link resolveBindHost} refuses the wildcard.
 *
 * This is the MINIMAL slice: presence-of-a-secret and refuse-`0.0.0.0`. Completing
 * each to spec is tracked separately — the auth credential boundary (a config-file
 * source, an actionable error naming the exact key + file path, malformed-value
 * handling on every start path) is #57; the full localhost-bind guarantee (refuse
 * EVERY non-loopback address — `::`, LAN, public — and make it non-overridable) is
 * #58. Keeping the two guards here, pure and injectable, lets both the daemon
 * ({@link https://ccctl | @ccctl/cli}'s `serve`) and any future embedder apply the
 * same baseline, and lets the properties be unit-tested without binding a socket.
 */

/**
 * Default loopback bind host — nothing is exposed without an explicit tunnel.
 * The localhost-bind guarantee (security-posture.md) starts here: absent an
 * override the daemon binds loopback, and {@link resolveBindHost} refuses the
 * off-box wildcard.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The environment variable the walking skeleton reads the local-server auth
 * secret from. This is the minimal provisioning source; the full credential
 * boundary — a config-file-backed source, and the exact key + file path named in
 * the refusal error — lands with #57. Kept as a named constant so the daemon, the
 * refusal message, and the tests all reference the one key.
 */
export const LOCAL_SERVER_AUTH_ENV = "CCCTL_LOCAL_SERVER_AUTH";

/**
 * The IPv4 wildcard bind. Binding `0.0.0.0` would expose the daemon on every
 * interface — exactly what the localhost-bind guarantee forbids. Named so the
 * guard and its tests reference the one literal.
 */
export const WILDCARD_BIND_HOST = "0.0.0.0";

/**
 * Assert that local-server auth is configured, returning the secret. Throws a
 * clear error when it is absent (or blank) so the daemon refuses to start
 * unauthenticated — there is no unauthenticated mode, even on loopback
 * (security-posture.md § "Mandatory local-server auth"). The `env` is injectable
 * so the property is unit-testable without mutating the process environment.
 *
 * A present-but-blank value is treated as "not configured": an empty secret is
 * trivially not a secret. The fuller malformed-value handling, the config-file
 * source, and an actionable error naming the exact key + file path on every start
 * path complete the credential boundary in #57.
 */
export function requireLocalServerAuth(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env[LOCAL_SERVER_AUTH_ENV]?.trim() ?? "";
  if (secret === "") {
    throw new Error(
      `ccctl: local-server auth is required — the local server refuses to start without it. ` +
        `Set ${LOCAL_SERVER_AUTH_ENV} to a secret; there is no unauthenticated mode, even on loopback.`,
    );
  }
  return secret;
}

/**
 * Resolve the daemon's bind host, defaulting to loopback ({@link DEFAULT_HOST})
 * and refusing the {@link WILDCARD_BIND_HOST} wildcard so nothing is exposed
 * off-box (security-posture.md § "Localhost-bind by default"). Returns the host to
 * bind.
 *
 * Baseline slice (#14): default loopback + refuse `0.0.0.0`. Refusing EVERY
 * non-loopback address (`::`, a LAN IP, a public IP) and making the guarantee
 * non-overridable on every start path completes it in #58.
 */
export function resolveBindHost(host: string = DEFAULT_HOST): string {
  if (host === WILDCARD_BIND_HOST) {
    throw new Error(
      `ccctl: refusing to bind ${WILDCARD_BIND_HOST} — the local server binds loopback only ` +
        `(default ${DEFAULT_HOST}) and is reached off-box solely through an explicit tunnel.`,
    );
  }
  return host;
}
