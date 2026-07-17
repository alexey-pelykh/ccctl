// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";
import type { HostEndpoint } from "@ccctl/core";
import {
  ADAPTERS,
  CloudflareTunnel,
  defaultTailscaleAclClient,
  HeadscaleTunnel,
  TailscaleTunnel,
  type AclGrant,
  type AclPolicy,
  type CommandOutput,
  type CommandRunner,
  type TailscaleAclClient,
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

  // Rule (#242): `adopt` keeps the lifecycle TOTAL across backends, as status/teardown already are —
  // a backend that never establishes left no mapping behind, so adopting one is an honest no-op
  // rather than a rejection or a claim of being up.
  it("a stub's adopt is a no-op: still down, and teardown stays a no-op", async () => {
    for (const tunnel of [new CloudflareTunnel(), new HeadscaleTunnel()]) {
      expect(() => tunnel.adopt(LOOPBACK)).not.toThrow();
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

// ---------------------------------------------------------------------------
// ACL provisioning (#148)
// ---------------------------------------------------------------------------

/** A representative operator-authored policy the adapter must never disturb. */
const OPERATOR_POLICY: AclPolicy = {
  acls: [{ action: "accept", src: ["group:eng"], dst: ["*:*"] }],
  groups: { "group:eng": ["alice@example.com"] },
  tagOwners: { "tag:ccctl": ["group:eng"] },
  ssh: [{ action: "accept", src: ["autogroup:member"], dst: ["autogroup:self"], users: ["autogroup:nonroot"] }],
};

/** The single ccctl-owned, scoped grant the adapter appends/removes (its managed scope). */
const CCCTL_GRANT: AclGrant = { src: ["group:eng"], dst: ["tag:ccctl"], ip: ["tcp:*"] };

/**
 * An in-memory {@link TailscaleAclClient} — the injected API seam, so provisioning
 * is exercised with no live tailnet and no token. Holds a policy + ETag; a save
 * with a stale ETag is rejected (optimistic concurrency, like the real API), and
 * `structuredClone` on both read and write means the adapter can never alias the
 * stored policy — a change only lands through `savePolicy`, exactly as over HTTP.
 */
function fakeAclClient(initial: AclPolicy): {
  client: TailscaleAclClient;
  current: () => AclPolicy;
  fetchCount: () => number;
  saveCount: () => number;
} {
  let policy = structuredClone(initial);
  let version = 0;
  let fetches = 0;
  let saves = 0;
  const client: TailscaleAclClient = {
    fetchPolicy() {
      fetches += 1;
      return Promise.resolve({ policy: structuredClone(policy), etag: `etag-${version}` });
    },
    savePolicy(next, etag) {
      if (etag !== `etag-${version}`) {
        return Promise.reject(new Error(`ccctl-test: stale ETag ${etag}`));
      }
      policy = structuredClone(next);
      version += 1;
      saves += 1;
      return Promise.resolve();
    },
  };
  return { client, current: () => structuredClone(policy), fetchCount: () => fetches, saveCount: () => saves };
}

/** Read a single header value regardless of the `HeadersInit` shape the client used. */
function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

describe("TailscaleTunnel ACL provisioning (AC: opt-in, additive, non-destructive)", () => {
  it("appends only its scoped grant on establish, creating the grants key, preserving every operator rule", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT }).establish(LOOPBACK);

    const after = acl.current();
    // Every operator section is carried through verbatim …
    expect(after.acls).toEqual(OPERATOR_POLICY.acls);
    expect(after.groups).toEqual(OPERATOR_POLICY.groups);
    expect(after.tagOwners).toEqual(OPERATOR_POLICY.tagOwners);
    expect(after.ssh).toEqual(OPERATOR_POLICY.ssh);
    // … and exactly our one scoped grant is added.
    expect(after.grants).toEqual([CCCTL_GRANT]);
  });

  it("removes exactly its grant on teardown, restoring the operator's policy unchanged", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT });

    await tunnel.establish(LOOPBACK);
    await tunnel.teardown();

    // The `grants` key the adapter created is gone → identical to the original.
    expect(acl.current()).toEqual(OPERATOR_POLICY);
    expect(acl.current()).not.toHaveProperty("grants");
  });

  it("appends to and prunes from an existing operator grants list without disturbing operator grants", async () => {
    const operatorGrant = { src: ["group:ops"], dst: ["tag:infra"], ip: ["tcp:22"] };
    const acl = fakeAclClient({ ...OPERATOR_POLICY, grants: [operatorGrant] });
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT });

    await tunnel.establish(LOOPBACK);
    // Appended after the operator's own grant, which is untouched.
    expect(acl.current().grants).toEqual([operatorGrant, CCCTL_GRANT]);

    await tunnel.teardown();
    // Only ours removed; the operator's grant AND the key it owns remain.
    expect(acl.current().grants).toEqual([operatorGrant]);
  });

  it("drives only serve + status on the CLI when provisioning — policy writes ride the API seam", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    await new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT }).establish(LOOPBACK);

    // The `tailscale` binary is still only ever `serve` then `status` — the ACL
    // write went through the injected API client, never a policy CLI verb.
    expect(calls.map((c) => c.args[0])).toEqual(["serve", "status"]);
    expect(acl.saveCount()).toBe(1);
  });

  it("provisions only after mandatory tunnel-auth passes: an unauthenticated node writes no policy", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." }, "NeedsLogin")));

    await expect(
      new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT }).establish(LOOPBACK),
    ).rejects.toThrow(/mandatory tunnel-auth/);

    // The policy was never even read, let alone written.
    expect(acl.fetchCount()).toBe(0);
    expect(acl.current()).toEqual(OPERATOR_POLICY);
  });

  it("leaves the operator policy intact and the serve releasable when the provisioning write fails (half-up)", async () => {
    let fetches = 0;
    const failing: TailscaleAclClient = {
      fetchPolicy: () => {
        fetches += 1;
        return Promise.resolve({ policy: structuredClone(OPERATOR_POLICY), etag: "etag-0" });
      },
      savePolicy: () => Promise.reject(new Error("ccctl-test: acl save boom")),
    };
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: failing, grant: CCCTL_GRANT });

    await expect(tunnel.establish(LOOPBACK)).rejects.toThrow(/acl save boom/);
    // Provisioning failed → not a usable up.
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });

    await tunnel.teardown();
    // teardown attempted NO ACL revert (nothing was recorded) — only establish read …
    expect(fetches).toBe(1);
    // … yet the serve is still turned off cleanly.
    expect(calls.some((c) => c.args.join(" ") === "serve --bg http://127.0.0.1:4321 off")).toBe(true);
  });

  it("stays established and retries cleanly when the teardown revert write fails once", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    let failRevertOnce = true;
    const flaky: TailscaleAclClient = {
      fetchPolicy: () => acl.client.fetchPolicy(),
      savePolicy: (next, etag) => {
        // Fail the revert write (the 2nd save overall) exactly once; retries pass.
        if (acl.saveCount() === 1 && failRevertOnce) {
          failRevertOnce = false;
          return Promise.reject(new Error("ccctl-test: revert boom"));
        }
        return acl.client.savePolicy(next, etag);
      },
    };
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: flaky, grant: CCCTL_GRANT });
    await tunnel.establish(LOOPBACK);

    // Revert write fails → teardown rejects, tunnel stays up, serve NOT yet released.
    await expect(tunnel.teardown()).rejects.toThrow(/revert boom/);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: true, publicHost: "host.ts.net" });
    expect(calls.some((c) => c.args.includes("off"))).toBe(false);

    // Retry: revert now succeeds, then the serve is turned off → fully clean.
    await tunnel.teardown();
    expect(acl.current()).toEqual(OPERATOR_POLICY);
    expect(calls.some((c) => c.args.join(" ") === "serve --bg http://127.0.0.1:4321 off")).toBe(true);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });
  });

  // Rule (#242 AC3): repeated establishes must not accumulate duplicate grants. Each `ccctl tunnel`
  // run is a fresh process AND a fresh tunnel instance, and the mapping it makes is detached — so
  // without an idempotent append the same grant piles up one copy per run, forever.
  it("appends at most one copy: a second establish finds its grant already there and adds nothing", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const provisioning = { client: acl.client, grant: CCCTL_GRANT };

    // Two independent establishes against one tailnet — i.e. `ccctl tunnel tailscale` run twice.
    await new TailscaleTunnel(runner, provisioning).establish(LOOPBACK);
    await new TailscaleTunnel(runner, provisioning).establish(LOOPBACK);

    expect(acl.current().grants).toEqual([CCCTL_GRANT]);
    // Only the FIRST establish wrote; the second read the policy, saw its grant, and skipped.
    expect(acl.saveCount()).toBe(1);
    expect(acl.fetchCount()).toBe(2);
  });

  // Rule (#242): an equal grant already in the policy is value-indistinguishable from one the operator
  // hand-authored — so an establish that did not append it must not claim it for revert either. The
  // adapter's managed scope stays exactly "the grant THIS instance added".
  it("does not revert a grant it did not add — teardown of a skipped establish leaves the policy alone", async () => {
    const acl = fakeAclClient({ ...OPERATOR_POLICY, grants: [CCCTL_GRANT] });
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT });

    await tunnel.establish(LOOPBACK);
    await tunnel.teardown();

    // The pre-existing grant survives — it was never ours …
    expect(acl.current().grants).toEqual([CCCTL_GRANT]);
    expect(acl.saveCount()).toBe(0);
    // … while the mapping this instance DID make is still released.
    expect(calls.some((c) => c.args.join(" ") === "serve --bg http://127.0.0.1:4321 off")).toBe(true);
  });

  // Rule (#242 AC2): `tailscale serve --bg` is detached, so the grant outlives the process that
  // appended it. A LATER process (the `ccctl tunnel <kind> --off` down-verb) rebuilds the release
  // handles from the same operator-supplied endpoint + declared grant and reverts it — with no
  // establish of its own, which is exactly the state a fresh process is in.
  it("adopt lets a fresh instance revert a grant a previous establish left behind", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const provisioning = { client: acl.client, grant: CCCTL_GRANT };

    // Process 1: establish, then vanish (fire-and-forget) — the grant is left in the policy.
    await new TailscaleTunnel(runner, provisioning).establish(LOOPBACK);
    expect(acl.current().grants).toEqual([CCCTL_GRANT]);

    // Process 2: a brand-new instance that never established anything.
    const { runner: downRunner, calls: downCalls } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const down = new TailscaleTunnel(downRunner, provisioning);
    down.adopt(LOOPBACK);
    await down.teardown();

    // The grant is gone …
    expect(acl.current().grants).toEqual([]);
    // … and the detached mapping is turned off — the same targeted off-command establish's own
    // teardown would have run.
    expect(downCalls.map((c) => c.args.join(" "))).toEqual(["serve --bg http://127.0.0.1:4321 off"]);
  });

  // Rule (#242): adopt seeds RELEASE HANDLES, not a claim about reachability. An adopting instance
  // never resolved a public host, and an `up` TunnelStatus must carry one — so it stays `down`, the
  // same rule that makes a served-but-unresolved establish "not a usable up".
  it("adopt does not report up: it seeds what teardown needs, not a reachable base", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const tunnel = new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT });

    tunnel.adopt(LOOPBACK);

    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: false });
  });

  // Rule (#242): adopt honours the opt-in. With no provisioning configured the establish wrote no
  // policy, so there is no grant to remove and the down path must not reach for the API at all.
  it("adopt with no provisioning releases only the mapping — no policy read, no write", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const tunnel = new TailscaleTunnel(runner);

    tunnel.adopt(LOOPBACK);
    await tunnel.teardown();

    expect(calls.map((c) => c.args.join(" "))).toEqual(["serve --bg http://127.0.0.1:4321 off"]);
  });

  // Rule (#242): an adopting process cannot know whether the establish created the `grants` key, so it
  // must not delete it — that would be an edit to the operator's policy beyond the managed scope. It
  // leaves `grants: []`, which is strictly "only our own grant was removed". Every operator rule is
  // still carried verbatim, exactly as on the establish-side revert.
  it("adopt's revert never deletes the grants key it cannot claim, and disturbs no operator rule", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const provisioning = { client: acl.client, grant: CCCTL_GRANT };
    await new TailscaleTunnel(runner, provisioning).establish(LOOPBACK);

    const down = new TailscaleTunnel(fakeRunner(() => ({ stdout: "", stderr: "" })).runner, provisioning);
    down.adopt(LOOPBACK);
    await down.teardown();

    const after = acl.current();
    expect(after.grants).toEqual([]);
    expect(after.acls).toEqual(OPERATOR_POLICY.acls);
    expect(after.groups).toEqual(OPERATOR_POLICY.groups);
    expect(after.tagOwners).toEqual(OPERATOR_POLICY.tagOwners);
    expect(after.ssh).toEqual(OPERATOR_POLICY.ssh);
  });

  // Rule (#242 AC4, on the adopt path too): a failed revert must leave the tunnel established and
  // retryable — the mapping is NOT released and the grant is NOT abandoned, so the operator can just
  // run the down-verb again.
  it("adopt's teardown stays retryable when the revert write fails: the mapping is not released", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    await new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT }).establish(LOOPBACK);

    let failOnce = true;
    const flaky: TailscaleAclClient = {
      fetchPolicy: () => acl.client.fetchPolicy(),
      savePolicy: (next, etag) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("ccctl-test: adopt revert boom"));
        }
        return acl.client.savePolicy(next, etag);
      },
    };
    const { runner: downRunner, calls: downCalls } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const down = new TailscaleTunnel(downRunner, { client: flaky, grant: CCCTL_GRANT });
    down.adopt(LOOPBACK);

    await expect(down.teardown()).rejects.toThrow(/adopt revert boom/);
    // Revert failed → the serve is NOT turned off, and the grant is still there to retry against.
    expect(downCalls).toHaveLength(0);
    expect(acl.current().grants).toEqual([CCCTL_GRANT]);

    // Retry completes both halves.
    await down.teardown();
    expect(acl.current().grants).toEqual([]);
    expect(downCalls.map((c) => c.args.join(" "))).toEqual(["serve --bg http://127.0.0.1:4321 off"]);
  });

  it("keeps the credential off the tunnel's outputs: establish / status carry only kind + publicHost", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client: acl.client, grant: CCCTL_GRANT });

    const established = await tunnel.establish(LOOPBACK);

    // No credential/grant field is ever surfaced — the outward shapes are unchanged.
    expect(Object.keys(established).sort()).toEqual(["kind", "publicHost"]);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: true, publicHost: "host.ts.net" });
  });

  // Rule (#259): `teardown` is safe after an establish, never CONCURRENTLY with one — the precondition
  // `Tunnel.teardown` now states. This pins WHY, executably, rather than leaving it as prose a future
  // caller can read past: it CHARACTERIZES the hazard, so the contract has evidence and a reordering of
  // the read below is caught rather than silently making the docs a lie.
  //
  // The mechanism is a happens-before edge: `teardown` reads `#provisionedGrant` as its first
  // synchronous statement, while `#provisionAcl` records that field only AFTER `savePolicy` resolves.
  // So a teardown landing inside the write reads "no grant to revert", skips the revert, and the write
  // it never saw lands anyway — an orphaned grant in the operator's policy. Deliberately NOT fixed in
  // the adapter: the CLI is the one caller that can race these (it alone arms a signal handler over an
  // in-flight establish) and it serializes them there, so this stays a caller contract rather than
  // machinery every `Tunnel` implementer would owe. Delete this test if that ever changes.
  it("strands the grant when a teardown races the provision — the hazard the serialize contract exists for", async () => {
    const acl = fakeAclClient(OPERATOR_POLICY);
    let writeInFlight = false;
    let releaseWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    // Hold the policy write open, so a teardown can land in the exact window the contract forbids:
    // after `establish` decided to provision, before it has recorded what it provisioned.
    const client: TailscaleAclClient = {
      fetchPolicy: () => acl.client.fetchPolicy(),
      savePolicy: async (next, etag) => {
        writeInFlight = true;
        await held;
        return acl.client.savePolicy(next, etag);
      },
    };
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = new TailscaleTunnel(runner, { client, grant: CCCTL_GRANT });

    const establishing = tunnel.establish(LOOPBACK);
    await vi.waitFor(() => expect(writeInFlight).toBe(true));

    // The forbidden concurrent call. It releases the mapping and reports success — the adapter has no
    // way to know an establish is mid-write behind it.
    await tunnel.teardown();

    releaseWrite();
    await establishing;

    // The mapping IS released, so this is not a no-op teardown — and the grant is in the operator's
    // policy all the same, with the instance that would revert it already torn down. That is the whole
    // hazard: a release that reports clean and leaves authorization behind.
    expect(acl.current().grants).toContainEqual(CCCTL_GRANT);
    expect(await tunnel.status()).toEqual({ kind: "tailscale", up: true, publicHost: "host.ts.net" });
  });
});

