// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEndpoint, LogEvent } from "@ccctl/core";
import { installShutdownSignalHandler } from "@ccctl/server";
import {
  ADAPTERS,
  type AclGrant,
  type AclPolicy,
  type CommandOutput,
  type CommandRunner,
} from "@ccctl/tunnel-adapters";
import { defaultDependencies } from "./dependencies.js";
import {
  createTailscaleTunnel,
  resolveTailscaleAclGrant,
  resolveTailscaleAclProvisioning,
  TAILSCALE_ACL_GRANT_ENV,
  TAILSCALE_ACL_GRANT_EXAMPLE,
  TAILSCALE_API_TOKEN_ENV,
  tailscaleAclNotice,
} from "./tailscale-acl.js";

// #148 landed opt-in ACL provisioning behind the adapter's injectable seam and unit-tested it there;
// #153 (this) supplies the missing half — the credential + grant the CLI reads, and the composition
// that hands them to the adapter — which is what makes provisioning REACHABLE from `ccctl tunnel`.
//
// So these tests deliberately do NOT re-assert the adapter's own invariants (non-destructive merge,
// retryable revert, If-Match concurrency — all pinned in `@ccctl/tunnel-adapters`). They assert the
// wiring: that BOTH env vars are required to arm it, that ccctl never invents a grant, that the
// provisioning is actually PASSED (proven by driving `establish` and watching the grant land), that
// the token rides only the Authorization header, and that anything less than fully-configured leaves
// the #139 posture byte-for-byte unchanged.
//
// Both leaf I/O seams are faked — the `tailscale` binary (CommandRunner) and the Tailscale API
// (`fetch`) — so the REAL `defaultTailscaleAclClient` the CLI composes is exercised over the real
// wire shape, with no live tailnet, no token, and no spawned process.

/** A representative Tailscale API access token — deliberately distinctive so a leak is greppable. */
const TOKEN = "tskey-api-SECRET-must-never-be-logged";

/** A narrow, operator-declared grant — what a real operator would set. ccctl never invents one. */
const OPERATOR_GRANT: AclGrant = { src: ["alice@example.com"], dst: ["tag:ccctl"], ip: ["tcp:443"] };

/** A fully-configured environment: the credential AND the declared grant. Both are required. */
function provisionedEnv(grant: AclGrant = OPERATOR_GRANT): NodeJS.ProcessEnv {
  return { [TAILSCALE_API_TOKEN_ENV]: TOKEN, [TAILSCALE_ACL_GRANT_ENV]: JSON.stringify(grant) };
}

const LOOPBACK: HostEndpoint = { host: "127.0.0.1", port: 4321 };

/** A recorded invocation of the {@link CommandRunner}. */
interface RecordedCall {
  command: string;
  args: readonly string[];
}

/** A {@link CommandRunner} that records every call and answers from a handler — no real `tailscale`. */
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

/** `tailscale status --json` for an authenticated node, so establish clears mandatory tunnel-auth. */
function statusJson(self: Record<string, unknown>): CommandOutput {
  return { stdout: JSON.stringify({ BackendState: "Running", Self: self }), stderr: "" };
}

/** Route `serve` vs `status` so one handler answers both establish calls. */
function tailscaleHandler(status: CommandOutput): (call: RecordedCall) => CommandOutput {
  return ({ args }) => (args[0] === "status" ? status : { stdout: "", stderr: "" });
}

/** A recorded Tailscale-API request the fake `fetch` saw. */
interface RecordedFetch {
  url: string;
  init: RequestInit;
}

/**
 * A fake Tailscale policy API: answers `GET …/acl` with the held policy + an ETag and applies the
 * `POST` write-back, recording both. The REAL {@link https://ccctl | defaultTailscaleAclClient} runs
 * against it, so the credential header / ETag round-trip the CLI composes is exercised for real —
 * only the network is faked. ETag validation is the adapter's own tested concern, not re-asserted here.
 */
