// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { parseBearer } from "./bearer.js";

describe("parseBearer", () => {
  it("returns the token from a well-formed Bearer header", () => {
    expect(parseBearer("Bearer oauth-account-secret")).toBe("oauth-account-secret");
  });

  it("matches the scheme case-insensitively (RFC 7235) and trims the token", () => {
    expect(parseBearer("bearer  spaced-token ")).toBe("spaced-token");
  });

  it("returns null when the header is absent", () => {
    expect(parseBearer(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(parseBearer("Basic Zm9vOmJhcg==")).toBeNull();
  });

  it("returns null for an empty or whitespace-only token", () => {
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearer    ")).toBeNull();
  });

  it("returns null when there is no scheme separator", () => {
    expect(parseBearer("BearerNoSpace")).toBeNull();
  });
});
