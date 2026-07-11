// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  LOCAL_SERVER_AUTH_ENV,
  requireLocalServerAuth,
  resolveBindHost,
  WILDCARD_BIND_HOST,
} from "./startup.js";

describe("requireLocalServerAuth — refuse-start-without-auth (#14 AC1)", () => {
  it("returns the configured secret (trimmed)", () => {
    expect(requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "  s3cret  " })).toBe("s3cret");
  });

  it("throws a clear error stating auth is required when the key is absent", () => {
    // The message must state that local-server auth is required (S1: "the error
    // message states that local-server auth is required").
    expect(() => requireLocalServerAuth({})).toThrow(/local-server auth is required/);
  });

  it("names the config key in the refusal so the skeleton is provisionable", () => {
    expect(() => requireLocalServerAuth({})).toThrow(LOCAL_SERVER_AUTH_ENV);
  });

  it("treats a present-but-blank value as no auth (empty secret is not a secret)", () => {
    expect(() => requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "" })).toThrow(/auth is required/);
    expect(() => requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "   " })).toThrow(/auth is required/);
  });

  it("reads from the injected env only — never mutates process.env", () => {
    const before = process.env[LOCAL_SERVER_AUTH_ENV];
    requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "isolated" });
    expect(process.env[LOCAL_SERVER_AUTH_ENV]).toBe(before);
  });
});

describe("resolveBindHost — localhost-bind, never 0.0.0.0 (#14 AC2)", () => {
  it("defaults to the loopback host when no override is given (default binds loopback)", () => {
    expect(resolveBindHost()).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("returns an explicit loopback host unchanged", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(resolveBindHost(host)).toBe(host);
    }
  });

  it("refuses the 0.0.0.0 wildcard with an error explaining loopback-only", () => {
    expect(WILDCARD_BIND_HOST).toBe("0.0.0.0");
    expect(() => resolveBindHost(WILDCARD_BIND_HOST)).toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(() => resolveBindHost(WILDCARD_BIND_HOST)).toThrow(/loopback only/);
  });

  it("refuses only the 0.0.0.0 wildcard at this slice — the full non-loopback refusal is #58", () => {
    // The minimal ride-along guards exactly the AC's wording ("never 0.0.0.0").
    // Refusing every non-loopback address (`::`, LAN, public) and making the
    // guarantee non-overridable is completed to spec in #58, so a routable host
    // still passes through here rather than being refused prematurely.
    expect(resolveBindHost("192.168.1.10")).toBe("192.168.1.10");
  });
});
