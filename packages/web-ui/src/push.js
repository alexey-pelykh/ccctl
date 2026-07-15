// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — Web-Push subscription + notification logic (pure, DOM-free).
 *
 * The client half of the W5 push ladder (#43→#50 built the server side): the PWA subscribes a
 * DEVICE to Web-Push (VAPID) so the operator is WOKEN when a session blocks on them while the
 * app is backgrounded / closed (#51). Where `pairing.js` owns the token-application decisions
 * and `devices.js` the device-row decisions, this module owns the push decisions: the
 * VAPID-key → `applicationServerKey` conversion, the browser `PushSubscription` → server
 * contract shaping, and the always-visible notification content the service worker renders.
 *
 * `app.js` (the thin shell) registers `sw.js`, requests notification permission, and calls
 * `PushManager.subscribe` with these decisions; keeping the decisions here (DOM-free, no
 * `window` / `ServiceWorkerRegistration` touched) makes them unit-testable without a browser,
 * exactly as the other modules are. `sw.js` — a classic service worker that cannot `import`
 * this ES module (no bundler) — MIRRORS {@link notificationContent}'s few-line decision inline,
 * the same "mirrored, not imported" tradeoff the whole package makes for the core wire shapes.
 *
 * Two wire shapes are MIRRORED here as doc constants, deliberately NOT imported (this module is
 * served to the browser as-is, so it stays dependency-free vanilla ESM):
 *
 *   1. The SERVER SUBSCRIPTION the wake dispatch consumes (#50 `WebPushSubscription`, mirrored
 *      from `@ccctl/server`) — the standard browser `PushSubscription.toJSON()` shape:
 *
 *        WebPushSubscription = { endpoint: string, keys: { p256dh: string, auth: string } }
 *        endpoint — the push-service URL the encrypted wake is POSTed to.
 *        p256dh   — the client's P-256 public key (base64url), an RFC 8291 encryption input.
 *        auth     — the client's auth secret (base64url), an RFC 8291 encryption input.
 *
 *      {@link toServerSubscription} produces EXACTLY this shape — it is the AC3 contract: the
 *      subscription the UI uploads is the one `dispatchWake` (#50) sends to. `expirationTime`
 *      (present on `PushSubscription.toJSON()`) is DROPPED — the server contract has no such
 *      field, and a wake is addressed by `endpoint`, not by expiry.
 *
 *   2. The pointer-only PUSH PAYLOAD the wake carries (#45 `PushPayload`, mirrored from
 *      `@ccctl/server`) — the DECRYPTED body the service worker's `push` handler receives:
 *
 *        PushPayload = { session_id: string, text: "A session needs your input",
 *                        notification_class: "blocking" }
 *
 *      Content-free by the #45 firewall: `session_id` is an OPAQUE pointer (a bare UUID, no
 *      content), `text` is a generic compile-time line, and there is NO `detail` / transcript
 *      field — what a session is actually saying is fetched over the tunnel on tap (#52).
 *      {@link notificationContent} reads ONLY `text` + `session_id`, so — like the server's own
 *      builders — session content structurally cannot reach the notification a push renders.
 *
 * The subscription-upload route and the VAPID-public-key route are the browser-facing contract
 * this surface presents; server-side handling of them is a later slice (#50 shipped the wake
 * DISPATCH + VAPID handling but explicitly left "the PWA subscription is #51" as its wiring
 * point — there is no subscription STORE or HTTP route yet). This slice ships the client surface
 * against that mirrored contract, exactly as `pairing.js` (#74) applied a token and `devices.js`
 * (#85) rendered a list ahead of server-side enforcement.
 */

/** The browser-facing route the UI GETs the server's VAPID PUBLIC key from (`{ publicKey }`). */
export const PUSH_VAPID_PUBLIC_KEY_PATH = "/api/push/vapid-public-key";

/** The browser-facing route the UI POSTs its {@link toServerSubscription} to (mirror-ahead of #50's store). */
export const PUSH_SUBSCRIPTION_PATH = "/api/push/subscription";

/** The notification title every wake renders under — a constant, never worker-supplied (the #45 firewall). */
export const PUSH_NOTIFICATION_TITLE = "ccctl";

/**
 * The generic notification body a wake falls back to — mirrors `@ccctl/server`'s `PUSH_WAKE_TEXT`
 * (#45). Says nothing about WHICH session or WHAT it awaits; it is the content-free line a push may
 * carry, and the fallback when a wake body is absent / shapeless. Never a session's `detail`.
 */
export const PUSH_WAKE_TEXT = "A session needs your input";

/**
 * Convert a base64url VAPID PUBLIC key (the string the server publishes) into the `Uint8Array`
 * `PushManager.subscribe` wants as its `applicationServerKey` (RFC 8292). The canonical Web-Push
 * helper: pad to a base64 multiple of 4, map the URL-safe alphabet (`-`→`+`, `_`→`/`) back to
 * standard base64, then decode. A valid VAPID public key decodes to the 65-byte uncompressed
 * P-256 point (`0x04 || X || Y`) the server's `VAPID_PUBLIC_KEY_BYTES` fixes.
 *
 * FAIL-CLOSED on a non-string / blank key (the same stance the server's `validateVapidKeys` takes):
 * an unusable key must surface here, not be silently turned into a garbage `applicationServerKey`
 * that makes `subscribe` reject opaquely. `app.js` only calls this with a key
 * {@link vapidPublicKeyFromResponse} already vetted as a non-blank string.
 *
 * @param {string} base64Url - the server's VAPID public key, base64url-encoded.
 * @returns {Uint8Array}
 * @throws {Error} when `base64Url` is not a non-blank string.
 */
export function urlBase64ToUint8Array(base64Url) {
  if (typeof base64Url !== "string" || base64Url.trim() === "") {
    throw new Error("ccctl: VAPID public key must be a non-empty base64url string");
  }
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * The `PushManager.subscribe` options a wake subscription is made with. TWO decisions live here,
 * both AC-load-bearing:
 *   - `userVisibleOnly: true` — ALWAYS. This is the "no silent push" contract at subscribe time
 *     (AC2): the browser is promised every push shows a notification, and iOS ENFORCES it —
 *     an installed PWA that receives a push and shows nothing has its subscription revoked. It
 *     pairs with the service worker always calling `showNotification` (the render half of the
 *     same promise). There is no silent-push mode offered, by construction.
 *   - `applicationServerKey` — the VAPID identity the subscription is bound to (#50), so the push
 *     service accepts wakes signed by this server and rejects any other sender.
 *
 * @param {Uint8Array} applicationServerKey - from {@link urlBase64ToUint8Array}.
 * @returns {{ userVisibleOnly: true, applicationServerKey: Uint8Array }}
 */
export function pushSubscribeOptions(applicationServerKey) {
  return { userVisibleOnly: true, applicationServerKey };
}

/**
 * Extract the server's VAPID public key from a `GET /api/push/vapid-public-key` body
 * (`{ publicKey: string }`), or `null` when the body is absent / shapeless / the key is blank.
 * Defensive, exactly like `devices.js`'s decoders: the operator's phone reaches the server across
 * a tunnel that can interpose an error page, so a body is never assumed to parse to the contract —
 * and until the server wires this route, the fetch simply yields no key and `app.js` surfaces an
 * honest "push unavailable" rather than throwing.
 *
 * @param {{ publicKey?: unknown }} payload - the decoded response body, or any value.
 * @returns {string | null}
 */
export function vapidPublicKeyFromResponse(payload) {
  const key = payload?.publicKey;
  return typeof key === "string" && key.trim() !== "" ? key : null;
}

/**
 * Shape a browser `PushSubscription` (its `.toJSON()` form, or the live object — both carry
 * `endpoint` + `keys.{p256dh,auth}`) into the `WebPushSubscription` the server's wake
 * dispatch consumes (#50) — the AC3 contract: `{ endpoint, keys: { p256dh, auth } }`, and nothing
 * else (`expirationTime` is dropped; the server has no such field). Returns `null` when the
 * subscription is missing any of the three required strings, so `app.js` never uploads a
 * malformed subscription a wake could not be sent to — the defensive posture the whole module
 * shares. The result is a fresh object (no aliasing of the browser's subscription).
 *
 * @param {{ endpoint?: unknown, keys?: { p256dh?: unknown, auth?: unknown } }} subscription
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string } } | null}
 */
export function toServerSubscription(subscription) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    endpoint.trim() === "" ||
    typeof p256dh !== "string" ||
    p256dh.trim() === "" ||
    typeof auth !== "string" ||
    auth.trim() === ""
  ) {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * The notification a wake renders — title, body, coalescing tag, and tap data — derived from the
 * DECRYPTED push body (a #45 `PushPayload`, or `null` / any value when the body is absent or
 * unparseable). This is the RENDER half of the "no silent push" contract (AC2): it ALWAYS returns
 * a full, renderable notification — a non-empty title and body — for ANY input, so the service
 * worker's `push` handler always has something to show and never falls through to a silent push
 * (which iOS would punish by revoking the subscription). `sw.js` mirrors this inline.
 *
 * The #45 firewall holds here by construction: only `text` (the generic line) and `session_id`
 * (the opaque pointer) are ever read — never a `detail` / transcript field — so session content
 * cannot reach a rendered notification even if a body carried it. `text` falls back to the generic
 * {@link PUSH_WAKE_TEXT} when absent.
 *
 * The `tag` coalesces repeated wakes for ONE session into a single tray entry (aligned with the
 * server's #46 collapse `Topic`), so a re-nudge (#48) replaces rather than stacks; a wake with no
 * usable pointer falls back to one shared tag. `data.session_id` carries the opaque pointer for the
 * tap → deep-link resolve (#52), or is absent when there is no pointer.
 *
 * @param {{ text?: unknown, session_id?: unknown } | null | undefined} payload
 * @returns {{ title: string, body: string, tag: string, data: { session_id?: string } }}
 */
export function notificationContent(payload) {
  const text = payload?.text;
  const body = typeof text === "string" && text.trim() !== "" ? text : PUSH_WAKE_TEXT;
  const sessionId = payload?.session_id;
  const hasSession = typeof sessionId === "string" && sessionId.trim() !== "";
  return {
    title: PUSH_NOTIFICATION_TITLE,
    body,
    tag: hasSession ? `ccctl-session-${sessionId}` : "ccctl-wake",
    data: hasSession ? { session_id: sessionId } : {},
  };
}

/**
 * The query parameter a session deep-link pins its target session under (`?session=<id>`) — the
 * tap→deep-link half of the push ladder (#52). A QUERY, not a fragment: unlike the pairing token
 * (`pairing.js`, which rides `#…` so the SECRET never reaches the server), a session id is an opaque,
 * non-secret pointer (the #45 firewall — a bare UUID, no content), so it can ride the query the app
 * shell reads on cold-open without leaking anything a session is saying.
 */
export const DEEP_LINK_SESSION_PARAM = "session";

/**
 * The message type the service worker posts to an ALREADY-open client to steer it to a tapped
 * session's view (#52). A tap that finds a live window cannot cold-open a URL against it, so `sw.js`
 * instead `postMessage`s this — `{ type: NAVIGATE_MESSAGE_TYPE, session_id }` — and the shell switches
 * the viewed session in place. Namespaced (`ccctl:`) so it never collides with another `message` a
 * page might receive. `sw.js` MIRRORS the literal inline (it cannot `import` this ES module).
 */
export const NAVIGATE_MESSAGE_TYPE = "ccctl:navigate";

/**
 * Build the in-app deep-link a tapped wake opens (#52): the app ROOT with the target session pinned as
 * a `?session=<id>` query the shell reads on load. Relative (`./`) so it resolves against the PWA scope
 * (`manifest.webmanifest` `start_url`/`scope` are `.`; the worker is root-scoped), whether the tap
 * cold-opens a fresh window or the app is installed to the home screen. The id is `encodeURIComponent`d
 * so a non-UUID pointer can never break the query (server ids are UUIDs, for which this is a no-op — but
 * the notification's `data.session_id` is opaque here, so it is escaped defensively).
 *
 * FALLS BACK to the bare app root (`./`) for a blank / non-string id, so a wake with no usable pointer
 * (an empty or shapeless push) still brings the operator to the app rather than yielding no URL to open.
 * `sw.js` mirrors this few-line decision inline; `push.test.js` is its tested authority.
 *
 * @param {unknown} sessionId - the opaque #45 pointer off the notification, or any value.
 * @returns {string}
 */
export function sessionDeepLinkUrl(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return "./";
  }
  return `./?${DEEP_LINK_SESSION_PARAM}=${encodeURIComponent(sessionId)}`;
}

/**
 * Extract the deep-linked session id from a URL query string (`?session=<id>`), or `null` when the
 * query is absent, carries a different parameter, or the id is blank. The inverse of
 * {@link sessionDeepLinkUrl}: `URLSearchParams` URL-decodes the value, undoing its `encodeURIComponent`.
 * Defensive over a non-string exactly like `pairing.js`'s `tokenFromHash` — `app.js` passes
 * `location.search`, but the module never assumes the shape.
 *
 * @param {unknown} search - a URL query string (with or without the leading `?`), or any value.
 * @returns {string | null}
 */
export function deepLinkSessionId(search) {
  if (typeof search !== "string") {
    return null;
  }
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const id = new URLSearchParams(raw).get(DEEP_LINK_SESSION_PARAM);
  return id !== null && id.trim() !== "" ? id : null;
}

/**
 * Consume a session deep-link (#52): read the target session out of the URL query and, when present,
 * STRIP just the `?session=` parameter from the URL (via `history.replaceState`, preserving the path,
 * any OTHER query parameters, and the fragment) so a reload does not re-pin a session that may since
 * have closed, then return the id. Returns `null` — touching nothing — when there is no deep-link.
 *
 * The session-flavoured sibling of `pairing.js`'s `applyPairingToken`: same read-then-scrub shape with
 * its I/O (`location` / `history`) injected so it is unit-testable without a browser, but scrubbing for
 * hygiene / one-shot-intent rather than secrecy (the id is not a secret — see {@link DEEP_LINK_SESSION_PARAM}).
 * `app.js` calls this once on load, BEFORE the first session poll, and selects the returned id — so the
 * deep-link wins over the picker's auto-select-first rule (a set selection reads as `keep`, not replace).
 *
 * @param {{ location: { search: string, pathname: string, hash: string }, history: Pick<History, "replaceState"> }} deps
 * @returns {string | null}
 */
export function consumeDeepLinkSessionId({ location, history }) {
  const id = deepLinkSessionId(location.search);
  if (id === null) {
    return null;
  }
  const raw = location.search.startsWith("?") ? location.search.slice(1) : location.search;
  const params = new URLSearchParams(raw);
  params.delete(DEEP_LINK_SESSION_PARAM);
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`);
  return id;
}

/**
 * The session id a service-worker→client navigate message carries (#52), or `null` when the value is
 * not a well-formed navigate (wrong / missing `type`, or a blank / non-string `session_id`). `app.js`
 * calls this on EVERY `navigator.serviceWorker` message, so it is the guard that only a genuine
 * {@link NAVIGATE_MESSAGE_TYPE} message — never some other page `message` — steers the viewed session.
 *
 * @param {unknown} message - the `MessageEvent.data`, or any value.
 * @returns {string | null}
 */
export function navigateMessageSessionId(message) {
  // `message?.type` reads through a null / non-object value to `undefined` (never throws), the same
  // optional-chaining decode the sibling object-readers use (`toServerSubscription`, `notificationContent`);
  // a wrong / missing type — or any shapeless message — falls here.
  if (message?.type !== NAVIGATE_MESSAGE_TYPE) {
    return null;
  }
  const sessionId = message.session_id;
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : null;
}
