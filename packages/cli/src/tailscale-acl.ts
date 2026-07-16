// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The credential + grant source that makes Tailscale ACL provisioning REACHABLE from the
 * `ccctl` verbs (#153) — the half
 * [ADR-002](../../../docs/decisions/adr-002-tailscale-acl-provisioning-model.md) deferred.
 *
 * #148 landed opt-in ACL provisioning behind `@ccctl/tunnel-adapters`' injectable
 * {@link https://ccctl | TailscaleAclClient} seam and shipped the real
 * {@link defaultTailscaleAclClient} — but nothing read a credential, so provisioning was
 * complete-behind-a-seam and NOT reachable from `ccctl tunnel` / `ccctl serve --tunnel`.
 * ADR-002 § Risks recorded that boundary ("CLI wiring is deferred") and named the env key
 * this module binds. This is the missing half: WHERE the token comes from, and WHICH scoped
 * grant is bracketed to the session.
 *
 * **Both halves are required, and `ccctl` never authors a grant itself.** Provisioning is on
 * only when {@link TAILSCALE_API_TOKEN_ENV} *and* {@link TAILSCALE_ACL_GRANT_ENV} are both
 * configured; with either missing this resolves to `null` — the adapter's own default, so the
 * tunnel drives `serve` + `status` and relies on the operator's ACL exactly as before (#139).
 * There is deliberately no default grant: a grant's `src` authorizes *which peers* may reach
 * the daemon, `ccctl` cannot know who those should be, and Tailscale grants are allow-only (a
 * policy is the UNION of its grants) — so any `src` ccctl invented could only ever WIDEN an
 * operator's policy, never narrow it. ADR-002 § Alternatives rests its additive-provisioning
 * safety argument on the scoped grant admitting a **narrow** `src`; inventing a broad one would
 * defeat that argument. {@link TAILSCALE_ACL_GRANT_EXAMPLE} is a documented starting shape to
 * copy and narrow — never a value this module applies.
 *
 * **Non-persisting credential** (ADR-002 § (2)): the token is read here and handed straight to
 * {@link defaultTailscaleAclClient}, which captures it in its closure and sends it ONLY as an
 * `Authorization: Bearer` request header. It is never stored on a tunnel, placed on an
 * `EstablishedTunnel` / `TunnelStatus`, written into the policy document or session state, or
 * logged — including by this module's own notice and errors, which name the ENV KEY and never
 * the value.
 *
 * The `env` is injectable throughout (defaulting to `process.env`), and the API `fetch` /
 * command `runner` seams are overridable, so the whole composition is unit-testable without
 * mutating the process environment, reaching a live tailnet, or spawning a real `tailscale` —
 * the same determinism discipline as {@link https://ccctl | resolveClaudeBin} and the adapter's
 * own seams.
 */

import {
  defaultCommandRunner,
  defaultTailscaleAclClient,
  TailscaleTunnel,
  type AclGrant,
  type CommandRunner,
  type TailscaleAclProvisioning,
  type Tunnel,
} from "@ccctl/tunnel-adapters";

/**
 * The environment variable carrying the Tailscale API bearer credential — the key ADR-002
 * § Risks names. Required to opt into ACL provisioning, but NOT sufficient on its own: a grant
 * must be declared too ({@link TAILSCALE_ACL_GRANT_ENV}), so an operator who exports this token
 * for other purposes never silently starts writing tailnet policy.
 *
 * The recommended value is an OAuth client's short-lived access token with the `acl` scope
 * (least privilege); a raw Tailscale API access token works through the identical Bearer seam.
 * Kept a named constant so the resolver, the docs, and the tests all reference the one key.
 */
export const TAILSCALE_API_TOKEN_ENV = "CCCTL_TAILSCALE_API_TOKEN";

/**
 * The environment variable carrying the operator's scoped grant, as ONE Tailscale `grants[]`
 * entry in JSON. Required to opt into provisioning (alongside {@link TAILSCALE_API_TOKEN_ENV});
 * unset or blank means provisioning stays off.
 *
 * This is ADR-002's "operator-declared" managed scope, and it is declared — never defaulted.
 * *Which* devices the grant admits is the operator's call, and a mis-scoped grant is an operator
 * error the adapter cannot validate; it brackets whatever it is given to the session lifecycle,
 * nothing more.
 */
export const TAILSCALE_ACL_GRANT_ENV = "CCCTL_TAILSCALE_ACL_GRANT";

/**
 * A documented STARTING SHAPE for {@link TAILSCALE_ACL_GRANT_ENV} — the "ccctl-owned tag
 * destination" ADR-002 § Risks recommends, shown in the README and in {@link tailscaleAclNotice}.
 *
 * **This is an example, not a default.** Nothing applies it: {@link resolveTailscaleAclGrant}
 * returns `null` when the operator declares no grant, and provisioning stays off. Only `dst` and
 * `ip` are advice `ccctl` can honestly give (a tag the operator governs; the single port
 * `tailscale serve` exposes) — `src` is a **placeholder the operator MUST replace** with the
 * narrowest principal that should reach their daemon (a user, a `group:`, a tag). `ccctl` cannot
 * pick it: grants are allow-only and union together, so a guessed `src` could only widen.
 *
 * The `dst` tag must also be **applied to this node**: `tagOwners` in the policy declares only
 * *who may apply* a tag, it does not tag anything. A grant whose `dst` tag is on no device
 * matches nothing and silently does nothing.
 */
export const TAILSCALE_ACL_GRANT_EXAMPLE: AclGrant = {
  src: ["you@example.com"],
  dst: ["tag:ccctl"],
  ip: ["tcp:443"],
};

/** Name a rejected JSON value's shape for an error message — `null` and arrays read as themselves, not "object". */
function describeJsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

/**
 * Resolve the operator's scoped grant, or `null` when none is declared — a present-but-blank
 * value counts as absent (an empty grant is trivially not a grant), matching
 * {@link https://ccctl | resolveClaudeBin}'s and `requireLocalServerAuth`'s blank-is-absent rule.
 *
 * Fails closed on a value that IS declared but malformed — BEFORE any tunnel is established or
 * any API round-trip is made, the same fail-fast discipline as the CLI's `parsePort` /
 * `requireTunnelKind`, so a typo is a clear upfront error rather than a policy write that does
 * not mean what the operator intended. (Absent is not malformed: absent is the OFF switch.) The
 * error names the env KEY and the shape problem; a grant is not a credential, but echoing an
 * arbitrary blob back into the terminal is noise, so the value is not included.
 *
 * A parsed grant is this call's own object, so nothing is aliased across tunnel instances (the
 * adapter records the grant it provisioned to compare on revert).
 */
export function resolveTailscaleAclGrant(env: NodeJS.ProcessEnv = process.env): AclGrant | null {
  const configured = env[TAILSCALE_ACL_GRANT_ENV]?.trim() ?? "";
  if (configured === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured) as unknown;
  } catch {
    throw new Error(
      `ccctl: ${TAILSCALE_ACL_GRANT_ENV} is not valid JSON — expected one Tailscale grants[] entry as a JSON object, ` +
        `e.g. ${JSON.stringify(TAILSCALE_ACL_GRANT_EXAMPLE)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `ccctl: ${TAILSCALE_ACL_GRANT_ENV} must be a JSON object (one Tailscale grants[] entry), got ${describeJsonType(parsed)}`,
    );
  }
  // A non-null, non-array object is already assignable to AclGrant (its values are `unknown`);
  // the grant is opaque to ccctl — Tailscale validates its contents on the policy write.
  return parsed as AclGrant;
}

/**
 * Resolve the opt-in {@link TailscaleAclProvisioning}, or `null` to leave the tailnet's ACL
 * policy entirely to the operator (the #139 default).
 *
 * Requires BOTH {@link TAILSCALE_API_TOKEN_ENV} and {@link TAILSCALE_ACL_GRANT_ENV}: a
 * credential says ccctl *may* write policy, a grant says *what* to write, and ccctl will not
 * invent the latter (see this module's header). Either missing — or blank — yields `null`, so a
 * half-configured environment gets the safe direction: rely on the operator's own ACL.
 *
 * The token short-circuits first: with no credential, provisioning is off regardless, so a stale
 * or malformed grant variable is not parsed and cannot fail a tunnel that was never going to
 * provision.
 *
 * The token never leaves this function except into the client's closure: it is not returned, not
 * placed on the provisioning object, and not logged — {@link TailscaleAclProvisioning} carries
 * only the `client` and the `grant`.
 */
export function resolveTailscaleAclProvisioning(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): TailscaleAclProvisioning | null {
  const token = env[TAILSCALE_API_TOKEN_ENV]?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const grant = resolveTailscaleAclGrant(env);
  if (grant === null) {
    return null;
  }
  const { fetch } = options;
  return {
    client: defaultTailscaleAclClient({ token, ...(fetch === undefined ? {} : { fetch }) }),
    grant,
  };
}

/**
 * The operator-facing notice for a HALF-configured environment — exactly one of the two variables
 * set — or `null` when there is nothing to say (both, so provisioning is on; or neither, so it was
 * never asked for).
 *
 * Worth a word rather than silence: provisioning needs both halves and fails SAFE to the #139
 * posture, so a half-configured operator gets silently none of what they set the variable for, and
 * "my phone cannot reach the daemon" is a confusing way to learn a second variable was required.
 *
 * Both directions warn, not just the missing-grant one. If anything the missing-TOKEN case is the
 * clearer signal of intent: {@link TAILSCALE_ACL_GRANT_ENV} lives in ccctl's own namespace and can
 * mean nothing except "provision this grant", whereas a Tailscale API token may well be exported
 * for unrelated reasons. Warning on only the first would answer the ambiguous signal and ignore
 * the unambiguous one.
 *
 * Pure (it returns the line rather than printing it) so it is unit-testable and the impure edge
 * stays in {@link createTailscaleTunnel}. Names the env keys and the example shape — never the
 * credential's value.
 */
export function tailscaleAclNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  const hasToken = (env[TAILSCALE_API_TOKEN_ENV]?.trim() ?? "") !== "";
  const hasGrant = (env[TAILSCALE_ACL_GRANT_ENV]?.trim() ?? "") !== "";
  if (hasToken === hasGrant) {
    return null;
  }
  const present = hasToken ? TAILSCALE_API_TOKEN_ENV : TAILSCALE_ACL_GRANT_ENV;
  const missing = hasToken ? TAILSCALE_ACL_GRANT_ENV : TAILSCALE_API_TOKEN_ENV;
  const remedy = hasToken
    ? `ccctl does not choose who may reach your daemon; declare the scoped grant to enable it, e.g. ` +
      `${TAILSCALE_ACL_GRANT_ENV}='${JSON.stringify(TAILSCALE_ACL_GRANT_EXAMPLE)}'`
    : `export ${TAILSCALE_API_TOKEN_ENV} (an OAuth client's acl-scoped access token, or a Tailscale API ` +
      `access token) to enable it`;
  return (
    `ccctl: ${present} is set but ${missing} is not — ACL provisioning is OFF ` +
    `(relying on your tailnet's own ACL policy). ${remedy}`
  );
}

/**
 * Build the production Tailscale {@link Tunnel}: the real adapter, plus opt-in ACL provisioning
 * when a credential AND a grant are configured. This is the composition `defaultDependencies`
 * installs over the registry's provisioning-less `ADAPTERS.tailscale` — the one place the CLI's
 * env-read credential meets the adapter's injected seam.
 *
 * Resolution happens per call (i.e. per `establish`), not at module load, so a long-lived
 * `ccctl serve` honors an operator's env without a rebuild — the same late-binding as
 * {@link https://ccctl | defaultWorkerCommand}'s per-launch `resolveClaudeBin`.
 *
 * Unconfigured, this is `new TailscaleTunnel(defaultCommandRunner, null)` — identical to the
 * registry's `new TailscaleTunnel()`, so the default posture is unchanged, not merely similar.
 *
 * `options` exists for tests: fake the `runner` and the API `fetch` and the REAL composition is
 * exercised end to end with no `tailscale` binary and no live tailnet.
 */
export function createTailscaleTunnel(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly runner?: CommandRunner; readonly fetch?: typeof globalThis.fetch } = {},
): Tunnel {
  const { runner = defaultCommandRunner, fetch } = options;
  const provisioning = resolveTailscaleAclProvisioning(env, fetch === undefined ? {} : { fetch });
  const notice = tailscaleAclNotice(env);
  if (notice !== null) {
    console.warn(notice);
  }
  return new TailscaleTunnel(runner, provisioning);
}
