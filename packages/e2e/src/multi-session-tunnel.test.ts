// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  classifyTunnelFlow,
  describeTunnelFence,
  hasPerSessionStatus,
  isTailnetHost,
  parseSessionsListBody,
  resolveTunnelE2EEnv,
  TUNNEL_ENV_VARS,
  tunnelPhoneBaseUrl,
  userTurnSessionId,
  userTurnText,
  type TunnelCapture,
} from "./multi-session-tunnel.js";

// The pure fence + classifier for the real-tunnel oracle (#65, E2E-B-001). These gate on
// EVERY run in the credential-free `test` lane — they are the Tier-A encoding of UC1's
// three ACs (≥2 sessions listed with status; view + steer each; over a tailnet-scoped,
// no-public-surface base). The fenced e2e (`multi-session-tunnel-flow.e2e.test.ts`) is the
// live confirmation that only runs in the operator's tailnet.

describe("resolveTunnelE2EEnv — the real-tunnel fence (both flags truthy)", () => {
  it("is READY when CCCTL_E2E and CCCTL_E2E_TAILSCALE are both truthy", () => {
    expect(resolveTunnelE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_TAILSCALE: "1" })).toEqual({ ready: true });
  });

  it("accepts assorted truthy spellings", () => {
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
      expect(resolveTunnelE2EEnv({ CCCTL_E2E: on, CCCTL_E2E_TAILSCALE: on }).ready).toBe(true);
    }
  });

  it("is NOT ready when CCCTL_E2E_TAILSCALE is absent — names it", () => {
    const fence = resolveTunnelE2EEnv({ CCCTL_E2E: "1" });
    expect(fence.ready).toBe(false);
    expect(fence.ready === false && fence.missing).toEqual(["CCCTL_E2E_TAILSCALE"]);
  });

  it("is NOT ready when CCCTL_E2E is absent — names it", () => {
    const fence = resolveTunnelE2EEnv({ CCCTL_E2E_TAILSCALE: "1" });
    expect(fence.ready).toBe(false);
    expect(fence.ready === false && fence.missing).toEqual(["CCCTL_E2E"]);
  });

  it("is NOT ready when both are absent — names both", () => {
    const fence = resolveTunnelE2EEnv({});
    expect(fence.ready).toBe(false);
    expect(fence.ready === false && fence.missing).toEqual(["CCCTL_E2E", "CCCTL_E2E_TAILSCALE"]);
  });

  it("treats the conventional OFF spellings as not-set", () => {
    for (const off of ["", "0", "false", "no", "  ", "FALSE"]) {
      expect(resolveTunnelE2EEnv({ CCCTL_E2E: off, CCCTL_E2E_TAILSCALE: "1" }).ready).toBe(false);
      expect(resolveTunnelE2EEnv({ CCCTL_E2E: "1", CCCTL_E2E_TAILSCALE: off }).ready).toBe(false);
    }
  });

  it("exposes the fenced env var names", () => {
    expect(TUNNEL_ENV_VARS).toEqual(["CCCTL_E2E", "CCCTL_E2E_TAILSCALE"]);
  });
});

describe("describeTunnelFence — the one-line skip note", () => {
  it("reports armed when ready", () => {
    expect(describeTunnelFence({ ready: true })).toContain("armed");
  });

  it("names the missing vars when not ready", () => {
    expect(describeTunnelFence({ ready: false, missing: ["CCCTL_E2E_TAILSCALE"] })).toContain("CCCTL_E2E_TAILSCALE");
  });
});

describe("tunnelPhoneBaseUrl — the over-tunnel base the phone dials", () => {
  it("builds an HTTPS/443 base from a MagicDNS host", () => {
    expect(tunnelPhoneBaseUrl({ kind: "tailscale", publicHost: "phone.tail-abc.ts.net" })).toBe(
      "https://phone.tail-abc.ts.net:443",
    );
  });

  it("builds an HTTPS/443 base from a tailnet IPv4", () => {
    expect(tunnelPhoneBaseUrl({ kind: "tailscale", publicHost: "100.101.102.103" })).toBe(
      "https://100.101.102.103:443",
    );
  });

  it("brackets a tailnet IPv6 host", () => {
    expect(tunnelPhoneBaseUrl({ kind: "tailscale", publicHost: "fd7a:115c:a1e0::1" })).toBe(
      "https://[fd7a:115c:a1e0::1]:443",
    );
  });
});