function fakeTailscaleApi(initial: AclPolicy): {
  fetch: typeof globalThis.fetch;
  calls: RecordedFetch[];
  current: () => AclPolicy;
} {
  let policy = structuredClone(initial);
  const calls: RecordedFetch[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") {
      return Promise.resolve(new Response(JSON.stringify(policy), { status: 200, headers: { ETag: '"v1"' } }));
    }
    policy = JSON.parse(String(init?.body)) as AclPolicy;
    return Promise.resolve(new Response("", { status: 200 }));
  };
  return { fetch, calls, current: () => structuredClone(policy) };
}

/** An operator-authored policy with no `grants` key — the shape provisioning must create and clean up. */
const OPERATOR_POLICY: AclPolicy = { acls: [{ action: "accept", src: ["group:eng"], dst: ["*:*"] }] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveTailscaleAclGrant — the grant is declared, never defaulted (AC-3)", () => {
  it("is null when CCCTL_TAILSCALE_ACL_GRANT is unset — ccctl invents no grant", () => {
    // The load-bearing property: a grant's `src` authorizes WHICH PEERS may reach the daemon, and
    // Tailscale grants union together (allow-only). Any `src` ccctl guessed could only ever WIDEN
    // the operator's policy — so ccctl declines to guess. ADR-002's additive-provisioning safety
    // argument rests on the scoped grant admitting a NARROW src; a default would defeat it.
    expect(resolveTailscaleAclGrant({})).toBeNull();
  });

  it("treats a blank (whitespace-only) value as not declared", () => {
    expect(resolveTailscaleAclGrant({ [TAILSCALE_ACL_GRANT_ENV]: "   " })).toBeNull();
    expect(resolveTailscaleAclGrant({ [TAILSCALE_ACL_GRANT_ENV]: "" })).toBeNull();
  });

  it("uses the operator's grant verbatim when one is declared", () => {
    expect(resolveTailscaleAclGrant({ [TAILSCALE_ACL_GRANT_ENV]: JSON.stringify(OPERATOR_GRANT) })).toEqual(
      OPERATOR_GRANT,
    );
  });

  it("keeps the example's src a placeholder — it is a shape to copy, never a value ccctl applies", () => {
    // Pinned deliberately: `dst`/`ip` are advice ccctl can honestly give (a tag the operator governs,
    // the one port `tailscale serve` exposes). `src` is a placeholder the operator MUST replace — so
    // it must never be a real principal that would silently work if pasted unedited.
    expect(TAILSCALE_ACL_GRANT_EXAMPLE).toEqual({
      src: ["you@example.com"],
      dst: ["tag:ccctl"],
      ip: ["tcp:443"],
    });
    // …and nothing applies it: an unset grant resolves to null, not to the example.
    expect(resolveTailscaleAclGrant({})).not.toEqual(TAILSCALE_ACL_GRANT_EXAMPLE);
  });

  it("fails closed on a DECLARED but malformed JSON value, naming the env key", () => {
    expect(() => resolveTailscaleAclGrant({ [TAILSCALE_ACL_GRANT_ENV]: "{not json" })).toThrow(
      /CCCTL_TAILSCALE_ACL_GRANT is not valid JSON/,
    );
  });

  it("fails closed on JSON that is not one grant object, naming what it got", () => {
    const rejected: readonly (readonly [string, string])[] = [
      ["[]", "an array"],
      ["null", "null"],
      ["42", "a number"],
      ['"grant"', "a string"],
    ];
    for (const [value, described] of rejected) {
      expect(() => resolveTailscaleAclGrant({ [TAILSCALE_ACL_GRANT_ENV]: value })).toThrow(
        `ccctl: ${TAILSCALE_ACL_GRANT_ENV} must be a JSON object (one Tailscale grants[] entry), got ${described}`,
      );
    }
  });
});

