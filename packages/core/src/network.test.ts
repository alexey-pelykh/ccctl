// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { formatAuthority, isLoopbackHost, LOOPBACK_HOSTS } from "./index.js";

describe("isLoopbackHost", () => {
  it("accepts every loopback host, including IPv6 `::1`", () => {
    for (const host of LOOPBACK_HOSTS) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("accepts the WHOLE 127.0.0.0/8 IPv4 loopback block, not just 127.0.0.1", () => {
    // RFC 1122 §3.2.1.3: every 127.x.y.z is loopback, not only the canonical 127.0.0.1.
    for (const host of ["127.0.0.2", "127.1.2.3", "127.255.255.255", "127.0.0.0"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects a non-loopback host", () => {
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("rejects the wildcards and any off-box address", () => {
    // The two bind wildcards a loopback guarantee exists to keep out, plus a LAN and a
    // public address. None is loopback; the server bind guard refuses them all.
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "8.8.8.8"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("fails closed on ambiguous or partial 127-ish spellings (never guessed into loopback)", () => {
    // A leading-zero octet (octal-ambiguity footgun), an out-of-range octet, and a partial
    // dotted form are all refused rather than silently treated as loopback — a bind guard
    // over-refuses, never over-permits.
    for (const host of ["127.00.0.1", "127.0.0.256", "127.1", "127.0.0.1.1", "0177.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("formatAuthority (RFC 3986 host:port, IPv6 bracketed)", () => {
  it("leaves an IPv4 host or hostname unbracketed", () => {
    expect(formatAuthority("127.0.0.1", 4321)).toBe("127.0.0.1:4321");
    expect(formatAuthority("localhost", 80)).toBe("localhost:80");
  });

  it("brackets an IPv6 host — the `::1:port` malformed-authority trap", () => {
    expect(formatAuthority("::1", 4321)).toBe("[::1]:4321");
    expect(formatAuthority("fd7a:115c:a1e0::1", 443)).toBe("[fd7a:115c:a1e0::1]:443");
  });
});
