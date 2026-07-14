// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, it, expect } from "vitest";
import {
  DEVICES_PATH,
  formatLastSeen,
  deviceName,
  deviceLabel,
  isCurrentDevice,
  isRenderableDevice,
} from "./devices.js";

/** A fixed reference "now" so relative-time assertions are deterministic (2026-07-14T12:00:00Z). */
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

/** A `DeviceSummaryWire` fixture — the `GET /api/devices` row shape; a non-current device by default. */
function device({ id = "dev-1", name = "Alex's phone", lastSeen = NOW, current = false } = {}) {
  return { id, name, lastSeen, current };
}

describe("DEVICES_PATH", () => {
  it("mirrors the server's browser-facing device-list route", () => {
    expect(DEVICES_PATH).toBe("/api/devices");
  });
});

describe("formatLastSeen", () => {
  it("reads under a minute as 'just now'", () => {
    expect(formatLastSeen(NOW, NOW)).toBe("just now");
    expect(formatLastSeen(NOW - 1000, NOW)).toBe("just now");
    // 59s ago is still the sub-minute band.
    expect(formatLastSeen(NOW - 59_000, NOW)).toBe("just now");
  });

  it("reads the minute band as 'Nm ago', flooring, from exactly one minute", () => {
    expect(formatLastSeen(NOW - 60_000, NOW)).toBe("1m ago");
    // Floors: 2m59s reads as 2m.
    expect(formatLastSeen(NOW - (2 * 60_000 + 59_000), NOW)).toBe("2m ago");
    // 59m59s is the last minute-band value before the hour rolls over.
    expect(formatLastSeen(NOW - (59 * 60_000 + 59_000), NOW)).toBe("59m ago");
  });

  it("reads the hour band as 'Nh ago', flooring, from exactly one hour", () => {
    expect(formatLastSeen(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(formatLastSeen(NOW - (5 * 60 + 30) * 60_000, NOW)).toBe("5h ago");
    // 23h59m is the last hour-band value before the day rolls over.
    expect(formatLastSeen(NOW - (23 * 60 + 59) * 60_000, NOW)).toBe("23h ago");
  });

  it("reads a day or more as 'Nd ago', flooring, from exactly one day", () => {
    expect(formatLastSeen(NOW - 24 * 60 * 60_000, NOW)).toBe("1d ago");
    expect(formatLastSeen(NOW - 9 * 24 * 60 * 60_000, NOW)).toBe("9d ago");
  });

  it("clamps a future timestamp (clock skew) to 'just now', never a negative age", () => {
    expect(formatLastSeen(NOW + 5 * 60_000, NOW)).toBe("just now");
  });

  it("reads a missing / shapeless / non-finite lastSeen as 'unknown', never throwing or 'NaNm ago'", () => {
    expect(formatLastSeen(undefined, NOW)).toBe("unknown");
    expect(formatLastSeen(null, NOW)).toBe("unknown");
    expect(formatLastSeen("1752494400000", NOW)).toBe("unknown");
    expect(formatLastSeen(NaN, NOW)).toBe("unknown");
    expect(formatLastSeen(Infinity, NOW)).toBe("unknown");
    expect(formatLastSeen(-Infinity, NOW)).toBe("unknown");
  });

  it("defaults `now` to the real clock — a fresh timestamp reads as 'just now'", () => {
    // No injected `now`: exercises the Date.now() default without pinning the wall clock.
    expect(formatLastSeen(Date.now())).toBe("just now");
  });
});

describe("deviceName", () => {
  it("uses a non-blank name verbatim", () => {
    expect(deviceName(device({ name: "Alex's phone" }))).toBe("Alex's phone");
  });

  it("falls back to '(unnamed device)' for a blank / missing / shapeless name, never throwing", () => {
    expect(deviceName(device({ name: "" }))).toBe("(unnamed device)");
    expect(deviceName(device({ name: "   " }))).toBe("(unnamed device)");
    expect(deviceName({ id: "d" })).toBe("(unnamed device)");
    expect(deviceName({ id: "d", name: 42 })).toBe("(unnamed device)");
    expect(deviceName(undefined)).toBe("(unnamed device)");
    expect(deviceName(null)).toBe("(unnamed device)");
  });
});

describe("deviceLabel", () => {
  it("reads a row as name plus relative last-seen (AC1)", () => {
    expect(deviceLabel(device({ name: "Alex's phone", lastSeen: NOW - 2 * 60_000 }), NOW)).toBe(
      "Alex's phone · last seen 2m ago",
    );
    expect(deviceLabel(device({ name: "Work laptop", lastSeen: NOW }), NOW)).toBe("Work laptop · last seen just now");
  });

  it("composes both fallbacks for a partial row without throwing", () => {
    expect(deviceLabel({ id: "d" }, NOW)).toBe("(unnamed device) · last seen unknown");
  });
});

describe("isCurrentDevice", () => {
  it("marks current only on a literal true — the server-set AC2 marker", () => {
    expect(isCurrentDevice(device({ current: true }))).toBe(true);
    expect(isCurrentDevice(device({ current: false }))).toBe(false);
  });

  it("reads a missing / non-boolean marker as not-current, so a partial or pre-`current` row never spuriously flags", () => {
    expect(isCurrentDevice({ id: "d" })).toBe(false);
    // Strictly boolean: a truthy non-boolean must not mark the current device.
    expect(isCurrentDevice({ id: "d", current: "true" })).toBe(false);
    expect(isCurrentDevice({ id: "d", current: 1 })).toBe(false);
    expect(isCurrentDevice(undefined)).toBe(false);
    expect(isCurrentDevice(null)).toBe(false);
  });
});

describe("isRenderableDevice", () => {
  it("accepts a device carrying a usable string id (the row key + revoke target)", () => {
    expect(isRenderableDevice(device({ id: "dev-1" }))).toBe(true);
  });

  it("rejects a missing / blank / non-string id and any shapeless element, so a malformed wire slot is dropped, not thrown on", () => {
    expect(isRenderableDevice(device({ id: "" }))).toBe(false);
    expect(isRenderableDevice(device({ id: "   " }))).toBe(false);
    expect(isRenderableDevice({ name: "no id" })).toBe(false);
    expect(isRenderableDevice({ id: 42 })).toBe(false);
    expect(isRenderableDevice(null)).toBe(false);
    expect(isRenderableDevice(undefined)).toBe(false);
    expect(isRenderableDevice("dev-1")).toBe(false);
  });
});