describe("resolveTailscaleAclProvisioning — both halves required to arm it (AC-1, AC-2)", () => {
  it("is null when neither variable is configured — the tunnel relies on the operator's ACL (#139)", () => {
    expect(resolveTailscaleAclProvisioning({})).toBeNull();
  });

  it("is null with a token but no declared grant — a credential alone never writes policy", () => {
    expect(resolveTailscaleAclProvisioning({ [TAILSCALE_API_TOKEN_ENV]: TOKEN })).toBeNull();
  });

  it("is null with a grant but no token — nothing to authenticate the write with", () => {
    expect(resolveTailscaleAclProvisioning({ [TAILSCALE_ACL_GRANT_ENV]: JSON.stringify(OPERATOR_GRANT) })).toBeNull();
  });

  it("treats a blank token as absent — an exported-but-empty var never half-arms provisioning", () => {
    expect(resolveTailscaleAclProvisioning({ ...provisionedEnv(), [TAILSCALE_API_TOKEN_ENV]: "   " })).toBeNull();
    expect(resolveTailscaleAclProvisioning({ ...provisionedEnv(), [TAILSCALE_API_TOKEN_ENV]: "" })).toBeNull();
  });

  it("does not parse the grant when no token is set — a stale grant var cannot fail an un-armed tunnel", () => {
    // Provisioning is off regardless, so a malformed leftover must not throw on a tunnel that was
    // never going to provision. (With a token, the same value DOES throw — see the fail-closed test.)
    expect(resolveTailscaleAclProvisioning({ [TAILSCALE_ACL_GRANT_ENV]: "{not json" })).toBeNull();
  });

  it("fails closed when a token IS set and the declared grant is malformed", () => {
    expect(() =>
      resolveTailscaleAclProvisioning({ [TAILSCALE_API_TOKEN_ENV]: TOKEN, [TAILSCALE_ACL_GRANT_ENV]: "{not json" }),
    ).toThrow(/CCCTL_TAILSCALE_ACL_GRANT is not valid JSON/);
  });

  it("constructs the client + the operator's grant when both are configured", () => {
    const provisioning = resolveTailscaleAclProvisioning(provisionedEnv());

    expect(provisioning).not.toBeNull();
    expect(provisioning?.grant).toEqual(OPERATOR_GRANT);
    expect(typeof provisioning?.client.fetchPolicy).toBe("function");
    expect(typeof provisioning?.client.savePolicy).toBe("function");
  });

  it("keeps the token OFF the provisioning it returns — closure-captured, non-persisting (ADR-002)", () => {
    const provisioning = resolveTailscaleAclProvisioning(provisionedEnv());

    // The shape carries only `client` + `grant`; the credential lives in the client's closure.
    expect(JSON.stringify(provisioning)).not.toContain(TOKEN);
    expect(Object.keys(provisioning ?? {})).toEqual(["client", "grant"]);
  });
});

describe("tailscaleAclNotice — tells a half-configured operator why provisioning is off", () => {
  it("warns when a token is exported but no grant is declared", () => {
    const notice = tailscaleAclNotice({ [TAILSCALE_API_TOKEN_ENV]: TOKEN });

    expect(notice).toContain(TAILSCALE_ACL_GRANT_ENV);
    expect(notice).toContain("provisioning is OFF");
    // Names the keys and the example shape — never the credential's value.
    expect(notice).not.toContain(TOKEN);
  });

  it("warns the OTHER way too: a grant declared with no token exported", () => {
    // Provisioning fails safe either way, so this operator silently gets none of what they asked
    // for. If anything this is the CLEARER signal of intent: CCCTL_TAILSCALE_ACL_GRANT is ccctl's
    // own namespace and can mean nothing but "provision this", whereas a Tailscale API token may
    // be exported for unrelated reasons. Warning only on the ambiguous half would be backwards.
    const notice = tailscaleAclNotice({ [TAILSCALE_ACL_GRANT_ENV]: JSON.stringify(OPERATOR_GRANT) });

    expect(notice).toContain(TAILSCALE_API_TOKEN_ENV);
    expect(notice).toContain("provisioning is OFF");
  });

  it("is silent when fully configured, and when not configured at all", () => {
    expect(tailscaleAclNotice(provisionedEnv())).toBeNull();
    expect(tailscaleAclNotice({})).toBeNull();
  });

  it("treats a blank half as absent, not as configured", () => {
    // Otherwise an exported-but-empty var would read as "both set" and silence the notice.
    expect(tailscaleAclNotice({ ...provisionedEnv(), [TAILSCALE_API_TOKEN_ENV]: "   " })).toContain(
      TAILSCALE_API_TOKEN_ENV,
    );
    expect(tailscaleAclNotice({ ...provisionedEnv(), [TAILSCALE_ACL_GRANT_ENV]: "  " })).toContain(
      TAILSCALE_ACL_GRANT_ENV,
    );
  });
});

