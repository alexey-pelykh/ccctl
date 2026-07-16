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
  every run. The stand-in's negative-space assertions (`received` has
  `length === 0` for control traffic) are **self-guarded** by a **liveness
  canary** (`probeStandInLiveness`, #134): a probe fired straight at the same
  stand-in instance proves it can receive, so a zero reads as "the traffic did
  not arrive," not "the stand-in was never wired" — which a bare zero would pass
  vacuously.

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
  **views** the session over **SSE** (`GET /api/sessions/{id}/events`, per session #20),
  and the phone **steers** it (`POST /api/sessions/{id}/command`) — a `prompt` the
  server injects as a `{ type: "user" }`
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

- **Idle-hold regression (#167)** — `worker-idle-hold.ts` is the hermetic, deterministic
  proof of the server's **#166** downstream-liveness fix. The captured-wire golden pins each
  bridge leg's **shape**, but is blind to whether the server **holds the worker downstream
  alive over time**: a server that opens `…/worker/events/stream` and then goes silent passes
  the golden yet fails a real worker, which enforces a **~45s downstream-liveness timeout**
  (counting **only** `client_event` frames) and reconnect-loops on an idle session. The
  regression drives a worker **stand-in** that embodies that timeout contract — it holds **one**
  registration and **one** downstream open and runs a liveness monitor that resets a deadline on
  every `client_event` frame and records a **drop** if the gap ever exceeds it — against the
  **real** `@ccctl/server` booted with a **short** liveness interval
  (`workerLivenessIntervalMs`, the config the server unit suite already uses). It asserts the
  idle downstream **stays open past the timeout, with ≥1 `client_event` liveness frame inside the
  window and zero drops** — so `drops === 0` **is** the receiver-grounded proof of "held with no
  reconnect / re-register" (a drop is exactly the `connect → liveness-timeout → reconnect` flap
  #166 removes, so the stand-in need not perform the reconnect to prove the server prevented its
  trigger). It **fails on the pre-#166 behavior** by construction (a silent downstream → the
  deadline fires, no frame in the window). And it is **self-guarded** in the `probeStandInLiveness`
  (#134) posture: a **starved** negative control (a liveness interval pushed far above the hold
  window reproduces pre-#166 within it) proves the same stand-in **does** record a drop, so the
  positive "no drop" is never a vacuous pass. Time is **scaled** to ms (a wall-clock ~45s is unfit
  for CI), with a deliberately **wider** interval/timeout margin than production — which removes
  ms-scale jitter flakiness and only strengthens the regression (pre-#166 emits **zero** frames,
  so it times out for any deadline). Hermetic (loopback only, no patched worker or credentials),
  so it gates on every run: `worker-idle-hold.e2e.test.ts` drives it against the real server and
  `worker-idle-hold.test.ts` pins the pure `classifyIdleHold` verdict credential-free.

- **Multi-session over a real Tailscale tunnel (UC1, #65, traces E2E-B-001)** —
  `multi-session-tunnel.ts` is the fenced, self-classifying oracle that graduates the hermetic
  multi-session flow (`multi-session-flow.e2e.test.ts`, #20 — ≥2 concurrent sessions listed /
  viewed / steered, never cross-wired, over **loopback**) to run over a **real Tailscale tunnel**:
  the phone is a remote tailnet device reaching the loopback-bound `@ccctl/server` **through the
  tunnel** (no public IP, no open inbound ports), while the bridge + worker legs stay on-box
  (loopback), exactly as in reality. It drives a real [`TailscaleTunnel`](../tunnel-adapters)
  (`establish` → `serve`, never `funnel`), carries ≥2 sessions, and has each phone **list**
  (`GET /api/sessions`), **view** (per-session SSE), and **steer** (`POST …/command`) its own
  session over the tunnel's resolved `https://<tailnet-host>` base — then **self-classifies**:
  `verified` (≥2 carried; the phone listed all with per-session status and viewed + steered each
  over the tunnel, no cross-wiring, over a tailnet-scoped base), `drift` (a violation was
  **observed** — a steer/transcript crossed sessions, the listed set diverged, or the reachable
  base was a **public** host; the run **fails**, naming the check), or `inconclusive` (a leg was
  never captured — no tailnet, an unreachable base — **runtime-skip**, never a fabricated green).
  The "no public IP / open ports" AC is receiver-grounded twice over: the reachable base must be a
  **tailnet-scoped** host (`isTailnetHost` — MagicDNS `*.ts.net`, CGNAT `100.64.0.0/10`, or the
  Tailscale IPv6 ULA), **and** `TailscaleTunnel` only ever `serve`s (unit-proven in
  `@ccctl/tunnel-adapters`). Every hop is receiver-read (the server's own session records, each
  worker's own inbound frames, each phone's own over-tunnel SSE log), and view isolation is an
  **exact** match of each phone's relayed bytes to its own worker's emitted transcript.
  **Fenced / opt-in**: the whole suite is gated on `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE`
  (`resolveTunnelE2EEnv`) and `describe.skipIf`-skips when they are absent, so it lives **outside**
  the credential-free CI `e2e` lane and never runs — nor fails — there. `multi-session-tunnel-flow.e2e.test.ts`
  drives it; the pure fence + reachable-base helpers + tri-state classifier (the Tier-A encoding of
  UC1's three ACs) are unit-tested credential-free in `multi-session-tunnel.test.ts`.

- **Launch a session from the phone over a real Tailscale tunnel (UC2, #66, traces E2E-B-001)** —
  `launch-tunnel.ts` is the fenced, self-classifying oracle for the verb UC1 does not cover: the one
  that brings a session **into being** from the phone. It drives the whole UC2 lifecycle over a real
  tunnel — the phone **launches** (`POST /api/sessions`, carrying the body the **real**
  [`@ccctl/web-ui`](../web-ui) `launchRequest` builds, #37), the session is **listed from birth** as
  `registering` (#33) before any worker checks in, its worker **registers** over the bridge (§2,
  on-box/loopback as in reality) at the cwd it was launched at, and the phone then **views + steers**
  it — all through the tunnel's `https://<tailnet-host>` base. Then it **self-classifies**:
  `verified`, `drift` (a violation was **observed**; the run **fails**, naming the check), or
  `inconclusive` (a leg was never captured — **runtime-skip**, never a fabricated green).
  **Id continuity is the proof of "the launched session registers"**, and it is the whole point: the
  §2 leg is literally `claimPendingLaunch(…) ?? randomUUID()`, so a claim that MISSES still answers a
  `201` and still yields a live, listable, steerable session — only **which id came back** tells the
  two apart. An oracle checking merely "a session registered" would pass a daemon in which every
  phone-launched session silently disowns the row the operator is watching. What is **real** here: the
  tunnel, the launch ingress, the pending-launch bookkeeping, the §2 claim correlation, the registry,
  the SSE relay, and the phone's own request body. What is a **stand-in**: the `ISessionLauncher`
  backend and the launched worker — both on the far side of ports the daemon calls **out** through
  (the assertion is the daemon's launch lifecycle, not tmux), and both necessarily so, since the repo
  ships no packaged patched worker (see below) — the real backend's surface + FD residual is #68's job.
  **Fenced / opt-in** on `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE` (`resolveTunnelE2EEnv`, **reused** from
  the UC1 oracle — the infra prerequisite is the same single real tailnet), so it lives **outside** the
  credential-free CI `e2e` lane. `launch-tunnel-flow.e2e.test.ts` drives it; the pure classifier — the
  Tier-A encoding of UC2's three ACs — is unit-tested credential-free in `launch-tunnel.test.ts`, so
  what is fenced is the **transport**, not the **judgment**.

- **UC2 launch lifecycle over loopback (#66)** — `launch-lifecycle.test.ts` is the **hermetic skeleton**
  the tunnel oracle above graduates, in the posture every other oracle here already holds
  (`multi-session-harness` #20 → the UC1 tunnel oracle; `one-session-harness` → the live-worker oracle).
  It pins, over the **real** HTTP legs and with **no tunnel at all**, the one composition the fenced
  oracle's judgment rests on and that nothing else pinned: launch → born `registering` → the §2
  registration at the launched cwd **claims** it → the row advances **in place**, same id, no second
  row. (`pending-launch.test.ts` pins `claimPendingLaunch` as a **pure function**, called directly;
  `web-ui-launch-flow.test.ts` pins the launch and the born row — neither drives the claim over HTTP.)
  Its **negative control** — a registration from a _different_ directory must **not** claim, and mints
  its own id as the UC1 attach it is — is what keeps the positive non-vacuous. This is the
  `probeStandInLiveness` (#134) **self-guard** posture: prove the composition works with nothing in the
  way, so a fenced `drift` reads as "the tunnel leg broke it" rather than "the harness was never
  right" — a distinction that otherwise only surfaces on an operator's tailnet, where no CI is
  watching. Hermetic (loopback, fake launcher, no credentials), so it gates on **every** run; it
  deliberately makes **no** claim about AC3, which is the fenced oracle's alone.

- **The AC-5 assertion inside the full-flow release gate (#67, traces E2E-B-002)** —
  `full-flow-gate.ts` is the fenced, self-classifying **release gate**
  [`docs/security-posture.md`](../../docs/security-posture.md) names as the hard gate before any
  real-worker rollout. The hermetic skeleton above proves the split for **one** session over
  loopback, in isolation; this runs the same guarantee inside the flow a release actually ships —
  **two concurrent sessions plus one launched from the phone**, multiplexed through one daemon,
  over a **real tunnel** — and asserts it **per session**. Per-session is the whole point: an
  **aggregate** "did inference reach Anthropic?" stays green while one session is quietly proxied
  through the local control plane, because its siblings' honest traffic answers for it — the one
  question the one-session slice structurally cannot ask.
  `assertEverySessionInferenceUntouched` (in `inference-guarantee.ts`) encodes it by **delegating**
  to `assertInferenceUntouched` — the single definition of the bidirectional claim, which is what
  fails the gate on a redirect (AC-3) — and adding one clause of its own: **every carried session
  has its own observed turn reaching `api.anthropic.com`** (AC-2), naming any that does not.
  **AC-1 ("runs as part of the gate, not a separate optional check") is structural, not a
  convention**: `classifyFullFlowGate` cannot return `verified` unless the assertion demonstrably
  ran across the flow's own carried sessions — enforced by the **inconclusive gap checks** (a
  capture with nothing observed, or with fewer than two concurrent sessions, is `inconclusive`
  before the verified path is reachable, and each of those gaps is at least as strict as a
  condition under which the assertion is skipped, so passing them entails the assertion having run).
  `assertedSessionIds` is the **receipt** of that property — it names the sessions actually covered,
  so a caller can check rather than trust — not the thing imposing it.
  **Attribution stays receiver-of-record**: a turn carries its session marker outbound, and the
  observation's session is read back off **the stand-in's own log** — never echoed from the
  caller's variable. That asymmetry is load-bearing rather than stylistic: a leg the stand-in never
  took has no record to read, so a **redirected turn yields no attribution and can never vouch for
  its own session**. Were the marker echoed from the sender, the gate would pass by construction on
  a real leak. The negative reads are self-guarded by the liveness canary (#134).
  **Scope**: this gate judges the **inference split**, not UC1/UC2 — their correctness belongs to
  their own oracles (#65/#66) and re-classifying it here would be a second, drifting copy; here
  those legs are the **context** the assertion must run in, and a flow that never came up is an
  `inconclusive` precondition gap, not a UC1 failure re-reported.
  **Fenced / opt-in** on `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE` (`resolveTunnelE2EEnv`, **reused** from
  #65 — the same single real tailnet), so it lives outside the credential-free CI `e2e` lane;
  `full-flow-gate.e2e.test.ts` drives it. What is fenced is the **transport**, not the judgment:
  the classifier and the per-session assertion are unit-tested credential-free in
  `full-flow-gate.test.ts` + `inference-guarantee.test.ts`. Its loopback skeleton is
  `full-flow-inference.test.ts`.

- **The multi-session inference composition over loopback (#67)** — `full-flow-inference.test.ts`
  is the **hermetic skeleton** the gate above graduates, in the posture every other oracle here
  holds (`multi-session-harness` #20 → #65; `launch-lifecycle.test.ts` → #66). It pins, over the
  **real** HTTP legs and with **no tunnel at all**, the one composition the fenced gate's judgment
  rests on and that nothing else pinned: that several concurrent sessions each performing a model
  turn yield **per-session, receiver-grounded** attribution surviving a real round-trip, and that a
  redirect of **one session among several** is caught. (`inference-guarantee.test.ts` pins the
  assertion as a **pure function** over constructed observations; `inference-untouched.e2e.test.ts`
  drives real traffic but for exactly **one** session, with no attribution at all.) Its **negative
  controls** — a really-redirected session among honest siblings, and a turn the stand-in never
  took yielding **no** attribution — are what keep the positive non-vacuous. This is the
  `probeStandInLiveness` (#134) **self-guard** posture: prove the composition works with nothing in
  the way, so a fenced `drift` reads as "the tunnel leg broke it" rather than "the harness was
  never right" — a distinction that otherwise only surfaces on an operator's tailnet, where no CI
  is watching. Hermetic (loopback, stand-in workers, no credentials), so it gates on **every** run;
  it deliberately makes **no** claim about the real tunnel, which is the fenced gate's alone.

## What is fenced to the credentialed wave

- The **live-worker oracle** above is wired but **fenced** — it runs only when
  `CCCTL_E2E` / `CCCTL_SDK_URL` / `ANTHROPIC_API_KEY` are set (turbo passes them through
  to `test:e2e`). The remaining forward-looking piece is the concrete **patched-worker
  launch contract** (`PatchedWorkerLauncher` / `spawnPatchedWorker`): the repo ships no
  packaged patched worker yet (#71 wired the `ccctl serve` daemon + `patch`/`tunnel` verbs,
  but packaging a patched worker is a later wave), so the
  default launcher spawns the operator-supplied `CCCTL_SDK_URL` with a documented env
  contract, and any mismatch surfaces **safely** as `inconclusive` rather than a fake
  green. The launcher is injectable, so that contract can firm up when the patched-worker
  packaging lands with no churn to the oracle. The hermetic `one-session-harness` is the
  skeleton the live oracle graduates from.

- The **multi-session tunnel oracle** above is likewise wired but **fenced** — it runs only
  when `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE` are set (turbo passes them through to `test:e2e`)
  and a real, authenticated tailnet is present on the box (`TailscaleTunnel.establish` refuses
  otherwise — mandatory tunnel-auth). Its infra prerequisite is a live tailnet rather than a
  patched worker + API key, so it carries its own arm distinct from the live-worker oracle's;
  an absent tailnet surfaces **safely** as `inconclusive`, never a fake green. The hermetic
  `multi-session-harness` (#20) is the loopback skeleton it graduates to a real tunnel.

- The **full-flow release gate** (#67) shares that same arm (`CCCTL_E2E` + `CCCTL_E2E_TAILSCALE`) and
  the same single prerequisite — one real, authenticated tailnet — so it reuses the UC1 oracle's
  fence rather than carrying a third copy. Its workers, session launcher, and `api.anthropic.com`
  itself are **stand-ins**, for the reason named in the live-worker bullet above: the repo ships no
  packaged patched worker. So the gate proves the **split and the assertion's integration across a
  real multi-session flow**; it does **not** yet prove a real patched worker's real egress against
  the real host. That last leg is the credentialed wave's, and
  [`docs/security-posture.md`](../../docs/security-posture.md) stays **PARTIAL** until it lands —
  landing #67 wires the gate, it does not on its own authorize a real-credential rollout. When the
  patched-worker packaging lands, the stand-in worker + the Anthropic stand-in are the seams to
  swap; the gate's fence, classifier and ACs need no churn.

- The **UC2 launch tunnel oracle** above shares that same arm (`CCCTL_E2E` + `CCCTL_E2E_TAILSCALE`)
  and the same single infra prerequisite — one real, authenticated tailnet — so it reuses the UC1
  oracle's fence rather than carrying a second copy of it. Its **launcher** is a stand-in for the
  reason named in the live-worker bullet above: the repo ships no packaged patched worker, so a real
  tmux/pty surface would open a terminal running nothing that could ever register over §2, and AC2
  ("the launched session registers") would be an unreachable `inconclusive` on every run rather than a
  tested claim. The real backend's own surface + FD-residual behavior is #68's; the tmux (#29) and
  owned-pty (#30) backends are unit-proven in [`@ccctl/server`](../server). When the patched-worker
  packaging lands, the stand-in launcher is the one seam to swap — the oracle's fence, classifier and
  ACs need no churn. Its loopback skeleton is `launch-lifecycle.test.ts`.

## Running

- `pnpm --filter @ccctl/e2e test` — unit specs (`src/*.test.ts`).
- `pnpm --filter @ccctl/e2e test:e2e` — end-to-end specs (`src/*.e2e.test.ts`),
  run serially. The wired skeleton is self-contained (loopback only); the
  later real specs will gate on their own env.
