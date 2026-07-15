# @ccctl/web-ui

The zero-build browser UI for [ccctl](../../README.md). Deliberately has **no
framework and no bundler**: it is a single `index.html` plus eleven vanilla ES
modules served statically — `src/app.js` (the thin DOM shell), `src/transcript.js`
(the DOM-free downstream rendering logic), `src/command.js` (the DOM-free
upstream steer-building logic), `src/sessions.js` (the DOM-free session-list
diff / label / selection logic), `src/launch.js` (the DOM-free "New session"
launch-body / typed-failure logic), `src/stop.js` (the DOM-free emergency-stop
request / typed-refusal logic), `src/connection.js` (the DOM-free
connection-health verdict), `src/pairing.js` (the DOM-free QR-pair
token-application logic), `src/devices.js` (the DOM-free device-list
label / last-seen / current-device logic), `src/push.js` (the DOM-free
Web-Push subscription / notification logic) and `src/needs-you.js` (the DOM-free
needs-you-queue reconcile / ack logic). For PWA install it also ships a
`manifest.webmanifest`, a `sw.js` service worker and a scalable `icon.svg` (#51).
There is nothing to compile; `build` just copies the static assets into `dist/`,
and the modules can be served as-is by the daemon (or locally, e.g. `npx serve .`).

It talks to [`@ccctl/server`](../server) over a **per-session** namespace (#20), so
more than one session can be carried at once. `GET /api/sessions` lists the carried
sessions and the UI picks one to view + steer; the selected session drives the
zero-build transport pair:

- **List + select (#20; live status #25; degraded badge #27):** a `fetch` GET of
  `/api/sessions` enumerates the sessions the daemon is carrying (id + transport
  status + activity + the notifications-degraded marker).
  The list is **polled on an interval** and reconciled **in place** — only the rows
  whose status / activity changed are relabelled — so each session's per-session
  status (running / idle / awaiting-input) stays live as sessions change state,
  without flicker or losing focus / the current selection. A session carrying the
  life-long **notifications-degraded** marker (#26 — a non-prompting session whose
  needs-you notifications never fire) stands a persistent badge on its row (#27); a
  prompting session shows none. Picking one (re)opens its stream and clears the prior
  session's transcript — the view + steer below apply to the selected session, and
  never bleed across sessions.
- **Downstream (implemented, #15; per-session #20):** an `EventSource` subscribes to
  the selected session's SSE stream at `GET /api/sessions/{id}/events`. Each
  `control_event` frame is decoded and routed — a `worker_status` frame updates the
  **current-turn** indicator in place (`running` / `requires_action` + its detail /
  `idle`), every other event is appended to the **transcript**, and an undecodable
  line is surfaced verbatim rather than dropped. On reconnect, `EventSource` replays
  past its per-session `Last-Event-ID` and the server reconciles the gap.
- **Upstream (implemented, #16; per-session #20):** `fetch` POSTs a
  `{ subtype, payload? }` command to `POST /api/sessions/{id}/command`, which the
  server re-frames as a `control_request` (it mints the id) and relays to THAT
  session's worker channel. Three steer verbs are wired: **input**
  (`{ subtype: "prompt", payload: { text } }`), **redirect**
  (`{ subtype: "interrupt", payload: { reason } }`) and **approve**
  (`{ subtype: "approve" }`). An accepted steer (server `202`) is echoed into the
  transcript — marked outbound — so it is reflected in the viewed session even
  before the worker's own events flow back down the SSE stream.
- **Launch (implemented, #37; UC2 core #31):** a **"New session"** control `fetch`
  POSTs `{ cwd, permissionMode, project?, initialPrompt? }` to
  `POST /api/sessions` — the operator's **working directory** (required) plus an
  optional **project** label and **initial prompt** — and the server runs its
  injected launcher to bring up a real headful terminal running the patched
  `claude`. `src/launch.js` owns the body-building and the answer-reading; the
  `permissionMode` is pinned to `default` rather than offered as a control, because
  the server requires the field and refuses the non-prompting modes (a session that
  never blocks could never raise the "awaiting input" signal a remote steer needs —
  SRV-C-003 / #32). The launched session is `registering` **from birth** (#33), so
  an accepted launch simply refreshes the list above and the new session appears
  there. The launch itself selects nothing; the picker's ordinary first-load rule
  still applies, so launching into an empty list auto-selects the new row and opens
  its stream — which the server holds until the worker registers and the row advances
  in place (and if the worker never comes, the eviction drops the row and the
  selection clears). A failure surfaces the server's
  **typed** `code` (`invalid-cwd`, `at-capacity`, `backend-unavailable`, … — #33/#36)
  as a chip alongside the server's own actionable sentence, so the operator is told
  _which_ failure it is instead of having to pattern-match prose. The control is
  disabled while a launch is in flight: each one spawns a real terminal, so a
  double-tap must not ask for two (the client half of `maxSessions`, #36).

Above the session picker sits an always-visible **connection-health indicator
(#75)** — `live` / `reconnecting` / `offline` — for the phone↔server transport as a
whole, distinct from any one session's status. `src/connection.js` reduces the two
transport legs to the verdict: the **poll (fetch) heartbeat** is the authority on
reachability (it runs on the interval whether or not a session is selected, and
steering rides the same request path), and the selected session's **SSE stream**
refines it downward (a stream mid-(re)connect reads as `reconnecting`). It never
reads a session's worker status. A failed poll shows `offline`; the state repaints
within a poll interval of any change.

Below the steer controls sits a **device list (#85)** — the operator's paired
devices (phone / tablet / laptop) by **name + last-seen**, with the **current
device clearly marked**. It is a management surface distinct from the per-session
flow: `src/devices.js` owns the row label / relative last-seen / current-device
decisions, and `app.js` fetches `GET /api/devices` on load and on a manual
**Refresh** (devices change rarely — pair / rename / revoke — so it is not
auto-polled like the session list). Each row is keyed by **device id** — the entry
point a per-device **revoke** (W6-19) will hang off. The route and its server-set
`current` marker land with the credentialed wave (#84 persists the device store
hashed + named + listable; the server-side token verification that computes
`current` is deferred), so until then the surface renders against the mirrored
contract — exactly as the QR-pair token application (#74) runs ahead of server-side
enforcement.

The UI is also a **PWA** with **Web-Push** (#51). A `manifest.webmanifest`, a
`sw.js` service worker (registered from `app.js` on load) and a scalable
`icon.svg` make it **installable**; an **"Enable notifications"** control then
subscribes THIS device to Web-Push (VAPID) so the operator is **woken by a
visible notification** when a session blocks on them while the app is
backgrounded or closed. `src/push.js` owns the DOM-free decisions — the VAPID
public key → `applicationServerKey` conversion, the browser `PushSubscription` →
the server contract shaping, and the always-visible notification content — and
`app.js` is the thin glue that requests permission, subscribes (**always**
`userVisibleOnly`), and uploads the subscription. The uploaded shape is exactly
the `WebPushSubscription` (`{ endpoint, keys: { p256dh, auth } }`) the server's
**wake dispatch** consumes (#50), so a stored subscription is the one a wake is
sent to. On **iOS** — where Web-Push is installed-PWA-only and a push that shows
nothing gets the subscription revoked — the service worker's `push` handler
**always** calls `showNotification`, for any payload, so there is **no silent
push**; it reads only the pointer-only wake (#45), never session content.
**Tapping** a wake **deep-links** to the exact session (#52): the worker
resolves the opaque `session_id` pointer to `?session=<id>` and the app views
that session — fetching its content **over the tunnel** on selection, never
carried in the push. It is the notification **body tap**, never an inline
action button (iOS won't render custom PWA `actions` reliably); an already-open
app is steered in place by a `postMessage` instead of a reload. The
VAPID-public-key and subscription-upload routes are served by a later server
slice (#50 shipped the wake dispatch + VAPID handling but left "the PWA
subscription is #51" as its wiring point), so — until then — the enable-push flow
renders an honest "push isn't available yet" against the **mirrored** contract,
exactly as the QR-pair token application (#74) and the device list (#85) run
ahead of server-side enforcement. `sw.js` is a **classic** worker (the least
uncertain ground for the iOS notification path), so it cannot `import` the ES
module `src/push.js`; it MIRRORS `notificationContent`'s few-line decision inline,
the same "mirrored, not imported" tradeoff below, with `push.test.js` the tested
authority.

Because a push is **at-most-once** (coalesced away, dropped on expiry, or lost on a
lapsed subscription), the notification ladder's non-negotiable backstop is the
persisted **unread "needs-you" queue**, reconciled **over the tunnel on every
reconnect** (#53) — so a blocking event is **never permanently missed**. `src/needs-you.js`
owns the DOM-free decisions: decode the server's un-acked set (its membership is
authoritative), **order each session's entries by `Last-Event-ID`**, and build the
`(sessionId, eventId)` ack key. `app.js` is the glue: when the session-list heartbeat
**(re)connects**, it GETs the hub-global queue and paints a red **"needs you"** badge on
every session that still needs the operator; **viewing** a session **acks** its entries,
so an acknowledged block is **not re-shown** while a seen-but-unacked one **re-surfaces on
every reconnect** until attended. The reconcile + ack routes are served by a later server
slice (#47 shipped the pure queue operations deliberately **unwired**), so — until then —
the reconcile yields an empty queue and the surface stays quiet, the same **mirrored**
mirror-ahead stance as push (#51), the device list (#85) and the QR-pair token (#74). Its
tested authority is `needs-you.test.js`.

The `@ccctl/core` frame shapes are **mirrored, not imported** — this UI is served
to the browser as-is, so `src/*.js` stays dependency-free vanilla ESM. The
downstream rendering logic in `src/transcript.js`, the upstream steer-building
logic in `src/command.js`, the session-list diff / label / selection logic in
`src/sessions.js`, the launch-body / typed-failure logic in `src/launch.js`, the
emergency-stop request / typed-refusal logic in `src/stop.js`, the
connection-health verdict in `src/connection.js`, the
QR-pair token application in `src/pairing.js`, the device-list logic in
`src/devices.js`, the Web-Push subscription / notification logic in
`src/push.js` and the needs-you-queue reconcile / ack logic in `src/needs-you.js`
are all
unit-tested (`vitest`), and four of them are additionally driven against the **real
server** — the yardstick a mirror needs, since a unit test can only check a module's
copy of the contract against a fixture in the same package. `src/transcript.js` +
`src/command.js` drive the real decode / steer path against a real daemon (a live
patched worker, so those specs run under `test:e2e`); `src/launch.js` +
`src/sessions.js` drive the real launch path against the real `POST /api/sessions`
ingress and its typed-failure branches (with a faked launcher, so that one needs no
worker and runs on every `test`). The DOM
shell in `src/app.js` — and the `sw.js` service worker — is thin glue that is
**not** directly exercised: it reads the DOM / service-worker globals at load and
the repo ships no driver for either, so it is verified by inspection (the
substantive push decision lives in the unit-tested `src/push.js`, which `sw.js`
mirrors). That is the split the modules exist to enable — every decision lives in
a DOM-free module that a test can reach, leaving `app.js` with only the glue.
