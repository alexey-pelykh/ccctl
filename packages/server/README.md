# @ccctl/server

The local server for [ccctl](../../README.md). It accepts the patched Claude
Code worker's `stream-json` control channel and relays it to the browser UI:
worker → UI over Server-Sent Events (SSE), and UI → worker via `fetch` re-framed
as `control_request`s. It binds to loopback (`127.0.0.1`) by default, so nothing
is reachable off-box until a tunnel from `@ccctl/tunnel-adapters` is attached.
Depends on [`@ccctl/core`](../core) for the session model and control-channel
types.

`startServer` accepts session registration today: a worker
`POST /v1/code/sessions` (bridge-protocol §1) creates a session and hands back
its **id** plus the **`ws_url`** the worker opens its channel to. The worker then
opens a WebSocket to that `ws_url` (bridge-protocol §2) — the ccctl server is the
WebSocket server — and streams `worker_status` frames (§3), from which the server
derives the session's live `activity` (running / requires_action / idle) via the
`@ccctl/core` model. The account Bearer on both the register request and the
worker-channel connect (§4) is received and treated as a strict non-persisting
pass-through — required, but never stored on the session, never logged. One
session only at this slice; the worker channel just reads and surfaces the raw
state (fuller classification and the idle timer land in later items). UI→worker
`dispatch` relays one steer worker-ward over that same worker channel, re-framed as
a `control_request` (§2); the SSE relay (`broadcast`) to the UI remains a typed
stub, as does the HTTP/`fetch` ingress that will call `dispatch` from the browser.
