# @ccctl/web-ui

The zero-build browser UI for [ccctl](../../README.md). Deliberately has **no
framework and no bundler**: it is a single `index.html` plus three vanilla ES
modules served statically — `src/app.js` (the thin DOM shell), `src/transcript.js`
(the DOM-free downstream rendering logic) and `src/command.js` (the DOM-free
upstream steer-building logic). There is nothing to compile; `build` just copies
the static assets into `dist/`, and the modules can be served as-is by the daemon
(or locally, e.g. `npx serve .`).

It talks to [`@ccctl/server`](../server) over a **per-session** namespace (#20), so
more than one session can be carried at once. `GET /api/sessions` lists the carried
sessions and the UI picks one to view + steer; the selected session drives the
zero-build transport pair:

- **List + select (#20):** a `fetch` GET of `/api/sessions` enumerates the sessions
  the daemon is carrying (id + status + activity). Picking one (re)opens its stream
  and clears the prior session's transcript — the view + steer below apply to the
  selected session, and never bleed across sessions.
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

The `@ccctl/core` frame shapes are **mirrored, not imported** — this UI is served
to the browser as-is, so `src/*.js` stays dependency-free vanilla ESM. The
downstream rendering logic in `src/transcript.js` and the upstream steer-building
logic in `src/command.js` are both unit-tested (`vitest`); the DOM shell in
`src/app.js` is thin glue, exercised end-to-end by the e2e harness.
