// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  BORN_STATUS,
  classifyLaunchFlow,
  describeLaunchIntent,
  LAUNCH_CHECK,
  LAUNCH_REGISTRATION_TIMEOUT_MS,
  parseLaunchAcceptedBody,
  parseLaunchIntent,
  sameLaunchIntent,
  type LaunchIntent,
  type LaunchTunnelCapture,
} from "./launch-tunnel.js";

// The CREDENTIAL-FREE specs for the UC2-launch-over-a-real-tunnel oracle (#66, traces E2E-B-001 /
// UC2) — the Tier-A encoding of its three ACs, and the reason the AC JUDGMENT gates EVERY CI run
// while only the TRANSPORT is fenced to an operator's tailnet.
//
// `launch-tunnel-flow.e2e.test.ts` supplies a real tailnet and drives the flow; this file proves the
// pure decision it dispositions is correct — that no capture missing a leg, and no capture carrying a
// violated one, can reach `verified`. A classifier that could be talked into a green is the one way a
// fenced oracle silently becomes ceremony, so every AC gets its own unreachability proof here.
//
// The fence itself (`resolveTunnelE2EEnv`) and the reachable-base helpers (`isTailnetHost`,
// `tunnelPhoneBaseUrl`) are REUSED from the UC1 tunnel oracle and are already pinned, exhaustively, by
// `multi-session-tunnel.test.ts` — re-asserting them here would be a second copy of those specs, green
// on both sides the day the fence changes.

const LAUNCHED_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TAILNET_HOST = "phone.tail1234.ts.net";

const PHONE_INTENT: LaunchIntent = {
  cwd: "/private/tmp/ccctl-e2e-uc2-abc",
  permissionMode: "default",
  project: "ccctl-e2e-uc2",
  initialPrompt: "seed prompt",
};

/** A capture in which every leg was observed and conformant — the `verified` baseline each spec perturbs. */
function verifiedCapture(): LaunchTunnelCapture {
  return {
    tunnelUp: true,
    publicHost: TAILNET_HOST,
    publicSurface: false,
    launchedSessionId: LAUNCHED_ID,
    requestedLaunch: PHONE_INTENT,
    launcherInvokedWith: PHONE_INTENT,
    bornListed: true,
    bornStatus: BORN_STATUS,
    bornStatusOk: true,
    registeredSessionId: LAUNCHED_ID,
    registeredListedIds: [LAUNCHED_ID],
    registeredStatus: "connecting",
    steered: true,
    viewed: true,
  };
}

describe("the `verified` baseline", () => {
  it("classifies a fully-observed, conformant UC2 run as `verified` with no violations", () => {
    const report = classifyLaunchFlow(verifiedCapture());

    expect(report.verdict).toBe("verified");
    expect(report.violations).toEqual([]);
    // Non-vacuous: the reason names the launched id and the tailnet base it was driven over, so a
    // green cannot be produced by a capture that observed nothing.
    expect(report.reason).toContain(LAUNCHED_ID);
    expect(report.reason).toContain(TAILNET_HOST);
  });
});

/**
 * Every capture field whose absence must make `verified` unreachable — i.e. every observation that
 * GATES a verdict.
 *
 * `publicHost` is deliberately absent from this list, and it is the only exclusion: it gates nothing
 * and carries no evidence. It is the base's NAME, quoted into the `drift` / `verified` prose so a
 * verdict is diagnosable. The AC3 evidence is `publicSurface` — `false` means the base was READ and
 * judged tailnet-scoped, which cannot be true without a host — so `publicHost` is a label on that
 * finding, not a finding.
 */
const GATING_LEGS = [
  "launchedSessionId",
  "requestedLaunch",
  "launcherInvokedWith",
  "bornStatus",
  "registeredSessionId",
  "registeredListedIds",
  "registeredStatus",
  "steered",
  "viewed",
  "publicSurface",
] as const;

