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
  ships no packaged patched worker (see below) — the real backend's surface + FD residual is the
  **real-pty handle-residual oracle's** (#68, below).
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

- **The real `node-pty` handle residual (#68, traces E2E-B-003)** — `pty-handle-residual.ts` is the
  fenced, self-classifying oracle for the one thing every stand-in launcher above defers: that a
  session launched onto the **real** owned-pty backend (#30) leaves **no residual** — no orphaned
  child, no leaked pty file descriptor. `@ccctl/server`'s backend puts its one impure edge behind an
  injectable `PtySpawner` and is unit-proven against an **in-memory fake pty** (its own suite says so),
  which proves the **orchestration** — kill → escalate → reap → idempotent close — but structurally
  **cannot** prove that orchestration's promise against the **real native binding**: "the pty fd is
  released and the child is reaped" is a claim about the **operating system**, and a fake `kill()`
  firing a synthetic `onExit` only ever proves the backend _believes_ it. This drives the real binding
  through the daemon's own launch ingress (`POST /api/sessions`, the phone's own body from the **real**
  [`@ccctl/web-ui`](../web-ui) `launchRequest`) and asks the **kernel**: `process.kill(pid, 0)` for the
  child, `fstat(fd)` for the pty **master** descriptor the real handle exposes. **`ESRCH` is proof of
  REAPING, not merely of exit — and that is the whole point**: a child that exited but was never reaped
  is a **zombie**, and a zombie still answers `kill(pid, 0)`. An oracle asserting only "the child
  stopped running" would pass a daemon that leaks one per session. Then it **self-classifies**:
  `verified` (the kernel saw a live child + an open pty-master **character device** at launch, and —
  after the daemon's **own** shutdown teardown — an `EBADF` fd and an `ESRCH` child), `drift` (a
  residual was **observed**; the run **fails**, naming the check), or `inconclusive` (the binding could
  not load or could not spawn — **runtime-skip**, never a fabricated green). **A recycled fd number is
  not a leak**: POSIX hands out the lowest free descriptor, so each reading records the fd's
  **identity** (`dev:rdev:ino`) and a leak is declared only when the descriptor is still open **and**
  still points at the **same object** — a bare "is fd 12 open?" would fail a faithful daemon the moment
  it reused the number. What is **real**: the binding, the pty, the child, the master fd, the launch
  ingress, the pending-launch bookkeeping, the registry, the launcher's whole close/kill/reap
  orchestration, and the daemon's real shutdown path. What is a **stand-in**: only the **worker** the
  pty runs (`/bin/sh -c 'exec sleep 30'`) — the repo ships no packaged patched worker, and #68 needs
  none: its ACs are about the **FD residual**, not registration (that is #66's claim, proven by its own
  oracle), and the backend's own `WorkerCommandFactory` seam exists precisely because it "asserts
  NOTHING about the patched-claude CLI; it owns only the pty orchestration". It is **self-guarded** in
  the `probeStandInLiveness` (#134) posture, and here the guard is **empirical, not merely logical**: a
  **negative control** wires the same real backend with its teardown **disabled** and asserts the same
  probe, on the same box, **does** report `drift` — naming both the stranded child and the leaked fd.
  Without it, a probe that always read `ESRCH`/`EBADF` because it was asking wrongly would make the
  positive green for the worst possible reason while every unit test still passed. **Fenced / opt-in**
  on its **own** arm — `CCCTL_E2E` + `CCCTL_E2E_PTY` (`resolvePtyE2EEnv`) — because the prerequisite is
  neither a tailnet nor an API key but a real, **spawn-capable** node-pty (see below).
  `pty-handle-residual.e2e.test.ts` drives it; the fence, the tri-state classifier (the Tier-A encoding
  of #68's two ACs) **and the OS probe's own semantics** are unit-tested credential-free in
  `pty-handle-residual.test.ts` — a live pid, a reaped pid, an open fd, a closed fd and a character
  device are all obtainable without a pty, so what is fenced is the **binding**, not the **judgment**.

- **The long-run daemon soak (#69, traces E2E-B-003)** — `daemon-soak.ts` is the self-classifying
  oracle for the one question every other oracle here structurally **cannot** ask. Each of them judges
  **one pass** — does the flow work (#20/#65/#66), is the split honest (#67/#18), does the launched pty
  leave a residual (#68) — and a leak of **one handle per session lifecycle passes all of them**: one
  pass leaks one handle, nothing notices, every assertion is green. It is visible only as an
  **accumulation**, and only something that runs the lifecycle many times over can see it. So this keeps
  **one daemon UP** for the whole run (`close()` is never called on it — that is #68's whole-daemon
  teardown, a different claim), drives repeated session lifecycles against it through its own ingress —
  launch (`POST /api/sessions`, the phone's own `launchRequest` body) → **§2 claim** → the worker holds
  its **§4/§5 downstream** open → stop (`POST …/stop`, the phone's own `stopRequest`) — and reads
  **#63's own FD/handle diagnostics** (`captureHandleReport`) between cycles. Driving the downstream is
  not optional depth but the cycle's only **ref'd-resource leg** — the one resource whose release this
  oracle can measure at all (`daemon-soak.ts`'s module doc carries the why).
  **What it can see is exactly what #63's endpoint answers, and no more** — `process.getActiveResourcesInfo()`
  reports the libuv resources **keeping the event loop alive**. Probed rather than assumed (and pinned as
  tests, so the boundary cannot silently drift): a ref'd `setInterval` **is** counted and a leaked socket
  **is** counted, but an **unref'd handle is not**, and **a bare file descriptor is not** — 64 of them
  move the tally not at all.
  **The consequence is a scope boundary worth reading before trusting this oracle**: every one of the
  daemon's per-session timers — pending-launch eviction (#33), worker liveness (#166), session eviction
  (#173), idle (#41), close-timeout, pty kill escalation (#76) — calls `.unref()` on the very next
  statement after it is armed, so **a leaked one is invisible here**. Measured, not reasoned: 22 full lifecycles driven to downstream-open depth put no
  `Timeout` in the tally at all; a real run's settled reading is
  `{ PipeWrap: 4, TCPServerWrap: 1, TCPSocketWrap: 3 }`. So what this soak watches is the **ref'd
  remainder — the sockets and pipes** (a
  stranded downstream or event-relay socket climbs here), plus, via the `maxSessions: 1` skeleton, the
  registry row itself. Stated plainly: **#68 owns the per-fd question** (`fstat`, per-fd), **this owns
  the ref'd-libuv tally**, and **#238's timer census owns the daemon's unref'd timers** — closed where it
  belonged, by widening #63's own diagnostics (`installTimerCensus`, an `async_hooks` census reported
  alongside the ref'd tally) rather than by this spec routing around it. This soak still reads only
  `captureHandleReport`, so every boundary above is unchanged; wiring the census in here would widen what
  the soak asks, which is #69's own call.
  **Two detectors, both AC2's own words.** _The count returns to baseline_ — checked on the **total**
  and **per type**, because a total alone is **maskable** (a leaked resource while a pooled socket
  happens to close nets to zero and reads clean); per-type is #63's own stated design intent. And _no
  monotonic growth_ — the **slow-leak** detector: the series never comes back **down** and ends higher
  than it started. It earns its place as the only detector with **no tolerance**, so it catches a leak
  of one handle every five lifecycles (`8,8,8,8,9,9,9,9` — never more than +1 over baseline, so the
  first detector is silent). That it does not flake is **measured**: 20 consecutive settled cycles
  against a real daemon read `8` every time, `byType` identical — zero jitter, so any climb that never
  reverses is signal. (Why the predicate is non-decreasing-and-net-up rather than strictly increasing,
  and the false-positive class that buys, is `isMonotonicGrowth`'s own doc.)
  **AC1's "multiple days" is the operator's lever, and the verdict never lies about it**: the `SoakPlan`
  carries both axes AC1 names (`cycles` and `durationMs`), the drive **paces** its cycles across the
  declared span, `classifyDaemonSoak` **refuses to verify a soak that fell short of the plan it was
  handed**, and every report states the span it **actually** achieved plus an explicit `spannedMultiDay`
  — so a compressed run can never be read as a multi-day claim it did not buy.
  **Fenced / opt-in** on its own arm — `CCCTL_E2E` + `CCCTL_E2E_SOAK` (`resolveSoakE2EEnv`) — but the
  fence sits somewhere different from every sibling's, because the prerequisite is **time, not
  infrastructure**. What the arm buys is the **span alone**: the compressed soak against a **real**
  daemon, its **negative control**, the classifier **and even the drive's own mechanics** (warmup /
  pacing / settling, over an injected clock and sampler) are all credential-free and gate **every** `test`
  run — `daemon-soak-lifecycle.test.ts` + `daemon-soak.test.ts`. It is **self-guarded** in the
  `probeStandInLiveness` (#134) posture, and here the guard is **empirical**: a negative control wires
  the same real daemon to a launcher that strands **one ref'd handle per session** and asserts the same
  probe, on the same box, **does** report `drift` — naming both detectors and the type that climbed.
  Only the **handle** is wrong: unlike #68's control, this one's surface still tears down **correctly**
  (disabling `close()` here would yield `inconclusive` on a broken stop rather than `drift` on a leak —
  a different finding wearing the same red; `createLeakingSoakLauncher`'s doc carries the why), which is
  also the truer model of a slow leak — everything visible works, and the count climbs anyway.

- **The teardown-timing residual (#70, traces E2E-B-003)** — `teardown-timing-residual.ts` is the
  fenced, self-classifying oracle for the gap its two siblings leave **between** them. Each of W7's
  three residual specs traces E2E-B-003 and owns a different question: **#68 owns the per-fd question**
  (`fstat` on the pty master, `kill(pid, 0)` on the child) — but asks it **once**, **unpressured** (a
  full `/api/sessions` round-trip sits between its launch and its teardown), over the **whole-daemon
  shutdown** path; **#69 owns the ref'd-libuv tally** — many lifecycles, but deliberately **paced**, and
  structurally **fd-blind** (#63's sampler counts the resources keeping the loop alive, and a bare
  descriptor is not one — `daemon-soak.ts`'s own module doc: "A raw fd leak is invisible HERE, and is
  exactly what #68's oracle asks the kernel about directly"). So a handle that lingers **only when teardown is raced**
  is unasked by the first and unseeable by the second. That intersection — **the per-fd question, asked
  N times, under pressure** — is this oracle's, and is the whole of what it claims.
  **The stop path is FORCED by AC1, not chosen** — and it is the genuinely timing-sensitive one. "Rapid
  launch/teardown cycles" needs a teardown a drive can repeat against one live daemon; the server has
  three and two are unavailable by construction (shutdown is **terminal**; the ghost-reaper is a
  **timer**). That leaves the emergency stop (#76) — which is also, by the server's **own** docs, the
  only `close()` caller carrying a **deadline** ("the first `close()` caller with anyone waiting on it")
  and the one whose abandoned close leaves the owned pty latched `closed` so "every later `close()` on
  that handle returns instantly — **cheerfully, and to a still-running child**". That sentence is a
  handle/teardown-timing hazard the server names in its own words; this is the runtime check that the
  class stays closed.
  **The stop buys a sharper claim than #68's, and the drive is built on it**: #68 must **poll** for
  convergence because shutdown's release is fire-and-forget (`void releaseLaunchedSession`); a stop is
  **awaited** end to end, down to the pty's `await reaped`, so when its `200` lands the reaping has
  **already** happened. The settle window is correspondingly short. It is also why this oracle needs no
  copy of #68's computed sleep floor: a child that died by some **other** hand makes the daemon report
  `already-exited` rather than `stopped`, so the confound arrives as an **observation** filed as a gap
  rather than passing as a green.
  **Two self-guards, because it asserts two absences.** The readings must **disagree** per cycle —
  present at launch, gone after the stop (#68's guard, and its reason). And **the pressure is itself a
  claim under test**, which #68 had no need of: a run that drove its cycles slowly, or fewer than
  planned, or **none at all**, would verify a claim it never bought. So the plan is declared, the
  launch→stop gap is **measured**, and the classifier **refuses to verify a run that fell short of
  either axis** — the discipline #69 applies to its own span, applied to these axes — a zero-cycle run is
  `inconclusive`, never `verified`. The gap ceiling exists even though the drive dispatches the stop on
  the very next statement, and not to measure the daemon: it is a tripwire on **this oracle's own
  honesty**, because a settling sleep introduced later would void the pressure it is named for while the
  run stayed **green**.
  **Fenced / opt-in on #68's arm** — `CCCTL_E2E` + `CCCTL_E2E_PTY`, **shared** deliberately (see the arm
  table). It is **self-guarded** in the `probeStandInLiveness` (#134) posture, and here the guard is
  **empirical**: a negative control wires the same real backend with its teardown **disabled** and
  asserts the same probe, on the same box, **does** report `drift` — naming the stranded child, the
  leaked fd, **and** the server's own #76 post-close re-read refusing to report a stop that did not
  happen. `teardown-timing-residual.e2e.test.ts` drives it; the fence, the tri-state classifier (the
  Tier-A encoding of #70's two ACs) **and the drive's own pressure mechanics** are unit-tested
  credential-free in `teardown-timing-residual.test.ts` — a stand-in daemon answering the two ingresses
  is twenty lines of `node:http`, and a live pid plus a real character device need no pty — so what is
  fenced is the **binding**, not the **judgment**.

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
  tested claim. The real backend's own surface + FD-residual behavior is the **real-pty handle-residual
  oracle's** (#68, its own bullet below); the tmux (#29) and owned-pty (#30) backends are unit-proven
  in [`@ccctl/server`](../server). When the patched-worker packaging lands, the stand-in launcher is
  the one seam to swap — the oracle's fence, classifier and ACs need no churn. Its loopback skeleton is
  `launch-lifecycle.test.ts`.

- The **real-pty handle-residual oracle** (#68) carries its **own** arm — `CCCTL_E2E` +
  `CCCTL_E2E_PTY` — rather than reusing the tunnel or live-worker ones, because its prerequisite is a
  genuinely different piece of infrastructure: a `node-pty` native binding that both **loads** and can
  **spawn**. Folding it into an existing arm would make a box with a tailnet claim a pty it may not
  have, and make the absence of one look like a tunnel failure.

    **A default checkout cannot spawn a pty, on any platform** — and the reason differs per platform,
    with a different lever each, which is what makes the arming step non-obvious. That causal account
    has exactly **one** home: `src/pty-handle-residual.ts`'s module doc, § _"Fenced / opt-in, on its
    OWN arm"_. It is deliberately **not** restated here — the duplication was the defect generator
    (#235), and `src/pty-chain-census.ts` now fails the `test` lane if any file other than the
    canonical one restates it.

    So the oracle **cannot** run on a default checkout, CI included — which is exactly why it must never
    sit in the credential-free lane. To arm it, **don't hand-apply a lever from memory** — run the
    preflight. It probes this box (resolving the real binding, reading the real mode bit) and prints
    the lever your platform actually needs, exiting non-zero until it is armed:

    ```sh
    pnpm --filter @ccctl/e2e arm:pty

    CCCTL_E2E=1 CCCTL_E2E_PTY=1 pnpm --filter @ccctl/e2e test:e2e
    ```

    When the arm is set but the binding still cannot spawn, the drive self-classifies `inconclusive` —
    naming the typed failure the daemon itself reported (`backend-unavailable` / `spawn-failed`) — and
    the spec `ctx.skip`s with that reason rather than faking a green. **That is the safe behavior, but
    it does mean a mis-armed run reports green-with-a-skip**: if you armed the oracle deliberately, read
    the skip reason. An `inconclusive` naming `spawn-failed` is **usually** the missing `chmod` — but
    `spawn-failed` is the daemon's honest catch-all for a spawn throw it cannot classify structurally
    (`session-launcher.ts`), so it names the symptom and not the cause; check the mode bit rather than
    assume. What it never means is that the daemon is fine.

## Running

- `pnpm --filter @ccctl/e2e test` — unit specs (`src/*.test.ts`).
- `pnpm --filter @ccctl/e2e test:e2e` — end-to-end specs (`src/*.e2e.test.ts`),
  run serially. The wired skeleton is self-contained (loopback only); the
  later real specs will gate on their own env.

The fenced oracles each gate on their own arm and **skip** when it is absent, so the commands above
stay green on a bare checkout. To arm one, set its vars (turbo passes them through to `test:e2e`):

| Oracle                                   | Arm                                                 | Infra prerequisite                                                        |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Live-worker (#133)                       | `CCCTL_E2E` + `CCCTL_SDK_URL` + `ANTHROPIC_API_KEY` | a patched worker + API credentials                                        |
| UC1 / UC2 / full-flow gate (#65/#66/#67) | `CCCTL_E2E` + `CCCTL_E2E_TAILSCALE`                 | one real, authenticated tailnet                                           |
| Real-pty handle residual (#68)           | `CCCTL_E2E` + `CCCTL_E2E_PTY`                       | a **spawn-capable** `node-pty` (see above — a default checkout has none)  |
| Long-run daemon soak (#69)               | `CCCTL_E2E` + `CCCTL_E2E_SOAK`                      | **none — only time** (see below: the arm buys the span, not the judgment) |
| Teardown-timing residual (#70)           | `CCCTL_E2E` + `CCCTL_E2E_PTY` — **#68's arm**       | the same **spawn-capable** `node-pty`; nothing further (see below)        |

The teardown-timing residual (#70) is the one row that **shares** another oracle's arm, and it is the
same principle the rest of the table follows rather than an exception to it: an arm names a
**prerequisite**, not a spec. Its prerequisite is not merely similar to #68's, it is **identical** — a
real, spawn-capable `node-pty` and nothing else — so a third variable would gate nothing the second does
not already gate, while making an operator who armed the pty oracle silently skip this one for no
infrastructural reason. Its cycle count is an operator lever (`CCCTL_E2E_TIMING_CYCLES`, default 12);
the gap ceiling deliberately is **not** one, because a knob that raised it would only switch off the
guard it exists to be.

The soak (#69) is the one row whose prerequisite is not infrastructure. Armed with no plan it runs a
real but **compressed** soak in seconds, and the verdict says so rather than implying otherwise. To soak
for the **multiple days** its AC1 names, buy the span:

```sh
# A real multi-day soak: 2000 session lifecycles paced across 48h against one long-running daemon.
CCCTL_E2E=1 CCCTL_E2E_SOAK=1 \
CCCTL_E2E_SOAK_CYCLES=2000 CCCTL_E2E_SOAK_DURATION_MS=172800000 \
pnpm --filter @ccctl/e2e test:e2e
```

The spec's own timeout is **computed from the plan** rather than fixed, so a multi-day arming is not
killed by the e2e lane's 120s default before it can answer. A soak that is cut short of the plan it was
handed self-classifies `inconclusive` — it cannot report "no leak over a long run" when it did not have
one.
