// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The concrete structured-log sink (#61) — the Node-adjacent OUTPUT half of the
 * {@link Logger} contract `@ccctl/core` defines. Core stays runtime-agnostic and
 * ships only the event SHAPES, the interface, and {@link NO_OP_LOGGER}; the writer
 * that actually puts a line somewhere is here, exactly as the file session store is
 * the Node half of `ISessionStore`.
 *
 * One event becomes one JSON line — `JSON.stringify(event)` — so the daemon's trail
 * is machine-parseable (`… | jq`) rather than prose. Because a {@link LogEvent} is
 * {@link JsonValue}-safe by construction (`@ccctl/core` proves it), that line can carry
 * no account {@link AccountBearer} and no {@link SessionIngressToken}: redaction is a
 * property of the SHAPE, not of this writer, so this module needs no scrubbing pass —
 * it just serializes what it is handed.
 *
 * Level routes to the matching `console` method: `error` → `console.error` (stderr),
 * `warn` → `console.warn` (stderr), everything else → `console.log` (stdout). The write
 * itself is an INJECTED seam ({@link LogLineWriter}) defaulting to `console` — a test
 * passes a capturing fake, an embedder can redirect to a file or a collector, and the
 * e2e bearer canary observes the real `console` output to prove no credential leaks.
 */

import type { Logger, LogEvent, LogLevel } from "@ccctl/core";

/**
 * Where one serialized log line goes, given its {@link LogLevel}. The injected seam that makes
 * {@link createJsonLineLogger} testable and redirectable — the default routes to `console`, a test
 * passes a fake that collects lines.
 */
export type LogLineWriter = (line: string, level: LogLevel) => void;

/** The default writer: route by level to the matching `console` method (error/warn → stderr, else stdout). */
const consoleWriter: LogLineWriter = (line, level) => {
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

/**
 * Build a {@link Logger} that serializes each {@link LogEvent} to one JSON line and routes it by level
 * through `write` (default: `console`). The daemon injects one of these into {@link startServer} via
 * {@link ServerConfig.logger} to turn the diagnostic trail on; absent, the server falls back to
 * {@link NO_OP_LOGGER} and stays quiet.
 */
export function createJsonLineLogger(write: LogLineWriter = consoleWriter): Logger {
  return {
    log(event: LogEvent): void {
      write(JSON.stringify(event), event.level);
    },
  };
}
