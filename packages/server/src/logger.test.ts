// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it, vi } from "vitest";
import type { LogEvent, LogLevel } from "@ccctl/core";
import { createJsonLineLogger } from "./logger.js";

const sessionEvent: LogEvent = {
  category: "session",
  level: "info",
  event: "closed",
  sessionId: "sess-1",
  status: "closed",
  detail: "session ended (closed)",
};

describe("createJsonLineLogger", () => {
  // Rule: one event becomes one JSON line, handed to the injected writer with its level — so the
  // daemon's trail is machine-parseable and testable/redirectable.
  it("serializes an event to one JSON line and routes it with its level", () => {
    const written: Array<{ line: string; level: LogLevel }> = [];
    const logger = createJsonLineLogger((line, level) => written.push({ line, level }));

    logger.log(sessionEvent);

    expect(written).toHaveLength(1);
    expect(written[0]?.level).toBe("info");
    expect(JSON.parse(written[0]?.line ?? "")).toEqual(sessionEvent);
  });

  it("routes each level to the matching console method by default (error/warn → stderr, else stdout)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const logger = createJsonLineLogger();

      logger.log({ ...sessionEvent, level: "info" });
      logger.log({ category: "error", level: "warn", event: "launch-failed", sessionId: null, detail: "at-capacity" });
      logger.log({ category: "error", level: "error", event: "bind-refused", sessionId: null, detail: "non-loopback" });

      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      // The stdout line is the serialized info event, not prose.
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ category: "session", level: "info" });
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("emits exactly one line per event — no batching, no dropped events", () => {
    const lines: string[] = [];
    const logger = createJsonLineLogger((line) => lines.push(line));

    logger.log(sessionEvent);
    logger.log(sessionEvent);
    logger.log(sessionEvent);

    expect(lines).toHaveLength(3);
  });
});
