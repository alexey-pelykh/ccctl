// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — device-list rendering logic (pure, DOM-free).
 *
 * The "devices" surface (#85): a management view of the operator's PAIRED DEVICES
 * (phone / tablet / laptop) — the client half of the per-device token model (#74 mints a
 * per-device token + pairing QR; #84 persists each device hashed, named, listable). Where
 * `sessions.js` owns the SESSION picker's row decisions, this module owns the DEVICE
 * list's: how a paired device reads as a one-line row (name + last-seen, AC1), and which
 * row is THIS device (so the current device is clearly indicated, AC2).
 *
 * `app.js` fetches `GET /api/devices` (on load + manual Refresh) and applies the result;
 * keeping the label / last-seen / current-device decisions here (DOM-free, its `now`
 * injected) makes them unit-testable without a browser, exactly as `sessions.js` is.
 *
 * The wire shape is MIRRORED here as a doc constant, deliberately NOT imported: this module
 * is served to the browser as-is (no bundler, no build), so it stays dependency-free vanilla
 * ESM. The mirrored contract (`GET /api/devices` → `{ devices }`):
 *
 *   DeviceSummaryWire = { id: string, name: string, lastSeen: number, current: boolean }
 *   id       — stable device identity (`PairedDevice.id`, #84); the row key, and the id a
 *              per-device revoke (W6-19, AC3) addresses via {@link deviceRevokePath}.
 *   name     — human device name ("Alex's phone", #84), shown in the row (AC1).
 *   lastSeen — epoch millis of the device's most recent activity (`PairedDevice.lastSeen`,
 *              #84), rendered relative by {@link formatLastSeen} (AC1).
 *   current  — whether THIS is the requesting device (AC2). SERVER-SET, not client-derivable:
 *              the client holds only its raw token (`pairing.js`), never a device id, and the
 *              store keeps only the token HASH — so only the server can hash a presented
 *              Bearer and match it to a device. That server-side verification is a later
 *              credentialed-wave item, so `current` rides the wire as a boolean the client
 *              READS (mirroring `sessions.js`'s server-set `autoResolvesPermissions`), and the
 *              marker lights up once the server sets it.
 *
 * Casing is camelCase per ADR-001: snake_case governs only the foreign-owned register wire;
 * ccctl's own browser API stays camelCase (as `/api/sessions` → `autoResolvesPermissions` does),
 * matching `@ccctl/core`'s `PairedDevice`.
 *
 * Server-side, `GET /api/devices` is not yet wired (#84 built the device STORE, not an HTTP
 * route) — the route, and the `current` computation it needs, land with the credentialed wave.
 * This slice ships the client surface against the mirrored contract, exactly as `pairing.js`
 * (#74) shipped token application ahead of server-side enforcement.
 */

/** The browser-facing device-list route this surface fetches (mirrors the server's `/api/devices`). */
export const DEVICES_PATH = "/api/devices";

/**
 * The browser-facing per-device REVOKE target (#81 / W6-19, AC3): `DELETE /api/devices/{id}` — the
 * {@link DEVICES_PATH} collection addressed by one device's stable `id` (the row key). DELETE (no
 * body — the id in the path is the whole request) is the idempotent verb for "this device is
 * gone": revoking an already-absent device succeeds, mirroring the server-side `revokeDevice`
 * transform's no-op-on-absent semantics. `id` is `encodeURIComponent`-escaped so a device id can
 * never break out of its path segment.
 *
 * Server-side this route is not yet wired — it lands with the credentialed wave alongside
 * `GET /api/devices` and the token verification a revoke enforces — so, exactly like the list
 * fetch, the client revoke rides ahead of server enforcement (the `pairing.js` / #85
 * walking-skeleton pattern). The at-rest token invalidation a revoke drives is the `revokeDevice`
 * primitive's story, not this path builder's.
 *
 * @param {string} id - a `PairedDevice.id` (a non-blank string, per {@link isRenderableDevice}).
 * @returns {string}
 */
export function deviceRevokePath(id) {
  return `${DEVICES_PATH}/${encodeURIComponent(id)}`;
}

/** Relative-band thresholds for {@link formatLastSeen} (epoch-millis math). */
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Render a device's `lastSeen` (epoch millis) as a short human RELATIVE string against `now` —
 * the "last-seen" half of a row (AC1): "just now" (< 1 min), "Nm ago" (< 1 hour), "Nh ago"
 * (< 1 day), else "Nd ago". `now` is injected (default `Date.now()`) so the mapping is
 * unit-testable without stubbing the clock.
 *
 * Defensive over an arbitrary decoded value: a non-finite / non-number `lastSeen` (missing
 * field, null, string, NaN, ±Infinity) reads as "unknown" rather than throwing or printing
 * "NaNm ago". A future timestamp (clock skew: `lastSeen` ahead of `now`) clamps to "just now",
 * never a negative "-2m ago".
 *
 * @param {unknown} lastSeen - epoch millis, or any decoded value.
 * @param {number} [now] - reference epoch millis; defaults to `Date.now()`.
 * @returns {string}
 */
export function formatLastSeen(lastSeen, now = Date.now()) {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) {
    return "unknown";
  }
  const elapsed = now - lastSeen;
  if (elapsed < MINUTE_MS) {
    // Also the future-timestamp case (negative elapsed): clamp to "just now", never "-2m ago".
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

/**
 * The human device name for a row (AC1) — `device.name` when it is a non-blank string, else a
 * `"(unnamed device)"` fallback so a partial / pre-name row still reads. Defensive: never
 * throws over a shapeless value.
 *
 * @param {{ name?: unknown }} device - a `DeviceSummaryWire`, or any value.
 * @returns {string}
 */
export function deviceName(device) {
  const name = device?.name;
  return typeof name === "string" && name.trim() !== "" ? name : "(unnamed device)";
}

/**
 * The one-line label a device reads as in the list: its {@link deviceName} and its
 * {@link formatLastSeen} last-seen — "Alex's phone · last seen 2m ago" (AC1). `now` injected
 * for testability.
 *
 * @param {{ name?: unknown, lastSeen?: unknown }} device - a `DeviceSummaryWire`, or any value.
 * @param {number} [now] - reference epoch millis; defaults to `Date.now()`.
 * @returns {string}
 */
export function deviceLabel(device, now = Date.now()) {
  return `${deviceName(device)} · last seen ${formatLastSeen(device?.lastSeen, now)}`;
}

/**
 * Whether a device row is THIS device — the server-set `current` marker the list indicates
 * clearly (AC2). Strict and defensive, exactly like `sessions.js`'s `autoResolvesPermissions`:
 * only a literal `true` marks current (a truthy non-boolean does not), and a missing / shapeless
 * value reads as not-current — so a partial row, or a pre-`current` wire (before the server
 * computes it), never spuriously flags a device as the current one, and this never throws.
 *
 * @param {{ current?: unknown }} device - a `DeviceSummaryWire`, or any value.
 * @returns {boolean}
 */
export function isCurrentDevice(device) {
  return device?.current === true;
}

/**
 * Whether a wire element can be rendered as a device row — it is an object carrying a usable
 * (non-blank string) `id`. The id is the row's key AND the target a per-device revoke (W6-19,
 * AC3) addresses, so an element without one is not a row: `app.js`'s `applyDeviceList` filters
 * these out rather than let a malformed element (a `null` slot, a partial object, a primitive)
 * throw on `element.id` or key a row `data-device-id="undefined"`. Strict + defensive, matching
 * this module's never-throws-on-any-value posture (a garbage element degrades to being dropped,
 * exactly as a garbage `lastSeen` degrades to "unknown").
 *
 * @param {{ id?: unknown }} device - a `DeviceSummaryWire`, or any value.
 * @returns {boolean}
 */
export function isRenderableDevice(device) {
  return typeof device?.id === "string" && device.id.trim() !== "";
}
