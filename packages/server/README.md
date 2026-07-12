# @ccctl/server

The local server for [ccctl](../../README.md). It accepts the patched Claude
Code worker's `stream-json` control channel and relays it to the browser UI:
worker → UI over Server-Sent Events (SSE), and UI → worker via `fetch` injected
onto the worker's SSE downstream. It binds to loopback (`127.0.0.1`) by default, so
nothing is reachable off-box until a tunnel from `@ccctl/tunnel-adapters` is
attached. Depends on [`@ccctl/core`](../core) for the session model and
control-channel types.

`startServer` terminates the current build's **environments-bridge** flow
(bridge-protocol §1–§5), conformed to the worker's observed wire. A worker
`POST /v1/environments/bridge` (account Bearer) registers an environment and is
handed an **environment id** (§1); a `POST /v1/sessions` (account Bearer) then
creates a session, **auto-enqueues** its `session` work item, and returns its
**id** — no `ws_url` (§2). Work is delivered as a **single item**
`{ id, secret, data: { type, id } }` by long-polling
`GET /v1/environments/{env}/work/poll`, which carries **no credential** (§3); the
item's `secret` is `base64url(JSON { version, session_ingress_token, api_base_url })`,
minting the per-session credential the worker presents next. The worker then opens
the per-session channel over **HTTP + Server-Sent Events** under
`/v1/code/sessions/{id}/worker/…` (§4/§5) — never a WebSocket: `worker/register`
mints a `worker_epoch`, a held-open `worker/events/stream` is the server→worker
downstream, `worker/events` is the batched upstream, and `PUT worker` reports a
`worker_status` from which the server derives the session's live `activity`
(running / requires_action / idle) via the `@ccctl/core` model. A turn is injected
by pushing a `client_event` frame down the SSE.

**Two-credential boundary (hard).** The account Bearer rides §1/§2 ONLY — received
and treated as a strict non-persisting pass-through: required, but never stored on
the session, never logged, never returned in a body. The §3 poll carries no
credential; the §4/§5 channel is authorized by the locally-minted
`session_ingress_token` (carried inside the work-secret), NOT the account Bearer.

The browser-facing transport pair relays that one session to the UI. Downstream,
every payload the worker POSTs up `worker/events` (§5) fans out to subscribed
clients over **Server-Sent Events** at `GET /api/events`, each event carrying a
`Last-Event-ID`-compatible id so a reconnecting client reconciles the gap it
missed. Upstream, the browser steers back with a `fetch` **POST** to
`/api/command`: a `prompt` becomes a `{ type: "user" }` turn injected on the
session's worker downstream, any other verb a `control_request` — both pushed as a
`client_event` frame. Browser-facing auth — the deferred local-server credential
boundary — is a later item; the loopback UI ingress is unauthenticated at this
slice (the account Bearer rides the worker's §1/§2 legs, never the browser).

Two **baseline startup guarantees** ride along from the skeleton, exported for the
daemon ([`@ccctl/cli`](../cli)'s `serve`) to apply before it binds: `requireLocalServerAuth`
refuses to start when no local-server auth is configured — there is no
unauthenticated mode, even on loopback — and `resolveBindHost` keeps the listener
on loopback (`127.0.0.1`), refusing the `0.0.0.0` wildcard so nothing is exposed
off-box. This is start-time refusal, distinct from the per-request UI-ingress auth
above, which stays deferred. Both are the minimal slice: the full credential
boundary (a config-file source, an actionable error, every start path) is a later
item, as is the complete non-loopback bind refusal (`::`, LAN, public).