describe("no capture missing a gating leg can reach `verified` — exhaustively", () => {
  // The property this whole file claims, enforced MECHANICALLY rather than by a hand-written
  // enumeration that a later field can be added without.
  //
  // This exists because the per-AC specs below, thorough as they look, MISSED three real
  // false-`verified` holes — `requestedLaunch` (AC1's comparison was gap-checked on one side only),
  // and `registeredListedIds` both absent and empty. A fresh-context adversarial validator found them
  // in one pass by doing exactly this: blank each optional leg in turn and ask whether the contract
  // still holds. A per-field spec list can only test the fields someone thought to name, which is
  // precisely the set that excludes an oversight; this sweep tests the ones nobody did.
  //
  // It is load-bearing rather than belt-and-braces because of WHERE the holes were: the drive
  // backstops all three (it never emits such a capture), but the drive is the FENCED half that runs
  // only on an operator's tailnet — while `classifyLaunchFlow` is the half that gates EVERY CI run,
  // and is public API through the package barrel. A guard in the never-run half does not protect the
  // always-run one.
  it.each(GATING_LEGS)("is never `verified` when `%s` was never captured", (leg) => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), [leg]: undefined });

    expect(report.verdict).not.toBe("verified");
    // …and the verdict must SAY what was missing or wrong, so an operator can act on it.
    expect(report.reason).not.toBe("");
  });

  it("is never `verified` when the tunnel never came up", () => {
    expect(classifyLaunchFlow({ ...verifiedCapture(), tunnelUp: false }).verdict).not.toBe("verified");
  });

  it("is never `verified` when the phone never listed from birth", () => {
    expect(classifyLaunchFlow({ ...verifiedCapture(), bornListed: false }).verdict).not.toBe("verified");
  });

  it("is never `verified` when the born row carried no usable per-session status", () => {
    expect(classifyLaunchFlow({ ...verifiedCapture(), bornStatusOk: false }).verdict).not.toBe("verified");
  });
});

describe("AC1 — a New session request from the phone launches a session OVER the tunnel", () => {
  it("is `inconclusive`, never `verified`, when the phone never launched over the tunnel", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), launchedSessionId: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.launch);
  });

  it("is `inconclusive` when the daemon's own launcher never ran — a 201 alone is not a launch", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), launcherInvokedWith: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.launcherIntent);
  });

  it("is `inconclusive` when what the phone ASKED to launch was never captured — both sides gate", () => {
    // The AC1 drift check fires only when BOTH sides are defined, so an unobserved REQUEST side must
    // be a gap in its own right. Otherwise this capture — a daemon that launched an attacker's cwd
    // under a non-prompting mode, compared against nothing — reads `verified` with no violations.
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      requestedLaunch: undefined,
      launcherInvokedWith: { cwd: "/attacker/controlled", permissionMode: "bypassPermissions" },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.launch);
  });

  it("is `drift` when the daemon launched something OTHER than what the phone asked for", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      // The daemon dropped the operator's seed prompt — a launch, but not the requested one.
      launcherInvokedWith: { ...PHONE_INTENT, initialPrompt: undefined },
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain(LAUNCH_CHECK.launcherIntent);
    // The violation names BOTH sides, so the failure is diagnosable without re-running.
    expect(report.violations[0]).toContain("seed prompt");
  });

  it("is `drift` when the daemon rooted the terminal at a different directory", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      launcherInvokedWith: { ...PHONE_INTENT, cwd: "/somewhere/else" },
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.launcherIntent);
  });
});

describe("AC2 — the launched session appears in the list FROM BIRTH", () => {
  it("is `inconclusive` when the phone never listed over the tunnel from birth", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), bornListed: false, bornStatus: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.birth);
  });

  it("is `drift` when the phone DID list from birth but the launched session was absent", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), bornStatus: undefined, bornStatusOk: false });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.birth);
    expect(report.violations[0]).toContain(LAUNCHED_ID);
  });

  it(`is \`drift\` when the launched session was born under a status other than \`${BORN_STATUS}\``, () => {
    // A session born already-`connecting` would mean the daemon claimed a worker that cannot exist
    // yet — the row must be `registering` until its own worker checks in (#33).
    const report = classifyLaunchFlow({ ...verifiedCapture(), bornStatus: "connecting" });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.birth);
    expect(report.violations[0]).toContain("connecting");
  });

  it("is `inconclusive`, never `verified`, when the born row carried no usable per-session status", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), bornStatusOk: false });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.birth);
  });
});

describe("AC2 — the launched session REGISTERS (the claim, and its id continuity)", () => {
  it("is `inconclusive` when the launched session's worker never registered", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      registeredSessionId: undefined,
      registeredListedIds: undefined,
      registeredStatus: undefined,
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.registration);
  });

  it("is `drift` when the registration minted a FRESH id instead of claiming the launch", () => {
    // THE load-bearing case: an unclaimed launch still answers a 201 and still yields a live,
    // listable, steerable session — only the id says the operator's row was disowned.
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      registeredSessionId: OTHER_ID,
      registeredListedIds: [LAUNCHED_ID, OTHER_ID],
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.includes(LAUNCH_CHECK.registration))).toBe(true);
    expect(report.violations.join(" ")).toContain(OTHER_ID);
  });

  it("is `drift` when the phone listed over the tunnel after registration and saw NO sessions at all", () => {
    // The cardinality-zero case: a set comparison skipped on an EMPTY list is not evidence — the
    // launched session must be in a list the phone actually read, so an empty one is a definitive
    // violation, not a gap. (`undefined` — never read — IS the gap; that is the sweep's case above.)
    const report = classifyLaunchFlow({ ...verifiedCapture(), registeredListedIds: [] });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.registration);
  });

  it("is `inconclusive` when the phone never listed over the tunnel after the registration", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), registeredListedIds: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.registration);
  });

  it("is `drift` when a SECOND row appeared beside the launched one — the phone's own independent read", () => {
    // The §2 receipt and the phone's list are two independent receivers of the same claim. A daemon
    // that answered the right id but left a ghost row beside it still fails "appears in the list".
    const report = classifyLaunchFlow({ ...verifiedCapture(), registeredListedIds: [LAUNCHED_ID, OTHER_ID] });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.registration);
    expect(report.violations[0]).toContain(OTHER_ID);
  });

  it(`is \`drift\` when the row is still \`${BORN_STATUS}\` after its own worker registered`, () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), registeredStatus: BORN_STATUS });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.registration);
    expect(report.violations[0]).toContain("never advanced");
  });

  it("is `inconclusive` when the launched row's status was never read back over the tunnel", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), registeredStatus: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.registration);
  });
});

