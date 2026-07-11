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

  it("rejects a non-loopback host", () => {
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
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
