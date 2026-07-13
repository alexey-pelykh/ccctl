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

| ADR                                                    | Title                                                                   | Status   | Council |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------- | ------- |
| [adr-001](adr-001-register-response-wire-casing.md)    | Register-response wire casing: snake_case with an explicit boundary DTO | approved | D2      |
| [adr-002](adr-002-tailscale-acl-provisioning-model.md) | Tailscale ACL provisioning: opt-in, additive, non-destructive grants    | approved | —       |