describe("createTailscaleTunnel — provisioning is PASSED to the adapter (AC-2, AC-4)", () => {
  it("appends the operator's grant on establish — reachable only if the provisioning was passed in", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);

    // The #153 gap in one assertion: before this wiring the CLI's tunnel had no provisioning, so no
    // grant could ever land. It lands now — and only the one, alongside the operator's untouched rule.
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);
    expect(api.current().acls).toEqual(OPERATOR_POLICY.acls);
    // Provisioning is ADDITIVE to #139, not a replacement: serve + status still drive the tunnel.
    expect(calls.map((c) => c.args[0])).toEqual(["serve", "status"]);
  });

  it("brackets the grant to the session: teardown removes exactly it, leaving the policy as found", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);
    // Assert the grant LANDED before asserting teardown removed it. Without this line the assertion
    // below is vacuous — "the policy equals OPERATOR_POLICY" is trivially true when nothing was ever
    // provisioned, so the test would stay green even with the wiring removed entirely.
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);

    await tunnel.teardown();

    expect(api.current()).toEqual(OPERATOR_POLICY);
    // This covers the adapter's bracketing contract THROUGH our composition. The CLI paths that
    // actually REACH this teardown — the daemon's shutdown and the `--off` down-verb — are #242's,
    // and are covered below.
  });

  it("sends the token as a Bearer credential to the Tailscale API, and nowhere else", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);

    expect(api.calls.length).toBeGreaterThan(0);
    for (const call of api.calls) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.url.startsWith("https://api.tailscale.com/api/v2/tailnet/-/acl")).toBe(true);
    }
    // Never onto the `tailscale` CLI's argv — the credential speaks the API seam only.
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    // Nor into the policy document the adapter writes back.
    expect(JSON.stringify(api.current())).not.toContain(TOKEN);
  });

  it("never logs the token, and never puts it on the tunnel's outputs (ADR-002 non-persisting)", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });
    const established = await tunnel.establish(LOOPBACK);
    const status = await tunnel.status();
    await tunnel.teardown();

    expect(logs.join("\n")).not.toContain(TOKEN);
    // The outward shapes carry only `kind` / `publicHost` / `up` — never the credential.
    expect(JSON.stringify(established)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("warns — without leaking the token — when a token is set but no grant is declared", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel({ [TAILSCALE_API_TOKEN_ENV]: TOKEN }, { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);

    expect(warnings.join("\n")).toContain(TAILSCALE_ACL_GRANT_ENV);
    expect(warnings.join("\n")).not.toContain(TOKEN);
    // …and it really is off: no API call, policy untouched.
    expect(api.calls).toEqual([]);
    expect(api.current()).toEqual(OPERATOR_POLICY);
  });

  it("makes NO API call and touches no policy when unconfigured (#139 default, unchanged)", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner, calls } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));

    const tunnel = createTailscaleTunnel({}, { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);
    await tunnel.teardown();

    // No credential → no provisioning → the adapter never opens the API channel at all …
    expect(api.calls).toEqual([]);
    expect(api.current()).toEqual(OPERATOR_POLICY);
    // … and drives exactly the #139 command set: serve up, status, serve off.
    expect(calls.map((c) => c.args)).toEqual([
      ["serve", "--bg", "http://127.0.0.1:4321"],
      ["status", "--json"],
      ["serve", "--bg", "http://127.0.0.1:4321", "off"],
    ]);
  });

  it("still reports the tunnel it brought up (provisioning does not disturb the establish contract)", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "phone-host.tail-scale.ts.net." })));

    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });

    expect(await tunnel.establish(LOOPBACK)).toEqual({
      kind: "tailscale",
      publicHost: "phone-host.tail-scale.ts.net",
    });
  });
});

