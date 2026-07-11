---
type: architecture-decision-record
number: 1
title: "Register-response wire casing: snake_case with an explicit boundary DTO"
date: 2026-07-11
status: approved
decision_makers: [ccctl maintainer]
council_decision: D2
related_issues: [106, 108]
impact: medium
---

# ADR-001: Register-response wire casing — snake_case with an explicit boundary DTO

## Status

**Approved** — 2026-07-11. Implemented by [#108] (golden/contract test + boundary DTO).

## Decision Makers

- ccctl maintainer, ratifying council decision **D2** (issue [#106]).

## Context

`@ccctl/server` accepts a patched Claude Code worker's session registration —
`POST /v1/code/sessions` (`SESSIONS_CREATE_PATH`) — and answers with the new
session id plus the WebSocket URL the worker opens its worker-channel to. Two
casings are in tension for that response body:

- **camelCase `{ sessionId, wsUrl }`** — matches `@ccctl/core`'s `RegisterResponse`
  interface (`packages/core/src/index.ts`), and is what `@ccctl/server` currently
  serializes.
- **snake_case `{ session_id, ws_url }`** — matches the protocol prose that runs
  through the same code: core's and the server's docstrings, and the
  `bridge-protocol.test.ts` test titles, all speak `session_id` / `ws_url`.

The register response is **not** an internal ccctl surface. It is exchanged with
Claude Code's own Agent-SDK `stream-json` (`--sdk-url`) control transport — a
**foreign-owned, build-specific contract**. `@ccctl/core` is "the hub" for ccctl's
_internal_ shared model, but "core is the hub" does not govern the _bytes on a
foreign wire_. What casing the worker will emit/expect is therefore an **empirical
question about a real, shipping transport**, not a style preference ccctl is free to
settle by internal convention.

This record answers that empirical question, then fixes the resulting policy.

## Evidence

Primary source: the installed `@anthropic-ai/claude-agent-sdk` **0.1.44** (files dated
2025-11-18) and `@anthropic-ai/claude-code` **1.0.128** (files dated 2025-10-29)
packages, inspected under `~/.npm/_npx/.../node_modules/@anthropic-ai/` on 2026-07-11.

**(1) The session id is `session_id` (snake_case) on every message.** In
`claude-agent-sdk/sdk.d.ts`, every member of the `SDKMessage` union
(`SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKSystemMessage`, …)
carries `session_id: string`. There is **no `sessionId`** anywhere in the wire
message types. Other protocol scalars are likewise snake_case: `parent_tool_use_id`,
`duration_ms`, `is_error`, `num_turns`, `total_cost_usd`, `permission_denials`,
`tool_use_id`, `claude_code_version`, `mcp_servers`, `slash_commands`. Hook payloads
written to hook stdin (`BaseHookInput` and friends) are entirely snake_case
(`session_id`, `transcript_path`, `permission_mode`, `hook_event_name`, `tool_name`,
`tool_input`, `tool_use_id`).

**(2) The control-protocol framing is snake_case.** In `claude-agent-sdk/sdk.mjs`,
control frames are constructed as two newline-delimited objects:

```text
{ "request_id": "…", "type": "control_request", "request": { "subtype": "…" } }
{ "type": "control_response", "response": { "subtype": "success", "request_id": "…" } }
```

with `server_name` for MCP routing and the message types `control_request` /
`control_response` / `control_cancel_request` / `keep_alive`. Every field is
snake_case.

**(3) `--sdk-url` streams those same frames over a WebSocket.** In
`claude-code/cli.js`, the flag is described as _"Use remote WebSocket endpoint for SDK
I/O streaming (only with -p and stream-json format)"_ and selects a WebSocket
transport in place of stdio:

```text
sdkUrl ? new WSTransport(sdkUrl, …) : new StdioTransport(…)
```

(the two constructors are minified in the bundle as `s_0` / `jF1`; the descriptive
names are this record's gloss). So the `--sdk-url` control transport carries the
identical snake_case `stream-json` frames from (1) and (2).

**(4) The register endpoint itself is a ccctl invention — modeled on an Anthropic REST
noun that is also snake_case-bodied.** The stock CLI has no `/v1/code/sessions` route
and no `ws_url` / `wsUrl` field; its only `code/sessions` reference is Anthropic's
cloud REST endpoint `${BASE_API_URL}/api/oauth/organizations/{org}/code/sessions`.
Anthropic's public REST house style (the Messages API: `stop_reason`, `input_tokens`,
…) is snake_case JSON bodies. So the endpoint ccctl's register handshake mirrors is
snake-cased too.

The only camelCase fields observed anywhere in the transport are a small set of
config/enum-bridge fields — `apiKeySource`, `permissionMode`, `modelUsage`,
`isAuthenticating` — never a protocol scalar like an id, URL, timestamp, or count.

**Convergent conclusion:** across the stream-json messages, the control-frame
envelope, hook I/O, and the mirrored REST noun, the transport's convention is
**snake_case**, and the session identifier specifically is **universally
`session_id`**.

## Decision

**(1) The register response is snake_case on the wire:**

```json
{ "session_id": "…", "ws_url": "…" }
```

**(2) `@ccctl/core`'s `RegisterResponse` stays camelCase** (`{ sessionId, wsUrl }`).
The hub model is not bent to a foreign wire; internal consumers keep idiomatic
TypeScript casing.

**(3) An explicit boundary DTO / mapper at the server HTTP edge is REQUIRED** — it is
the single, testable seam that serializes core's camelCase `RegisterResponse` into the
snake_case wire body. A golden/contract test pins the exact serialized bytes so any
drift fails CI ("fail closed on drift"). The DTO and golden test are implemented by
[#108]; this record is the decision they consume.

## Alternatives Considered

**camelCase on the wire `{ sessionId, wsUrl }`** (what the server emits today).

- **Pros**: byte-identical to core; no mapper; nothing to write in [#108].
- **Cons**: contradicts the transport's established convention — most sharply on the
  very field the response is built around, where the transport is universally
  `session_id`. The camelCase precedents in Claude Code (`permissionMode`,
  `apiKeySource`) are config/enum-bridge fields, not protocol scalars, so they do not
  license a camelCase id/URL.
- **Why rejected**: a foreign transport dictates its own casing; matching core's
  internal convention on a foreign wire optimizes the wrong side of the boundary.

**snake_case on the wire AND bend core to snake_case** (`RegisterResponse =
{ session_id, ws_url }`, no DTO).

- **Pros**: one casing end to end; no mapper.
- **Cons**: bends the hub to a foreign wire (violates "core is the hub"); couples every
  internal core consumer to foreign casing; removes the single testable seam, so a
  future wire change ripples through core instead of touching one mapper.
- **Why rejected**: gives up the insulation the DTO exists to provide, for a saving
  ([#108]'s mapper) that is trivial.

**Defer entirely — record no wire target, pure "provisional"** (the fallback the issue
pre-authorized if casing could not be established).

- **Pros**: commits to nothing before the worker exists.
- **Cons**: discards grounded, primary-source evidence we do have, and leaves [#108]
  without a target to pin.
- **Why rejected**: the DTO already delivers the _safety_ of provisionality (a one-line
  change if the worker surprises us), so there is no need to also defer the
  _direction_. Decide the direction on the evidence; keep the seam for the residual.

## Consequences

### Positive

- The wire contract matches the transport it actually speaks to, on grounded evidence
  rather than internal preference.
- Core stays idiomatic camelCase; internal consumers are unaffected.
- One explicit, golden-tested seam (the DTO) owns the whole camel↔snake concern; the
  zero-consumer moment ([#108] lands before any worker parses the response) makes
  pinning free now and prevents a later breaking change.
- If the not-yet-built worker turns out to expect a different shape, the change is one
  line in the mapper plus one golden-file update — core and its consumers do not move.

### Negative

- A deliberate camelCase(core) ↔ snake_case(wire) asymmetry now exists. It must be
  documented at the seam so a future reader does not "fix" it as a bug (the golden test
  is that documentation, enforced).
- A DTO + golden test to author and maintain (scoped to [#108]).

### Risks

- **The real worker patch does not exist yet**, so its exact register schema is not yet
  pinned by a running implementation. _Mitigation_: the decision is scoped to the
  casing _convention_ (HIGH confidence, primary-source), and the DTO + golden test
  localize any residual schema surprise to a single seam. Residual risk: low.

## Confidence and provisionality

- **Casing convention — HIGH / grounded.** Established from primary-source SDK/CLI
  inspection (the Evidence section), convergent across four independent layers.
- **Exact endpoint schema — deferred to the DTO seam.** Finalized when the worker patch
  lands; pinned by [#108]'s golden test; cheaply revised through the mandatory mapper.
  This is why the record is `approved` (the direction is decided with evidence) rather
  than merely provisional — only the endpoint-schema detail, not the casing, is open.

## Related Documents

- Issue [#106] — this decision (council D2).
- Issue [#108] — implementation: golden/contract test + explicit boundary DTO.
- `packages/core/src/index.ts` — `RegisterResponse` (stays camelCase);
  `SESSIONS_CREATE_PATH`; bridge-protocol contract prose.
- `packages/server/src/index.ts` — the register handler that gains the DTO in [#108].
- [`docs/security-posture.md`](../security-posture.md) — the inference/control split the
  register handshake sits within.

[#106]: https://github.com/alexey-pelykh/ccctl/issues/106
[#108]: https://github.com/alexey-pelykh/ccctl/issues/108
