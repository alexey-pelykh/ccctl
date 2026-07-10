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
its **id** plus the **`ws_url`** the worker opens its channel to. The account
Bearer on that request (§4) is received and treated as a strict non-persisting
pass-through — never stored on the session, never logged. One session only at
this slice. The worker-channel WebSocket, the SSE relay (`broadcast`), and
UI→worker `dispatch` remain typed stubs, landing in later items.
