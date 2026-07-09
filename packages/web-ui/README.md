# @ccctl/web-ui

The zero-build browser UI for [ccctl](../../README.md). Deliberately has **no
framework and no bundler**: it is a single `index.html` plus one vanilla ES
module (`src/app.js`) served statically. It talks to
[`@ccctl/server`](../server) over two channels — an `EventSource` (SSE) for the
downstream control-event stream, and `fetch` for upstream commands the server
re-frames as `control_request`s. There is nothing to compile; `build` just
copies the static assets into `dist/`, and the module can be served as-is (e.g.
`npx serve .`). This package is a skeleton — the endpoints are stubbed against
the intended server contract.
