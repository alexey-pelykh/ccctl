# @ccctl/e2e

End-to-end test package for [ccctl](../../README.md) — currently a placeholder.
The target scenario it will exercise: a **patched, headless Claude Code worker →
[`@ccctl/server`](../server) on loopback → SSE to a UI client**, asserting that
**inference still egresses to `api.anthropic.com`**. That last assertion is the
whole point: ccctl steers the control channel but must never proxy or reroute
model traffic — inference and billing stay on Anthropic under the user's own
subscription. Depends on [`@ccctl/cli`](../cli), [`@ccctl/core`](../core), and
[`@ccctl/server`](../server). No harness is wired yet; `src/*.e2e.test.ts` holds
`describe.todo` placeholders.
