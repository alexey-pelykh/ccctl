// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { assertBearerNeverObserved, BearerLeakViolation } from "./bearer-canary.js";

const BEARER = "oauth-account-secret-canary-unit";

// Unit coverage of the pure canary verdict. The e2e suite feeds this same assertion
// logs + a snapshot collected from a REAL full session lifecycle; here we drive its
// clauses directly so the leak detection — the load-bearing regression tripwire — is
// verified on every `test` run, no live server required.
describe("assertBearerNeverObserved", () => {
  it("passes when the Bearer is in neither the logs nor the snapshot", () => {
    expect(() =>
      assertBearerNeverObserved({
        bearer: BEARER,
        logs: "session connecting\nwork item dispatched\n",
        snapshot: '[{"id":"env-1","maxSessions":4,"queue":[]}]',
      }),
    ).not.toThrow();
  });

  it("catches a Bearer leaked into a produced log line", () => {
    expect(() =>
      assertBearerNeverObserved({
        bearer: BEARER,
        logs: `inbound headers { authorization: 'Bearer ${BEARER}' }`,
        snapshot: "[]",
      }),
    ).toThrow(BearerLeakViolation);
    expect(() => assertBearerNeverObserved({ bearer: BEARER, logs: `...${BEARER}...`, snapshot: "[]" })).toThrow(
      /produced log line/,
    );
  });

  it("catches a Bearer captured into the persisted snapshot", () => {
    expect(() =>
      assertBearerNeverObserved({
        bearer: BEARER,
        logs: "",
        snapshot: `[{"id":"env-1","authorization":"${BEARER}"}]`,
      }),
    ).toThrow(BearerLeakViolation);
    expect(() => assertBearerNeverObserved({ bearer: BEARER, logs: "", snapshot: `{"leaked":"${BEARER}"}` })).toThrow(
      /persisted snapshot/,
    );
  });

  it("fails closed on a degenerate (empty) Bearer needle — not a vacuous pass", () => {
    expect(() => assertBearerNeverObserved({ bearer: "", logs: "", snapshot: "[]" })).toThrow(BearerLeakViolation);
    expect(() => assertBearerNeverObserved({ bearer: "", logs: "", snapshot: "[]" })).toThrow(/degenerate/);
  });

  it("tags its violation so callers can distinguish a boundary breach", () => {
    try {
      assertBearerNeverObserved({ bearer: BEARER, logs: BEARER, snapshot: "[]" });
      expect.unreachable("expected a violation");
    } catch (error) {
      expect(error).toBeInstanceOf(BearerLeakViolation);
      expect((error as BearerLeakViolation).name).toBe("BearerLeakViolation");
    }
  });
});
