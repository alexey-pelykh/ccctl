// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  ADDRESS_IN_USE_CODE,
  brandListenError,
  DEFAULT_HOST,
  LOCAL_SERVER_AUTH_ENV,
  requireLocalServerAuth,
  resolveBindHost,
  WILDCARD_BIND_HOST,
} from "./startup.js";

/** A Node-style `listen()` error (an ErrnoException with a `.code`), built without binding a socket. */
function listenError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

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

describe("brandListenError — actionable 'port already in use' message (#156)", () => {
  it("rebrands EADDRINUSE into a branded ccctl message naming the port and the --port fix", () => {
    const raw = listenError(ADDRESS_IN_USE_CODE, "listen EADDRINUSE: address already in use 127.0.0.1:4321");
    const branded = brandListenError(raw, 4321);
    // The branded guardrail voice: `ccctl:` prefix, the port that collided, the fix.
    expect(branded.message).toMatch(/^ccctl: port 4321 is already in use/);
    expect(branded.message).toMatch(/pass --port/);
    // The raw Node diagnostic string must NOT leak through — that is the whole bug.
    expect(branded.message).not.toMatch(/EADDRINUSE/);
  });

  it("names the actual configured port so the operator knows which one collided", () => {
    const raw = listenError(ADDRESS_IN_USE_CODE, "listen EADDRINUSE: address already in use 127.0.0.1:9999");
    expect(brandListenError(raw, 9999).message).toContain("9999");
  });

  it("passes a non-EADDRINUSE listen error through unchanged (keeps its own diagnostics)", () => {
    const other = listenError("EACCES", "listen EACCES: permission denied 127.0.0.1:80");
    expect(brandListenError(other, 80)).toBe(other);
  });

  it("passes an error with no code through unchanged (only EADDRINUSE is rebranded)", () => {
    const bare = new Error("something else entirely");
    expect(brandListenError(bare, 4321)).toBe(bare);
  });
});