describe("defaultDependencies — provisioning is reachable from the verbs (#153)", () => {
  it("installs the ACL-aware Tailscale factory over the registry's provisioning-less default", () => {
    // Identity, not shape: `ADAPTERS.tailscale` would satisfy a `kind` check while silently dropping
    // the credential wiring this item exists for — the exact regression that leaves provisioning
    // landed-behind-a-seam and unreachable from `ccctl tunnel`.
    expect(defaultDependencies.adapters.tailscale).not.toBe(ADAPTERS.tailscale);
    expect(defaultDependencies.adapters.tailscale().kind).toBe("tailscale");
  });

  it("leaves the Cloudflare / Headscale stubs exactly as the registry ships them", () => {
    expect(defaultDependencies.adapters.cloudflare).toBe(ADAPTERS.cloudflare);
    expect(defaultDependencies.adapters.headscale).toBe(ADAPTERS.headscale);
  });

  it("hands out a fresh tunnel per call — a tunnel is a stateful lifecycle object", () => {
    expect(defaultDependencies.adapters.tailscale()).not.toBe(defaultDependencies.adapters.tailscale());
  });
});

// ---------------------------------------------------------------------------
// the grant's revert path, end to end (#242)
//
// #153 made provisioning REACHABLE; nothing made the revert reachable, so the grant an establish
// appended stayed in the operator's policy forever. These drive the two paths that now reach
// `teardown` — the daemon's shutdown, and the `--off` down-verb — through the REAL composition
// (real `createTailscaleTunnel`, real `defaultTailscaleAclClient`, real `installShutdownSignalHandler`),
// with only the two leaf seams faked. So they assert the POLICY ITSELF — the grant gone after a revert,
// and never duplicated by a repeat — not merely that a teardown spy was called: the wiring cannot be
// green here while the operator's policy still carries the grant.
// ---------------------------------------------------------------------------

