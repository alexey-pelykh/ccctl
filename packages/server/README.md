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

**Both worker legs feed the classification (#39).** `PUT worker` carries a BARE
`worker_status`; the RICH `worker_status` frame — `payload: { status, detail }`, whose
`detail` is the human-ready line naming the tool or question the worker is blocked on —
rides the `worker/events` upstream, which relays it to the UI _and_ folds it into the
session's `activity`. That detail is what a "needs you" notification names, so it must
reach the session model, not just the browser's transcript. A bare `requires_action`
re-affirmation keeps the detail already captured: supplying no detail is not a statement
that the detail is unknown. The detail is worker-supplied, so it is normalized where it
enters the model — flattened to one line, control characters stripped, length clamped —
and every consumer (`ccctl attach`'s session list, `GET /api/sessions`, the persisted
snapshot) inherits that rather than re-deriving it.

Classification is **per-session**, and applications are **last-write-wins in the server's
receipt order**. It is NOT ordered by frame age: neither status leg carries a timestamp or
a sequence number (`worker_epoch` orders registrations, not the frames within one), so the
server has no frame age to order by. Detecting a genuinely stale frame needs the emitter —
the patched worker — to stamp one, which is a protocol change, tracked in
[#201](https://github.com/alexey-pelykh/ccctl/issues/201).

**Two-credential boundary (hard).** The account Bearer rides §1/§2 ONLY — received
and treated as a strict non-persisting pass-through: required, but never stored on
the session, never logged, never returned in a body. The §3 poll carries no
credential; the §4/§5 channel is authorized by the locally-minted
`session_ingress_token` (carried inside the work-secret), NOT the account Bearer.

The browser-facing transport is a **per-session** namespace (#20), so the daemon
carries more than one session at once without cross-wiring. `GET /api/sessions` lists
the carried sessions (id + status + activity, plus a persistent
notifications-degraded marker for a session created under a non-prompting
permission mode, #26). Downstream, every payload a session's
worker POSTs up `worker/events` (§5) fans out to the clients subscribed to THAT
session's **Server-Sent Events** stream at `GET /api/sessions/{id}/events` — and only
them — each event carrying a per-session `Last-Event-ID`-compatible id so a
reconnecting client reconciles the gap it missed. The server also RAISES two of its own
session-naming events onto that same stream: a **blocking needs-input notification**
([#43](https://github.com/alexey-pelykh/ccctl/issues/43)) the moment a session enters
`requires_action` — carrying the human-ready detail of what it awaits — and an
**informational idle nudge** ([#41](https://github.com/alexey-pelykh/ccctl/issues/41))
once a session has sat idle past its threshold. Both are `ccctl_`-namespaced (so the
browser's decoder never mistakes them for a worker transcript frame) and both name the
session in the payload, so a consumer identifies WHICH session needs attention — never a
generic "a session needs you". These are the two firewalled **notification classes**
([#44](https://github.com/alexey-pelykh/ccctl/issues/44)): each payload also carries its
`notification_class` and the handling policy that rides with it — the needs-input
notification is **blocking** (high-urgency, re-nudgeable, never batched), the idle nudge
**informational** (quiet, batchable, never re-nudged) — so a consumer keys its handling on
the class instead of re-deriving urgency from the event type, and an informational event can
never escalate into or masquerade as the blocking class.

A blocking needs-input notification is also what a **push wake** is derived from
([#45](https://github.com/alexey-pelykh/ccctl/issues/45)), and that derivation is a firewall
(`push-payload.ts`): a push necessarily transits an external gateway the operator does not own,
so it carries only a **pointer** — an opaque session id plus a minimal generic line ("A session
needs your input") — never the `detail` or any session content, and the gateway itself sees only
bounded metadata (a wake's existence, timing, and cadence, plus a stable subscription id) — never
the pointer or the content. The actual session content is fetched back over the **tunnel** on tap
(the opaque id is the deep-link target), so nothing a session is saying ever leaves the box in a
push. Each wake also carries two **reliability directives**
([#46](https://github.com/alexey-pelykh/ccctl/issues/46)): the `Urgency: high` marker (so a
backgrounded client is pulled back now, not deferred) and an **opaque per-session collapse id** — a
one-way digest of the session pointer, so repeated wakes for one blocked session coalesce into a
single notification rather than stacking, yet the gateway that reads that collapse id (a cleartext
Web-Push `Topic` header) still never learns which session it is. Those layers fix only the
pointer-only SHAPE, its firewall, and those directives; the wake **dispatch** that consumes them is a
single seam ([#50](https://github.com/alexey-pelykh/ccctl/issues/50), `wake-dispatch.ts`).
`dispatchWake` is the ONE function all wake dispatch goes through — it derives those directives and
stamps them onto every send, serializes the pointer-only payload as the RFC 8291-encrypted body, and
hands the assembled request to an injected Web-Push transmit — with NO pluggable-transport abstraction
(a future APNs/FCM adapter replaces the whole function, not an injected port), plus fail-closed VAPID
key handling (`validateVapidKeys` refuses a mis-typed subject or a wrong-length P-256 key at config
load). Like the shapes it consumes, it is not yet wired into a live path — there is no subscription
store ([#51](https://github.com/alexey-pelykh/ccctl/issues/51)) or scheduler loop yet — so it fixes
the dispatch discipline before the first live caller exists.

Because both rungs above can miss — the live SSE relay misses a disconnected client, and a push is
at-most-once (coalesced by its `Topic`, dropped on expiry, or lost when a subscription lapses) — a
blocking needs-you is ALSO enqueued to a **persisted unread queue**
([#47](https://github.com/alexey-pelykh/ccctl/issues/47), `unread-queue.ts`), reconciled over the
tunnel on reconnect: the queue, not the at-most-once push, is the source of truth. Each entry carries
the per-session SSE `Last-Event-ID` it was broadcast under, so a reconnecting client is delivered
exactly its still-un-acknowledged entries in that order; an acknowledgement REMOVES the entry (so it
is never re-delivered), and the queue rides the `0600` session-store snapshot
([#23](https://github.com/alexey-pelykh/ccctl/issues/23)) so it survives a daemon restart. Like the
push shape above, the queue OPERATIONS are pure and not yet wired into a live dispatch path — the
store's own daemon wiring is a later item.

Upstream, the browser steers a
chosen session with a `fetch` **POST** to `/api/sessions/{id}/command`: a `prompt`
becomes a `{ type: "user" }` turn injected on that session's worker downstream, any
other verb a `control_request` — both pushed as a `client_event` frame. Naming the
session in the URL makes cross-wiring between sessions structurally impossible.
Browser-facing auth — the deferred local-server credential boundary — is a later item;
the loopback UI ingress is unauthenticated at this slice (the account Bearer rides the
worker's §1/§2 legs, never the browser).

Two **baseline startup guarantees** ride along from the skeleton, exported for the
daemon ([`@ccctl/cli`](../cli)'s `serve`) to apply before it binds: `requireLocalServerAuth`
refuses to start when no local-server auth is configured — there is no
unauthenticated mode, even on loopback — and `resolveBindHost` keeps the listener
on loopback (`127.0.0.1`), refusing the `0.0.0.0` wildcard so nothing is exposed
off-box. This is start-time refusal, distinct from the per-request UI-ingress auth
above, which stays deferred. Refuse-start-without-auth is now **complete to spec**
(#57): the secret is read from either `CCCTL_LOCAL_SERVER_AUTH` or the config file at
`resolveLocalServerAuthPath` (`$XDG_CONFIG_HOME/ccctl/local-server-auth`, default
`~/.config/ccctl/local-server-auth`), a present-but-empty value on either source counts
as no auth, and the refusal names the env key, the file path it looked for, and how to
configure either. The secret's fuller credential boundary (generation, scoping,
storage-format, rotation, at-rest permissions) stays deferred, as does the complete
non-loopback bind refusal (`::`, LAN, public — #58).
