// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — QR-pair token application logic (pure, DOM-free).
 *
 * The client half of QR-pair onboarding (#74): the server minted a per-device token,
 * encoded it — with the tunnel origin — into a URL, and printed that URL as a terminal
 * QR. Scanning it opens the PWA at `…/#ccctl_token=<token>`. This module APPLIES that
 * scanned token so the UI is authenticated with no manual copy/paste:
 *
 *   1. read the token out of the URL fragment (`location.hash`),
 *   2. persist it (so the device stays paired across reloads / relaunches),
 *   3. STRIP it from the URL, so the secret does not linger in the address bar, the
 *      browser history, or a shared screenshot,
 *   4. surface it as an `Authorization: Bearer …` header for the UI's API requests.
 *
 * Keeping the parse/store/strip logic here (DOM-free, its I/O — `location` / `history` /
 * `storage` — injected) makes it unit-testable without a browser, exactly as the
 * decode/encode modules are; `app.js` stays the thin shell that calls it with the real
 * `window` objects and spreads the header onto its `fetch`es.
 *
 * The token rides the URL FRAGMENT, never a query — a fragment is stripped by the browser
 * before a request is sent, so the token never reaches the server in the request line and
 * never lands in an access log. `PAIRING_TOKEN_PARAM` MIRRORS `@ccctl/core`'s constant,
 * deliberately NOT imported (this module is served to the browser as-is, no bundler), so
 * it stays dependency-free vanilla ESM.
 *
 * Server-side VERIFICATION of the applied token is a later credentialed-wave item; this
 * slice applies the token client-side so it is already presented once enforcement lands.
 */

/** Fragment parameter the pairing URL carries the device token in (mirrors `@ccctl/core`'s `PAIRING_TOKEN_PARAM`). */
export const PAIRING_TOKEN_PARAM = "ccctl_token";

/** `Storage` key the applied device token is persisted under. */
export const PAIRING_TOKEN_STORAGE_KEY = "ccctl.deviceToken";

/**
 * Extract the device token from a URL fragment (`#ccctl_token=<token>`), or `null` when
 * the fragment is absent, carries a different parameter, or the token is blank.
 * `URLSearchParams` URL-decodes the value — the inverse of the `encodeURIComponent` the
 * builder applied.
 *
 * @param {unknown} hash
 * @returns {string | null}
 */
export function tokenFromHash(hash) {
  if (typeof hash !== "string") {
    return null;
  }
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get(PAIRING_TOKEN_PARAM);
  return token !== null && token.trim() !== "" ? token : null;
}

/**
 * The persisted device token, or `null` when none is stored (or it is blank).
 *
 * @param {Pick<Storage, "getItem">} storage
 * @returns {string | null}
 */
export function storedToken(storage) {
  const token = storage.getItem(PAIRING_TOKEN_STORAGE_KEY);
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/**
 * Apply a scanned pairing token. When the URL fragment carries a fresh token, persist it
 * and STRIP the fragment from the URL (via `history.replaceState`) so the secret does not
 * linger in the address bar / history / a screenshot, then return it. When the fragment
 * carries none, fall back to a previously-stored token (a returning paired device), or
 * `null` when the device has never been paired.
 *
 * @param {{ location: { hash: string, pathname: string, search: string }, history: Pick<History, "replaceState">, storage: Pick<Storage, "getItem" | "setItem"> }} deps
 * @returns {string | null}
 */
export function applyPairingToken({ location, history, storage }) {
  const fresh = tokenFromHash(location.hash);
  if (fresh === null) {
    return storedToken(storage);
  }
  storage.setItem(PAIRING_TOKEN_STORAGE_KEY, fresh);
  // Drop the fragment: replace the current entry with the same path minus the `#…token`,
  // so a reload / back-button / screenshot never re-exposes the secret.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return fresh;
}

/**
 * The `Authorization` header the UI's API requests present the stored device token with —
 * `{ Authorization: "Bearer <token>" }`, or an empty object when the device is not paired,
 * so it spreads cleanly onto a `fetch` `headers` either way.
 *
 * @param {Pick<Storage, "getItem">} storage
 * @returns {{ Authorization: string } | {}}
 */
export function authHeader(storage) {
  const token = storedToken(storage);
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}