describe("isTailnetHost — the no-public-IP encoding (AC3)", () => {
  it("accepts MagicDNS *.ts.net names (trailing dot + case tolerant)", () => {
    expect(isTailnetHost("phone.tail-abc.ts.net")).toBe(true);
    expect(isTailnetHost("PHONE.TAIL-ABC.TS.NET.")).toBe(true);
  });

  it("accepts CGNAT 100.64.0.0/10 tailnet IPv4", () => {
    expect(isTailnetHost("100.64.0.0")).toBe(true);
    expect(isTailnetHost("100.101.102.103")).toBe(true);
    expect(isTailnetHost("100.127.255.255")).toBe(true);
  });

  it("rejects IPv4 just outside the CGNAT range", () => {
    expect(isTailnetHost("100.63.255.255")).toBe(false); // second octet 63 < 64
    expect(isTailnetHost("100.128.0.0")).toBe(false); // second octet 128 > 127
    expect(isTailnetHost("101.64.0.0")).toBe(false); // first octet not 100
  });

  it("accepts the Tailscale IPv6 ULA prefix fd7a:115c:a1e0::/48", () => {
    expect(isTailnetHost("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetHost("FD7A:115C:A1E0:AB12::9")).toBe(true);
  });

  it("rejects public hosts and IPs — a public reachable base is a drift", () => {
    expect(isTailnetHost("1.2.3.4")).toBe(false);
    expect(isTailnetHost("8.8.8.8")).toBe(false);
    expect(isTailnetHost("example.com")).toBe(false);
    expect(isTailnetHost("phone.ts.net.evil.com")).toBe(false);
    expect(isTailnetHost("")).toBe(false);
    expect(isTailnetHost("100.64.0")).toBe(false); // not four octets
    expect(isTailnetHost("100.64.0.256")).toBe(false); // octet out of range
  });
});

describe("parseSessionsListBody — the over-tunnel list read", () => {
  it("returns the sessions array from a well-formed body", () => {
    const entries = [{ id: "s1", status: "active", activity: { kind: "idle" } }];
    expect(parseSessionsListBody({ sessions: entries })).toEqual(entries);
  });

  it("throws on a malformed body (not a { sessions: [...] } shape)", () => {
    expect(() => parseSessionsListBody(null)).toThrow();
    expect(() => parseSessionsListBody({})).toThrow();
    expect(() => parseSessionsListBody({ sessions: "nope" })).toThrow();
  });
});

describe("hasPerSessionStatus — each listed session carries its own status (AC1)", () => {
  it("accepts an entry with a non-empty status + activity.kind", () => {
    expect(hasPerSessionStatus({ id: "s1", status: "active", activity: { kind: "running" } })).toBe(true);
  });

  it("rejects an entry missing its status or activity", () => {
    expect(hasPerSessionStatus({ id: "s1", status: "", activity: { kind: "idle" } })).toBe(false);
    expect(hasPerSessionStatus({ id: "s1", status: "active", activity: { kind: "" } })).toBe(false);
    expect(hasPerSessionStatus({ id: "s1", status: "active" } as never)).toBe(false);
  });
});

describe("userTurnText / userTurnSessionId — receiver-grounded steer reads", () => {
  const turn = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "steer-for-session-0" }] },
    session_id: "sess-0",
  };

  it("extracts the prompt text and session id from a well-formed user turn", () => {
    expect(userTurnText(turn)).toBe("steer-for-session-0");
    expect(userTurnSessionId(turn)).toBe("sess-0");
  });

  it("returns null for a non-user or malformed payload", () => {
    expect(userTurnText({ type: "control_request" })).toBeNull();
    expect(userTurnText({ type: "user", message: { content: [] } })).toBeNull();
    expect(userTurnText("nope")).toBeNull();
    expect(userTurnSessionId({ type: "user" })).toBeNull();
    expect(userTurnSessionId({ type: "user", session_id: "" })).toBeNull();
    expect(userTurnSessionId(null)).toBeNull();
  });
});