describe("defaultTailscaleAclClient (AC: credential rides the injectable seam, never logged)", () => {
  it("fetches with a Bearer credential + reads the ETag; saves with If-Match and the JSON body", async () => {
    const token = "tskey-secret-DO-NOT-LOG";
    const policy = { acls: [{ action: "accept" }] };
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub: typeof globalThis.fetch = (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        (init?.method ?? "GET") === "GET"
          ? new Response(JSON.stringify(policy), { status: 200, headers: { ETag: '"v42"' } })
          : new Response("", { status: 200 }),
      );
    };

    const client = defaultTailscaleAclClient({ token, tailnet: "example.com", fetch: fetchStub });
    const doc = await client.fetchPolicy();
    expect(doc).toEqual({ policy, etag: '"v42"' });
    await client.savePolicy({ acls: [], grants: [{ src: ["*"] }] }, '"v42"');

    const [get, post] = calls;
    expect(get.url).toBe("https://api.tailscale.com/api/v2/tailnet/example.com/acl");
    expect(headerValue(get.init.headers, "Authorization")).toBe(`Bearer ${token}`);
    expect(post.init.method).toBe("POST");
    expect(headerValue(post.init.headers, "Authorization")).toBe(`Bearer ${token}`);
    // The fetched ETag rides back as If-Match — optimistic concurrency on the write.
    expect(headerValue(post.init.headers, "If-Match")).toBe('"v42"');
    expect(JSON.parse(String(post.init.body))).toEqual({ acls: [], grants: [{ src: ["*"] }] });
  });

  it("targets the credential's own tailnet by default (tailnet `-`)", async () => {
    const urls: string[] = [];
    const fetchStub: typeof globalThis.fetch = (input) => {
      urls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({}), { headers: { ETag: "" } }));
    };

    await defaultTailscaleAclClient({ token: "t", fetch: fetchStub }).fetchPolicy();

    expect(urls[0]).toBe("https://api.tailscale.com/api/v2/tailnet/-/acl");
  });

  it("uses the credential but never logs it", async () => {
    const token = "tskey-secret-NEVER-LOGGED";
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    const fetchStub: typeof globalThis.fetch = (_input, init) =>
      Promise.resolve(
        (init?.method ?? "GET") === "GET"
          ? new Response(JSON.stringify({ acls: [] }), { headers: { ETag: '"v1"' } })
          : new Response("", { status: 200 }),
      );

    const client = defaultTailscaleAclClient({ token, fetch: fetchStub });
    const { etag } = await client.fetchPolicy();
    await client.savePolicy({ acls: [] }, etag);
    vi.restoreAllMocks();

    expect(logs.join("\n")).not.toContain(token);
  });

  it("rejects a non-OK API response on both fetch and save", async () => {
    const forbidden: typeof globalThis.fetch = () => Promise.resolve(new Response("no", { status: 403 }));
    await expect(defaultTailscaleAclClient({ token: "t", fetch: forbidden }).fetchPolicy()).rejects.toThrow(/HTTP 403/);

    const conflict: typeof globalThis.fetch = () => Promise.resolve(new Response("stale", { status: 412 }));
    await expect(defaultTailscaleAclClient({ token: "t", fetch: conflict }).savePolicy({}, '"v1"')).rejects.toThrow(
      /HTTP 412/,
    );
  });
});
