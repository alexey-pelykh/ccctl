// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_SERVER_AUTH_ENV } from "@ccctl/server";
import { buildProgram } from "./index.js";

// The `serve` action throws on a guard refusal (and on the skeleton boundary);
// commander surfaces that as a rejected `parseAsync`, which `cli.ts` turns into a
// non-zero process exit code. So "the daemon exits non-zero" is exercised here as
// "parseAsync rejects".
function serve(...args: string[]): Promise<unknown> {
  return buildProgram().parseAsync(["serve", ...args], { from: "user" });
}

const originalAuth = process.env[LOCAL_SERVER_AUTH_ENV];

afterEach(() => {
  if (originalAuth === undefined) {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
  } else {
    process.env[LOCAL_SERVER_AUTH_ENV] = originalAuth;
  }
});

describe("ccctl serve — baseline startup guards (#14)", () => {
  it("refuses to start with a clear error when no local-server auth is configured (AC1 / S1)", async () => {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
    await expect(serve()).rejects.toThrow(/local-server auth is required/);
  });

  it("checks auth before the bind — a missing secret refuses even with a bad --host", async () => {
    Reflect.deleteProperty(process.env, LOCAL_SERVER_AUTH_ENV);
    await expect(serve("--host", "0.0.0.0")).rejects.toThrow(/local-server auth is required/);
  });

  it("refuses a 0.0.0.0 bind once auth is configured (AC2 / S2: never 0.0.0.0)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    await expect(serve("--host", "0.0.0.0")).rejects.toThrow(/refusing to bind 0\.0\.0\.0/);
  });

  it("passes both guards for the default loopback bind, reaching the deferred serve boundary (AC2 / S2: binds 127.0.0.1)", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    // Auth present + default loopback host → both guards pass → the daemon would
    // bind loopback and start. The actual server + tunnel wiring is #71, so it
    // stops at the skeleton boundary rather than at a guard refusal.
    await expect(serve()).rejects.toThrow(/not implemented yet \(skeleton\)/);
  });

  it("accepts an explicit loopback --host", async () => {
    process.env[LOCAL_SERVER_AUTH_ENV] = "test-secret";
    await expect(serve("--host", "127.0.0.1")).rejects.toThrow(/not implemented yet \(skeleton\)/);
  });
});
