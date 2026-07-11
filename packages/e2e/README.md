# @ccctl/e2e

End-to-end test package for [ccctl](../../README.md). The target scenario it
exercises: a **patched, headless Claude Code worker →
[`@ccctl/server`](../server) on loopback → SSE to a UI client**, asserting that
**inference still egresses to `api.anthropic.com`**. That last assertion is the
whole point: ccctl steers the control channel but must never proxy or reroute
model traffic — inference and billing stay on Anthropic under the user's own
subscription. Depends on [`@ccctl/cli`](../cli), [`@ccctl/core`](../core),
[`@ccctl/server`](../server), and [`@ccctl/web-ui`](../web-ui).

## What is wired

- **Inference-untouched guarantee (AC-5 skeleton)** — `inference-guarantee.ts`
  holds `assertInferenceUntouched`, the pure, bidirectional correctness claim
  (control traffic reaches the local server; inference reaches
  `api.anthropic.com`; a regression that redirects inference is caught).
  `traffic-harness.ts` grounds it in **real, receiver-observed connections**:
  the control leg registers with the real `@ccctl/server` (proven by its own
  session record), and the inference leg is a real outbound request carrying
  `Host: api.anthropic.com`, observed by a loopback stand-in for that host.
  `inference-guarantee.test.ts` (unit) and `inference-untouched.e2e.test.ts`
  (e2e) exercise it — hermetic, no patched worker or credentials, so it gates on
  every run.

- **Bridge wire-conformance oracle (#124)** — `bridge-wire-conformance.ts` pins the
  current environments-bridge flow's snake_case contract face **independently** of
  the server's own serializers (`{ environment_id, work_poll_token }` §1,
  `{ session_id, ws_url }` §2, `{ work: WorkItem[] }` §3 through core's fail-closed
  `workItemFromValue`) and asserts the **real** `@ccctl/server` speaks it —
  `assertServerSpeaksBridgeContract`, including the **two-token boundary** (the account
  Bearer opens §1/§2 but is refused on the §3 work-poll, which the scoped
  per-environment token opens). Pinning the shapes independently is what makes a green
  run imply **interoperability, not just internal consistency**: a server drift off the
  current face fails the gate. `wire-conformance.e2e.test.ts` runs it against the real
  server on every hermetic run; the pure per-leg shape assertions are unit-tested in
  `bridge-wire-conformance.test.ts`. The mock bridge's driving helpers here
  (`registerEnvironment`, `createSession`, `pollWork`, `ackWork`) are the single place
  the harness speaks the current flow.

- **One-session control-plane flow (skeleton)** — `one-session-harness.ts` drives
  the whole walking-skeleton round-trip end-to-end against the real `@ccctl/server`
  over the **current environments-bridge flow**: the bridge **registers its
  environment** (`POST /v1/environments/bridge`, §1), a session is **created**
  (`POST /v1/sessions`, §2), the bridge **polls for work** with its scoped token
  (`GET …/work/poll`, §3) and acks the session-dispatch item, a stand-in worker opens
  the **worker channel** at the minted `ws_url` (`/v1/sessions/{id}/ws`, §4), a stand-in
  phone **views** the session over **SSE** (`GET /api/events`) as the worker emits a
  `control_event`, and the phone **steers** it (`POST /api/command`) — the server
  re-framing that steer onto the worker channel. Every hop is grounded in the
  receiver's own record (the server's environments + session maps, the poll body the
  bridge received, the phone's SSE log, the worker's inbound frames), never a sender's
  self-report. The phone legs run the **real** [`@ccctl/web-ui`](../web-ui) view
  (`transcript.js`, #15) and steer (`command.js`, #16) logic, not a re-implementation.
  The flow **produces the control-leg fixture** the inference-untouched assertion
  consumes; `one-session-flow.e2e.test.ts` drives it and feeds
  `assertInferenceUntouched` — hermetic (loopback only, no patched worker or
  credentials), so it gates on every run. Its pure WebSocket/SSE framing helpers are
  unit-tested in `one-session-harness.test.ts`.

## What is still a placeholder

- The **full happy path with a real worker** — the same one-session flow, but
  driven by a real patched, headless Claude Code worker and with a **real egress
  to `api.anthropic.com`** — lands in a later, credentialed wave (gated on
  `CCCTL_E2E` / `CCCTL_SDK_URL` / `ANTHROPIC_API_KEY`). `control-plane.e2e.test.ts`
  holds that `describe.todo` placeholder; the hermetic `one-session-harness` above
  is the skeleton it graduates from.

## Running

- `pnpm --filter @ccctl/e2e test` — unit specs (`src/*.test.ts`).
- `pnpm --filter @ccctl/e2e test:e2e` — end-to-end specs (`src/*.e2e.test.ts`),
  run serially. The wired skeleton is self-contained (loopback only); the
  later real specs will gate on their own env.
