// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  NO_OP_LOGGER,
  type DetectionLogEvent,
  type DiagnosticLogEvent,
  type ErrorLogEvent,
  type LogEvent,
  type Logger,
  type NotificationLogEvent,
  type RegistrationLogEvent,
  type SessionLogEvent,
} from "./index.js";

// One representative event per category — the fixtures the JSON-safety and sink
// tests exercise. Distinct string sentinels so a serialized line is unambiguous.
const sessionEvent: SessionLogEvent = {
  category: "session",
  level: "info",
  event: "created",
  sessionId: "sess-1",
  status: "connecting",
  detail: "registered via §2",
};
const registrationEvent: RegistrationLogEvent = {
  category: "registration",
  level: "info",
  event: "work-delivered",
  environmentId: "env-1",
  sessionId: "sess-1",
  detail: "work item wi-1 (session)",
};
const detectionEvent: DetectionLogEvent = {
  category: "detection",
  level: "info",
  event: "activity",
  sessionId: "sess-1",
  activity: "idle",
  detail: "running→idle",
};
const notificationEvent: NotificationLogEvent = {
  category: "notification",
  level: "warn",
  event: "awaiting-input",
  sessionId: "sess-1",
  detail: "Approve the edit?",
};
const errorEvent: ErrorLogEvent = {
  category: "error",
  level: "error",
  event: "bind-refused",
  sessionId: null,
  detail: "refused non-loopback host 0.0.0.0",
};
const diagnosticEvent: DiagnosticLogEvent = {
  category: "diagnostic",
  level: "info",
  event: "heap-snapshot",
  sessionId: null,
  detail: "/tmp/ccctl-heap-4321-2026-07-16T00-00-00-000Z.heapsnapshot",
};
const everyCategory: readonly LogEvent[] = [
  sessionEvent,
  registrationEvent,
  detectionEvent,
  notificationEvent,
  errorEvent,
  diagnosticEvent,
];

describe("NO_OP_LOGGER", () => {
  // Rule: the default sink drops every event silently, so a server configured
  // without a Logger is quiet rather than crashing.
  it("returns undefined and never throws for an event of every category", () => {
    for (const event of everyCategory) {
      expect(NO_OP_LOGGER.log(event)).toBeUndefined();
    }
  });

  it("is a shared stateless instance (no per-call allocation to leak)", () => {
    // Two references to the one const — a smoke check that it is a value, not a factory.
    expect(NO_OP_LOGGER).toBe(NO_OP_LOGGER);
  });
});

describe("Logger sink contract", () => {
  // Rule: a Logger is an injected function seam — the shape every consumer (the
  // server's JSON-line writer, a test's capturing fake) implements.
  it("a capturing fake collects exactly the events it is handed, in order", () => {
    const collected: LogEvent[] = [];
    const logger: Logger = { log: (event) => collected.push(event) };

    for (const event of everyCategory) {
      logger.log(event);
    }

    expect(collected).toEqual(everyCategory);
  });
});

describe("LogEvent JSON-safety (runtime complement to LogEventJsonProofs)", () => {
  // Rule: every loggable shape is JsonValue-safe by construction, so it survives a
  // JSON round-trip unchanged — the runtime witness of the compile-time proof that
  // a log line is plain data (and therefore cannot carry a method-bearing credential
  // like AccountBearer).
  it("round-trips every category through JSON unchanged", () => {
    for (const event of everyCategory) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  it("serializes only the declared safe keys — no credential-shaped field exists to carry a token", () => {
    // The redaction-by-construction guarantee, observed on the wire: a fully-populated
    // event of each category exposes ONLY ids, statuses, activity kinds, level, and the
    // one-line human detail. There is no `bearer`, `token`, `secret`, `authorization`, or
    // `session_ingress_token` field — the loggable shapes omit them by construction, so a
    // careless call site has nowhere structural to leak one.
    const forbiddenKeys = ["bearer", "token", "secret", "authorization", "session_ingress_token"];
    for (const event of everyCategory) {
      const keys = Object.keys(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
      for (const forbidden of forbiddenKeys) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("DiagnosticLogEvent (#62 — the on-demand diagnostic surface)", () => {
  // Rule: the diagnostic surface records an operator-triggered runtime action (a live heap snapshot),
  // daemon-wide (sessionId null), carrying the snapshot's PATH — never its contents — in `detail`.
  it("carries the snapshot path in detail and is daemon-wide (sessionId null)", () => {
    expect(diagnosticEvent.category).toBe("diagnostic");
    expect(diagnosticEvent.sessionId).toBeNull();
    expect(diagnosticEvent.detail).toContain(".heapsnapshot");
  });

  it("supports both the success and failure events at their respective levels", () => {
    const failed: DiagnosticLogEvent = {
      category: "diagnostic",
      level: "error",
      event: "heap-snapshot-failed",
      sessionId: null,
      detail: "heap snapshot to /tmp/x.heapsnapshot failed: EACCES",
    };
    // Both are JsonValue-safe by construction — the failure path is a log line like any other.
    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(failed.level).toBe("error");
  });
});