describe("the grant's revert path is reachable end to end (#242)", () => {
  // Rule (AC1): the daemon owns the tunnel's lifetime, so its shutdown reverts the grant. The real
  // signal handler drives the real tunnel's teardown — the chain the CLI wires at `serve --tunnel`.
  it("a daemon shutdown reverts the grant (SIGTERM → tunnel teardown → policy restored)", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch: api.fetch });
    await tunnel.establish(LOOPBACK);
    // The grant LANDED — without this the assertion below would pass on a policy nothing ever wrote.
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);

    // Arm the REAL shutdown handler over the REAL tunnel, exactly as `serve --tunnel` does (a thunk,
    // since the daemon arms before the establish); fake only the signal source and `process.exit`.
    const source = new EventEmitter();
    const codes: number[] = [];
    installShutdownSignalHandler({
      server: { close: () => Promise.resolve() },
      tunnel: () => tunnel,
      source,
      exit: (code) => codes.push(code),
    });

    source.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    // The operator's policy is exactly as it was found — the grant is gone, and so is the `grants`
    // key the establish created.
    expect(api.current()).toEqual(OPERATOR_POLICY);
    expect(codes).toEqual([0]);
  });

  // Rule (AC2): the standalone `ccctl tunnel <kind>` is fire-and-forget, so its revert is `--off` — a
  // LATER process with none of the establish's in-process state. Two separately-composed tunnels here,
  // which is exactly the two-process shape: the second reverts what the first left behind.
  it("the down-verb reverts the grant from a fresh process (adopt → teardown → policy restored)", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const env = provisionedEnv();

    // Process 1 — `ccctl tunnel tailscale`: establish, then exit. The mapping and grant live on.
    const up = createTailscaleTunnel(env, {
      runner: fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." }))).runner,
      fetch: api.fetch,
    });
    await up.establish(LOOPBACK);
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);

    // Process 2 — `ccctl tunnel tailscale --off`: a brand-new composition off the SAME env, which is
    // what lets it resolve the same declared grant and revert it.
    const { runner: downRunner, calls: downCalls } = fakeRunner(() => ({ stdout: "", stderr: "" }));
    const down = createTailscaleTunnel(env, { runner: downRunner, fetch: api.fetch });
    down.adopt(LOOPBACK);
    await down.teardown();

    // The grant is gone — but `grants: []` rather than the key deleted: an adopting process cannot know
    // whether the establish created the key, so it never claims it (see `adopt`). The mapping is off.
    expect(api.current().grants).toEqual([]);
    expect(api.current().acls).toEqual(OPERATOR_POLICY.acls);
    expect(downCalls.map((call) => call.args.join(" "))).toEqual(["serve --bg http://127.0.0.1:4321 off"]);
  });

  // Rule (AC3): the establishes that write these grants are fire-and-forget, so without an idempotent
  // append a repeated `ccctl tunnel tailscale` piles up one copy per run — forever, since nothing
  // reverted them. Repeated real compositions against one tailnet are exactly that repeat.
  it("repeated establishes do not accumulate duplicate grants", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const env = provisionedEnv();
    const handler = tailscaleHandler(statusJson({ DNSName: "host.ts.net." }));

    await createTailscaleTunnel(env, { runner: fakeRunner(handler).runner, fetch: api.fetch }).establish(LOOPBACK);
    await createTailscaleTunnel(env, { runner: fakeRunner(handler).runner, fetch: api.fetch }).establish(LOOPBACK);
    await createTailscaleTunnel(env, { runner: fakeRunner(handler).runner, fetch: api.fetch }).establish(LOOPBACK);

    expect(api.current().grants).toEqual([OPERATOR_GRANT]);
    // Only the first run wrote policy; the other two read, saw their grant, and skipped.
    expect(api.calls.filter((call) => (call.init.method ?? "GET") === "POST")).toHaveLength(1);
  });

  // Rule (AC1, the failure arm): a revert that fails must not be swallowed. The adapter leaves the
  // tunnel established and retryable; the shutdown cannot retry, so it names what is still out there
  // and exits non-zero rather than reporting a clean stop over a grant it did not remove.
  it("a shutdown whose revert fails still stops, but reports it and exits 1", async () => {
    const api = fakeTailscaleApi(OPERATOR_POLICY);
    const { runner } = fakeRunner(tailscaleHandler(statusJson({ DNSName: "host.ts.net." })));
    // Let the establish's write through, then fail every later (revert) write.
    let writes = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      if ((init?.method ?? "GET") === "POST" && ++writes > 1) {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      return api.fetch(input, init);
    };
    const tunnel = createTailscaleTunnel(provisionedEnv(), { runner, fetch });
    await tunnel.establish(LOOPBACK);
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);

    const source = new EventEmitter();
    const codes: number[] = [];
    const captured: LogEvent[] = [];
    let closed = false;
    installShutdownSignalHandler({
      server: {
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      },
      tunnel: () => tunnel,
      source,
      exit: (code) => codes.push(code),
      logger: { log: (event) => captured.push(event) },
    });

    source.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    // The grant is still there — honestly reported rather than silently dropped …
    expect(api.current().grants).toEqual([OPERATOR_GRANT]);
    expect(captured.map((event) => event.event)).toEqual(["tunnel-teardown-failed"]);
    expect(codes).toEqual([1]);
    // … and the daemon still stopped: the operator asked to stop, and the sessions must not be
    // trapped behind a policy write that would not land.
    expect(closed).toBe(true);
  });
});
