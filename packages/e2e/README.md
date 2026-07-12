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

- **Bridge wire-conformance oracle (#130/#131)** — `bridge-wire-conformance.ts` pins the
  current environments-bridge flow's snake_case contract face **independently** of
  the server's own serializers (`{ environment_id }` §1, `{ session_id }` §2 — **no**
  `ws_url` — and a **single** `{ id, secret, data }` work item §3, **not** a
  `{ work: [...] }` envelope, whose `secret` decodes to
  `{ version, session_ingress_token, api_base_url }`) and asserts the **real**
  `@ccctl/server` speaks it — `assertServerSpeaksBridgeContract`, including the
  **two-credential boundary** (the account Bearer opens §1/§2 — and those legs 401
  without it — while the §3 poll is **uncredentialed** and the §4/§5 channel is
  authorized by the locally-minted ingress token, never the account Bearer). Pinning the
  shapes independently is what makes a green run imply **interoperability, not just
  internal consistency**: a server drift off the current face fails the gate.
  `wire-conformance.e2e.test.ts` runs it against the real server on every hermetic run;
  the pure per-leg shape assertions are unit-tested in `bridge-wire-conformance.test.ts`.
  The mock bridge's driving helpers here (`registerEnvironment`, `createSession`,
  `pollWork`) are the single place the harness speaks the current flow.

- **One-session control-plane flow (captured SSE wire, #131)** — `one-session-harness.ts`
  drives the whole walking-skeleton round-trip end-to-end against the real `@ccctl/server`
  over the **current environments-bridge flow**: the bridge **registers its
  environment** (`POST /v1/environments/bridge`, §1), a session is **created**
  (`POST /v1/sessions`, §2, which auto-enqueues its work item), the bridge **polls for
  work** with **no credential** (`GET …/work/poll`, §3) and receives the **single**
  session-dispatch item whose `secret` decodes to the per-session ingress token, a
  stand-in worker opens the per-session channel over **HTTP + SSE** (`worker/register` →
  held-open `worker/events/stream` → `PUT worker` status, §4/§5), a stand-in phone
  **views** the session over **SSE** (`GET /api/events`), and the phone **steers** it
  (`POST /api/command`) — a `prompt` the server injects as a `{ type: "user" }`
  `client_event` turn the worker **reads** off its downstream and acks
  (`worker/events/delivery`), after which the worker relays a transcript back up
  `worker/events` that the phone views. Every hop is grounded in the receiver's own
  record (the server's environments + session maps, the poll body the bridge received,
  the phone's SSE log, the worker's inbound `client_event` frames), never a sender's
  self-report. The phone legs run the **real** [`@ccctl/web-ui`](../web-ui) view
  (`transcript.js`, #15) and steer (`command.js`, #16) logic, not a re-implementation.
  The flow **produces the control-leg fixture** the inference-untouched assertion
  consumes; `one-session-flow.e2e.test.ts` drives it and feeds
  `assertInferenceUntouched` — hermetic (loopback only, no patched worker or
  credentials), so it gates on every run. Its pure SSE parsing helpers are
  unit-tested in `one-session-harness.test.ts`.

- **Live-worker oracle (credentialed wave, #133)** — `live-worker-oracle.ts` pairs the
  hermetic wire-conformance golden with an independent **live** check. A hermetic golden
  can only verify "the server emits the wire the golden encodes," never "the golden
  encodes the wire the **real** worker actually speaks"; the oracle closes that gap by
  driving a **real** patched worker against the built `@ccctl/server` and
  **self-classifying** the observed wire against the golden's pinned shapes —
  `verified` (the live wire matches every pinned shape **and** a real worker reached
  `idle` and completed one turn), `drift` (a leg's live wire diverged — the golden is
  stale vs the current worker; the diverging leg(s) are **named** and the run **fails**),
  or `inconclusive` (a required leg was never captured — worker never reached `idle`, no
  turn, or a bridge response was never seen — **runtime-skip**, never a fabricated green).
  It reuses the golden's **own** pure shape assertions, so "drift" is literally "the live
  wire fails the same gate the golden pins," and every "reached X" is receiver-read from
  the server's own state (the `one-session-harness` posture). **Fenced / opt-in**: the
  whole suite is gated on `CCCTL_E2E` + `CCCTL_SDK_URL` + `ANTHROPIC_API_KEY`
  (`resolveOracleEnv`) and `describe.skipIf`-skips when they are absent, so it lives
  **outside** the credential-free CI `e2e` lane and never runs — nor fails — there.
  `control-plane.e2e.test.ts` drives it; the pure fence + tri-state classifier are
  unit-tested credential-free in `live-worker-oracle.test.ts`.

## What is fenced to the credentialed wave

- The **live-worker oracle** above is wired but **fenced** — it runs only when
  `CCCTL_E2E` / `CCCTL_SDK_URL` / `ANTHROPIC_API_KEY` are set (turbo passes them through
  to `test:e2e`). The remaining forward-looking piece is the concrete **patched-worker
  launch contract** (`PatchedWorkerLauncher` / `spawnPatchedWorker`): the repo ships no
  packaged patched worker yet (the `ccctl serve` daemon is still a skeleton, #71), so the
  default launcher spawns the operator-supplied `CCCTL_SDK_URL` with a documented env
  contract, and any mismatch surfaces **safely** as `inconclusive` rather than a fake
  green. The launcher is injectable, so that contract can firm up when the patched-worker
  packaging lands with no churn to the oracle. The hermetic `one-session-harness` is the
  skeleton the live oracle graduates from.

## Running

- `pnpm --filter @ccctl/e2e test` — unit specs (`src/*.test.ts`).
- `pnpm --filter @ccctl/e2e test:e2e` — end-to-end specs (`src/*.e2e.test.ts`),
  run serially. The wired skeleton is self-contained (loopback only); the
  later real specs will gate on their own env.
