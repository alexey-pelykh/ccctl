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
a `control_request` (§2).

The browser-facing transport pair relays that one session to the UI. Downstream,
every inbound `control_event` fans out to subscribed clients over **Server-Sent
Events** at `GET /api/events` (`broadcast`), each event carrying a
`Last-Event-ID`-compatible id so a reconnecting client reconciles the gap it
missed. Upstream, the browser steers back with a `fetch` **POST** to
`/api/command`, which the server re-frames as a `control_request` and `dispatch`es
onto the worker channel. Browser-facing auth — the deferred local-server credential
boundary — is a later item; the loopback UI ingress is unauthenticated at this
slice (the account Bearer is the worker's credential, never the browser's).

Two **baseline startup guarantees** ride along from the skeleton, exported for the
daemon ([`@ccctl/cli`](../cli)'s `serve`) to apply before it binds: `requireLocalServerAuth`
refuses to start when no local-server auth is configured — there is no
unauthenticated mode, even on loopback — and `resolveBindHost` keeps the listener
on loopback (`127.0.0.1`), refusing the `0.0.0.0` wildcard so nothing is exposed
off-box. This is start-time refusal, distinct from the per-request UI-ingress auth
above, which stays deferred. Both are the minimal slice: the full credential
boundary (a config-file source, an actionable error, every start path) is a later
item, as is the complete non-loopback bind refusal (`::`, LAN, public).
