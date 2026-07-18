# Decision records

This directory holds `ccctl`'s **Architecture Decision Records (ADRs)** — immutable,
point-in-time records of consequential technical decisions and the evidence and
rationale behind them.

## Conventions

- **Format**: one Markdown file per decision, `adr-NNN-kebab-title.md`, with YAML
  frontmatter (`type`, `number`, `title`, `date`, `status`, `decision_makers`).
- **Numbering**: sequential from `adr-001`, never reused. ADR numbers are their own
  namespace — they do **not** track the `D`-numbers of council deliberations. When a
  decision originates from a council decision, its `D`-id is recorded in frontmatter
  (`council_decision:`) and named in the body, so provenance is preserved without
  coupling the two numbering schemes.
- **Immutability**: a record is a historical artifact. Do not rewrite one to match
  later thinking — supersede it with a new record (`status: superseded`,
  `superseded_by:`) instead. Only status transitions and typo fixes are edited in place.
- **Status vocabulary**: `proposed` → `approved` → (`superseded` | `deprecated`).

Authoring follows the `decision-record-authoring` skill (ADR template, frontmatter
standards, supersession pattern).

## Index

| ADR                                                                | Title                                                                                                                                        | Status                                                                         | Council |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------- |
| [adr-001](adr-001-register-response-wire-casing.md)                | Register-response wire casing: snake_case with an explicit boundary DTO                                                                      | approved                                                                       | D2      |
| [adr-002](adr-002-tailscale-acl-provisioning-model.md)             | Tailscale ACL provisioning: opt-in, additive, non-destructive grants                                                                         | superseded by [adr-004](adr-004-tailscale-acl-grant-lifecycle-from-the-cli.md) | —       |
| [adr-003](adr-003-web-ui-shell-dom-harness.md)                     | Pinning the zero-build web-ui shell: a jsdom harness plus an id contract                                                                     | approved                                                                       | —       |
| [adr-004](adr-004-tailscale-acl-grant-lifecycle-from-the-cli.md)   | Tailscale ACL grants from the CLI: idempotent provisioning, an asserted out-of-process release, a shutdown that does not wait on the API     | approved                                                                       | —       |
| [adr-005](adr-005-askuserquestion-bypass-block-and-hook-role.md)   | Bypass mode blocks on AskUserQuestion and on a PreToolUse `ask`: the hook is native-block + enrich-only, and the worker emits the enrichment | approved                                                                       | —       |
| [adr-006](adr-006-auto-resolves-marker-is-launch-time-not-live.md) | The auto-resolves-permissions marker is launch-time: mid-run mode tracking is deferred, not infeasible                                       | proposed                                                                       | —       |
| [adr-007](adr-007-remove-non-prompting-launch-refusal.md)          | Remove the non-prompting LAUNCH refusal: inform via the marker, do not refuse                                                                | proposed                                                                       | —       |
| [adr-008](adr-008-hook-install-ownership-and-startup-sweep.md)     | Hook-install GC: own each install by its daemon's PID, sweep the unowned at startup                                                          | proposed                                                                       | —       |