describe("AC2 — the launched session is viewable / steerable OVER the tunnel", () => {
  it("is `inconclusive` when the steer leg was never observed", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), steered: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.steer);
  });

  it("is `inconclusive` when the view leg was never observed", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), viewed: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.view);
  });

  it("is `inconclusive`, never `verified`, when a captured steer was not positively confirmed", () => {
    // `false` is a captured-but-wrong observation, not a gap — it must never read as verified.
    const report = classifyLaunchFlow({ ...verifiedCapture(), steered: false });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.steer);
  });

  it("is `inconclusive`, never `verified`, when a captured view was not positively confirmed", () => {
    const report = classifyLaunchFlow({ ...verifiedCapture(), viewed: false });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.view);
  });
});

describe("AC3 — the flow runs over a REAL Tailscale tunnel, with no public surface", () => {
  it("is `inconclusive` when no real tunnel came up", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      tunnelUp: false,
      publicHost: undefined,
      publicSurface: undefined,
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.tunnel);
  });

  it("is `drift` when the reachable base was a PUBLIC host — a public base can never reach `verified`", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      publicHost: "ccctl.example.com",
      publicSurface: true,
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.publicSurface);
    expect(report.violations[0]).toContain("ccctl.example.com");
  });

  it("is `inconclusive`, never `verified`, when the base was never confirmed tailnet-scoped", () => {
    // `undefined` is "never judged" — with the tunnel up but the base unclassified, the AC3 evidence
    // is absent, so the run has no signal rather than a green.
    const report = classifyLaunchFlow({ ...verifiedCapture(), publicSurface: undefined });

    expect(report.verdict).toBe("inconclusive");
    expect(report.reason).toContain(LAUNCH_CHECK.publicSurface);
  });
});

describe("verdict precedence — drift OUTRANKS an inconclusive gap", () => {
  it("reports `drift` when a violation and a missing leg are captured together", () => {
    // A present-but-wrong leg is the signal the oracle exists to raise; it must never be masked by a
    // downstream gap that happened to be missing in the same run.
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      publicSurface: true,
      publicHost: "ccctl.example.com",
      steered: undefined,
      viewed: undefined,
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations[0]).toContain(LAUNCH_CHECK.publicSurface);
  });

  it("names EVERY violated check rather than only the first", () => {
    const report = classifyLaunchFlow({
      ...verifiedCapture(),
      publicSurface: true,
      registeredStatus: BORN_STATUS,
    });

    expect(report.verdict).toBe("drift");
    expect(report.violations).toHaveLength(2);
    expect(report.reason).toContain("2 check(s)");
  });
});

describe("parseLaunchAcceptedBody", () => {
  it("reads the launched session id and its attachment off a well-formed 201", () => {
    expect(
      parseLaunchAcceptedBody({ sessionId: LAUNCHED_ID, attachable: true, hint: "tmux attach -t ccctl:1" }),
    ).toEqual({ sessionId: LAUNCHED_ID, attachable: true, hint: "tmux attach -t ccctl:1" });
  });

  it("reads a DEGRADED surface's attachment — the fallback backend is not required to be attachable", () => {
    expect(parseLaunchAcceptedBody({ sessionId: LAUNCHED_ID, attachable: false, hint: "owned pty" }).attachable).toBe(
      false,
    );
  });

  it.each([
    ["a non-object body", "nope"],
    ["a null body", null],
    ["an array body", []],
    ["no sessionId", { attachable: true, hint: "h" }],
    ["a blank sessionId", { sessionId: "", attachable: true, hint: "h" }],
    ["a non-string sessionId", { sessionId: 7, attachable: true, hint: "h" }],
    ["no attachment", { sessionId: LAUNCHED_ID }],
    ["a non-boolean attachable", { sessionId: LAUNCHED_ID, attachable: "yes", hint: "h" }],
    ["a non-string hint", { sessionId: LAUNCHED_ID, attachable: true, hint: 7 }],
  ])("throws on %s rather than letting it masquerade as a launch", (_label, body) => {
    // Fails CLOSED: a broken launch answer must not read as a launch that minted an id — the drive
    // catches the throw and the classifier reads the absent id as the `inconclusive` launch gap.
    expect(() => parseLaunchAcceptedBody(body)).toThrow(/ccctl e2e/);
  });
});

