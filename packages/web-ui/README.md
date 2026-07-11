# @ccctl/web-ui

The zero-build browser UI for [ccctl](../../README.md). Deliberately has **no
framework and no bundler**: it is a single `index.html` plus two vanilla ES
modules served statically — `src/app.js` (the thin DOM shell) and
`src/transcript.js` (the DOM-free rendering logic). There is nothing to compile;
`build` just copies the static assets into `dist/`, and the modules can be served
as-is by the daemon (or locally, e.g. `npx serve .`).

It talks to [`@ccctl/server`](../server) over two channels — the zero-build
transport pair:

- **Downstream (implemented, #15):** an `EventSource` subscribes to the SSE
  stream at `GET /api/events`. Each `control_event` frame is decoded and routed —
  a `worker_status` frame updates the **current-turn** indicator in place
  (`running` / `requires_action` + its detail / `idle`), every other event is
  appended to the **transcript**, and an undecodable line is surfaced verbatim
  rather than dropped. On reconnect, `EventSource` replays past its
  `Last-Event-ID` and the server reconciles the gap.
- **Upstream (skeleton, #16):** `fetch` POSTs a `{ subtype, payload }` command to
  `POST /api/command`, which the server re-frames as a `control_request`. The
  prompt form is wired against that contract; completing the steer UX is #16.

The `@ccctl/core` frame shapes are **mirrored, not imported** — this UI is served
to the browser as-is, so `src/*.js` stays dependency-free vanilla ESM. The
rendering logic in `src/transcript.js` is unit-tested (`vitest`); the DOM shell in
`src/app.js` is thin glue, exercised end-to-end by the e2e harness.
