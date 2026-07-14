# @ccctl/web-ui

The zero-build browser UI for [ccctl](../../README.md). Deliberately has **no
framework and no bundler**: it is a single `index.html` plus seven vanilla ES
modules served statically — `src/app.js` (the thin DOM shell), `src/transcript.js`
(the DOM-free downstream rendering logic), `src/command.js` (the DOM-free
upstream steer-building logic), `src/sessions.js` (the DOM-free session-list
diff / label / selection logic), `src/connection.js` (the DOM-free
connection-health verdict), `src/pairing.js` (the DOM-free QR-pair
token-application logic) and `src/devices.js` (the DOM-free device-list
label / last-seen / current-device logic). There is nothing to compile; `build` just copies
the static assets into `dist/`, and the modules can be served as-is by the daemon
(or locally, e.g. `npx serve .`).

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

The `@ccctl/core` frame shapes are **mirrored, not imported** — this UI is served
to the browser as-is, so `src/*.js` stays dependency-free vanilla ESM. The
downstream rendering logic in `src/transcript.js`, the upstream steer-building
logic in `src/command.js`, the session-list diff / label / selection logic in
`src/sessions.js`, the connection-health verdict in `src/connection.js`, the
QR-pair token application in `src/pairing.js` and the device-list logic in
`src/devices.js` are all
unit-tested (`vitest`), and the e2e harness imports the first two to drive the real
decode / steer path against a real daemon. The DOM
shell in `src/app.js` is thin glue that is **not** directly exercised: it reads the
DOM at module load and the repo ships no DOM driver, so it is verified by
inspection. That is the split the modules exist to enable — every decision lives in
a DOM-free module that a test can reach, leaving `app.js` with only the glue.
