# @ccctl/server

The local server for [ccctl](../../README.md). It accepts the patched Claude
Code worker's `stream-json` control channel and relays it to the browser UI:
worker → UI over Server-Sent Events (SSE), and UI → worker via `fetch` re-framed
as `control_request`s. It binds to loopback (`127.0.0.1`) by default, so nothing
is reachable off-box until a tunnel from `@ccctl/tunnel-adapters` is attached.
Depends on [`@ccctl/core`](../core) for the session model and control-channel
types. This package is a skeleton — `startServer` is a typed stub.