describe("classifyTunnelFlow — the self-classifying verdict (verified | drift | inconclusive)", () => {
  /** A baseline VERIFIED capture — a clean ≥2-session flow over a tailnet base. Overridden per case. */
  function capture(overrides: Partial<TunnelCapture> = {}): TunnelCapture {
    return {
      tunnelUp: true,
      publicHost: "phone.tail-abc.ts.net",
      publicSurface: false,
      expectedSessionIds: ["s1", "s2"],
      listedIds: ["s1", "s2"],
      perSessionStatusOk: true,
      steeredIsolated: true,
      viewedIsolated: true,
      crossWired: false,
      ...overrides,
    };
  }

  it("VERIFIED — a clean ≥2-session flow over a tailnet base", () => {
    const report = classifyTunnelFlow(capture());
    expect(report.verdict).toBe("verified");
    expect(report.violations).toEqual([]);
  });

  it("VERIFIED — order-independent list match", () => {
    expect(classifyTunnelFlow(capture({ listedIds: ["s2", "s1"] })).verdict).toBe("verified");
  });

  it("DRIFT — a cross-wired steer/transcript", () => {
    const report = classifyTunnelFlow(capture({ crossWired: true }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.includes("isolation"))).toBe(true);
  });

  it("DRIFT — a PUBLIC reachable base (AC3 violated)", () => {
    const report = classifyTunnelFlow(capture({ publicSurface: true, publicHost: "1.2.3.4" }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.includes("PUBLIC"))).toBe(true);
  });

  it("DRIFT — the listed set diverged from the carried sessions", () => {
    const report = classifyTunnelFlow(capture({ listedIds: ["s1", "s3"] }));
    expect(report.verdict).toBe("drift");
    expect(report.violations.some((v) => v.includes("listed"))).toBe(true);
  });

  it("DRIFT outranks an INCONCLUSIVE gap — a present-but-wrong leg is never masked", () => {
    // Cross-wired AND the tunnel reported down: the observed violation wins.
    const report = classifyTunnelFlow(capture({ crossWired: true, tunnelUp: false }));
    expect(report.verdict).toBe("drift");
  });

  it("INCONCLUSIVE — no real tunnel came up", () => {
    const report = classifyTunnelFlow(capture({ tunnelUp: false, publicHost: undefined, publicSurface: undefined }));
    expect(report.verdict).toBe("inconclusive");
    expect(report.violations).toEqual([]);
  });

  it("INCONCLUSIVE — fewer than two sessions carried", () => {
    expect(classifyTunnelFlow(capture({ expectedSessionIds: ["s1"], listedIds: ["s1"] })).verdict).toBe("inconclusive");
  });

  it("INCONCLUSIVE — the phone never listed over the tunnel", () => {
    expect(classifyTunnelFlow(capture({ listedIds: [] })).verdict).toBe("inconclusive");
  });

  it("INCONCLUSIVE — a steer or view leg was never observed", () => {
    expect(classifyTunnelFlow(capture({ steeredIsolated: undefined })).verdict).toBe("inconclusive");
    expect(classifyTunnelFlow(capture({ viewedIsolated: undefined })).verdict).toBe("inconclusive");
  });

  it("INCONCLUSIVE (residue) — captured but a listed session was missing its status; never a false green", () => {
    const report = classifyTunnelFlow(capture({ perSessionStatusOk: false }));
    expect(report.verdict).toBe("inconclusive");
  });

  it("INCONCLUSIVE (residue) — captured but isolation was not positively confirmed (false, not undefined)", () => {
    expect(classifyTunnelFlow(capture({ steeredIsolated: false })).verdict).toBe("inconclusive");
    expect(classifyTunnelFlow(capture({ viewedIsolated: false })).verdict).toBe("inconclusive");
  });
});
