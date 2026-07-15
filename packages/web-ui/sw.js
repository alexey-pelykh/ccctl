// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — service worker (#51).
 *
 * The PWA's background half: it makes the UI installable (a registered worker with a fetch handler)
 * and it RENDERS every push wake as a visible notification. Served from the package ROOT (not `src/`)
 * so its scope is the whole app (`/`) — a worker under `/src/` would only control `/src/`, and
 * broadening scope needs a `Service-Worker-Allowed` response header the static host does not set.
 *
 * A CLASSIC worker (not a module), deliberately: iOS 16.4+ — the first iOS with Web-Push, and only
 * for an INSTALLED PWA, which is exactly this feature's target — is the least certain ground for
 * `{ type: "module" }` workers, and the notification-rendering path is the one that must not regress
 * there. Being classic, it cannot `import` the ES module `src/push.js`; the `push` handler MIRRORS
 * `push.js` § notificationContent inline (the same "mirrored, not imported" tradeoff the whole
 * package makes for the core wire shapes), and `push.test.js` is the tested authority for that logic.
 */

// Take over an updated worker immediately — no need to wait for every tab to close before the new
// push/notification logic is live.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No offline shell cache at MVP — let the network serve every request. This handler exists so the
// PWA meets the installability heuristic (a registered worker WITH a fetch handler); a real
// offline/precache strategy is a later slice, deliberately not built here.
self.addEventListener("fetch", () => {});

// The RENDER half of the "no silent push" contract (AC2). ALWAYS show a visible notification, for
// ANY payload — a decoded body, an empty push, or an unparseable one — because an installed iOS PWA
// that receives a push and shows nothing has its subscription REVOKED. Mirrors push.js
// § notificationContent: only the generic `text` and the opaque `session_id` pointer are read, never
// session content (#45 firewall); the `tag` coalesces repeated wakes for one session (aligned with
// the server's #46 collapse Topic); `data.session_id` carries the pointer for the tap → deep-link
// resolve (#52).
self.addEventListener("push", (event) => {
  let payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = null;
    }
  }
  const text =
    payload && typeof payload.text === "string" && payload.text.trim() !== ""
      ? payload.text
      : "A session needs your input";
  const sessionId =
    payload && typeof payload.session_id === "string" && payload.session_id.trim() !== "" ? payload.session_id : null;
  event.waitUntil(
    self.registration.showNotification("ccctl", {
      body: text,
      tag: sessionId ? `ccctl-session-${sessionId}` : "ccctl-wake",
      data: sessionId ? { session_id: sessionId } : {},
    }),
  );
});

// Tapping a wake brings the operator back to the UI to attend the waiting session. The session
// deep-link (#52) is a later slice; for now focus an already-open ccctl window, or open the app root.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("./");
      }
      return undefined;
    }),
  );
});
