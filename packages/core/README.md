# @ccctl/core

The hub of [ccctl](../../README.md). Holds the shared domain model that every
other package depends on: the session/state model (`Session`, `SessionStatus`)
and the Claude Code `stream-json` control-channel types (`ControlRequest` /
`ControlResponse` / `ControlEvent`, plus the NDJSON `encodeControlFrame` /
`decodeControlFrame` framing helpers). No runtime dependencies — this is the
contract layer, so `server`, `cli`, and `tunnel-adapters` all resolve their
shared types here rather than redefining them.