describe("parseLaunchIntent", () => {
  it("reads the phone's own POSTed body back into its comparable intent", () => {
    expect(
      parseLaunchIntent({
        cwd: PHONE_INTENT.cwd,
        permissionMode: "default",
        project: "ccctl-e2e-uc2",
        initialPrompt: "seed prompt",
      }),
    ).toEqual(PHONE_INTENT);
  });

  it("OMITS an absent optional rather than carrying it as an explicit `undefined` key", () => {
    // `exactOptionalPropertyTypes` — the reader omits the key rather than setting it `undefined`, so
    // an intent read off a body with no `project` is `sameLaunchIntent` to one the ingress omitted it
    // from. `toStrictEqual` is what pins that: it tells an absent key from a present-and-undefined
    // one, which `toEqual` deliberately does not.
    expect(parseLaunchIntent({ cwd: "/p", permissionMode: "default" })).toStrictEqual({
      cwd: "/p",
      permissionMode: "default",
    });
  });

  it.each([
    ["a non-object body", "nope"],
    ["a null body", null],
    ["an array body", []],
    ["no cwd", { permissionMode: "default" }],
    ["a blank cwd", { cwd: "", permissionMode: "default" }],
    ["a non-string cwd", { cwd: 7, permissionMode: "default" }],
    ["no permissionMode", { cwd: "/p" }],
    ["a blank permissionMode", { cwd: "/p", permissionMode: "" }],
    ["a non-string permissionMode", { cwd: "/p", permissionMode: 7 }],
    ["a non-string project", { cwd: "/p", permissionMode: "default", project: 7 }],
    ["a non-string initialPrompt", { cwd: "/p", permissionMode: "default", initialPrompt: 7 }],
  ])("reads %s as null — an unparseable request is a GAP, never a silent half-intent", (_label, body) => {
    // Returning null rather than a partial intent is what keeps the drive's AC1 comparison honest: a
    // body the oracle cannot read becomes the `inconclusive` "what the phone asked to launch was never
    // captured" gap, not an intent that might compare equal to whatever the launcher happened to get.
    expect(parseLaunchIntent(body)).toBeNull();
  });
});

describe("sameLaunchIntent", () => {
  it("is true for the same request", () => {
    expect(sameLaunchIntent(PHONE_INTENT, { ...PHONE_INTENT })).toBe(true);
  });

  it("reads an omitted optional and an absent one alike — the ingress OMITS blank optionals", () => {
    const withoutProject: LaunchIntent = { cwd: PHONE_INTENT.cwd, permissionMode: "default" };
    expect(sameLaunchIntent(withoutProject, { ...withoutProject, project: undefined })).toBe(true);
  });

  it.each([
    ["cwd", { ...PHONE_INTENT, cwd: "/elsewhere" }],
    ["permissionMode", { ...PHONE_INTENT, permissionMode: "plan" }],
    ["project", { ...PHONE_INTENT, project: "other" }],
    ["initialPrompt", { ...PHONE_INTENT, initialPrompt: "other" }],
    ["a dropped project", { ...PHONE_INTENT, project: undefined }],
    ["a dropped initialPrompt", { ...PHONE_INTENT, initialPrompt: undefined }],
  ])("is false when %s differs", (_label, other: LaunchIntent) => {
    expect(sameLaunchIntent(PHONE_INTENT, other)).toBe(false);
  });
});

describe("describeLaunchIntent", () => {
  it("renders the cwd, the mode and every present optional — a drift violation must be diagnosable", () => {
    expect(describeLaunchIntent(PHONE_INTENT)).toBe(
      "/private/tmp/ccctl-e2e-uc2-abc (mode=default, project=ccctl-e2e-uc2, prompt=seed prompt)",
    );
  });

  it("omits the optionals that are absent", () => {
    expect(describeLaunchIntent({ cwd: "/p", permissionMode: "default" })).toBe("/p (mode=default)");
  });
});

describe("LAUNCH_REGISTRATION_TIMEOUT_MS", () => {
  it("is far above the daemon's 10s default, so a slow tailnet cannot evict the launch mid-flow", () => {
    // The e2e's whole drive — launch, born-list read, §1/§2/§3, worker channel — must fit inside the
    // window with two real HTTPS round-trips in it. An eviction mid-flow would make the §2 claim miss
    // and the classifier would read a faithful daemon as `drift`: a false red manufactured by latency.
    expect(LAUNCH_REGISTRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
