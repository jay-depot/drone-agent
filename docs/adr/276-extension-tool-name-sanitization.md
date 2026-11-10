---
tags:
  [decision, swarm-extension, tool-names, kimi-compatibility, mcp, injection]
related:
  [
    028-tool-name-separator.md,
    075-mcp-tool-name-collisions.md,
    254-swarm-extensions.md,
    modules/drone-agent-plugins.md,
  ]
---

# ADR 276: Sanitize extension capability names into LLM-safe tool names

**Status**: Implemented (2026-11-10, branch `feat/kanban-extension-base`)

## Context

A swarm extension declares capabilities with **dotted** names — `card.move`,
`project.list`, `swarm.session.list`. The dot is the protocol's convention: the
capability name is a caller-chosen stable identifier (ADR
[254](254-swarm-extensions.md)), and `mcp-swarm` uses the same style.

When an extension injects a tool selection, the agent materializes each
capability as an agent tool whose name was built by concatenating the raw
capability:

```
extensions__<extId>__<capability>
  → extensions__drone-swarm-project__card.move
```

That tool name **contains a dot**. ADR [028](028-tool-name-separator.md)
changed drone-agent's canonical separator from `.` to `__` precisely because a
dot inside a tool name breaks the Kimi K2 tool-call parser, which treats the dot
as structural (`functions.{name}:{idx}`) and hallucinates a truncated tool name.

The MCP plugin already closes this hole for MCP tools: it runs each tool name
through `sanitizeToolSegment` (`[^a-zA-Z0-9_-]` → `_`) with a per-server
collision set (ADR [075](075-mcp-tool-name-collisions.md)). The extensions
plugin did **not** — it used the capability verbatim. So every extension that
ships a dotted catalog (which is both reference extensions) exposed dotted tool
names to the model.

## Decision

### D1 — Sanitize at materialization, not at declaration

The capability name keeps its dots. Only the **agent tool name** is sanitized.
The catalog is the protocol's single source of truth and is keyed by the raw
name, so changing capability names would be a protocol-visible break for no
benefit.

### D2 — One shared sanitizer

`sanitizeToolSegment(name, usedNames)` moves to
`drone-agent/src/shared/tool-name.ts` — one home, imported by both the MCP
plugin and the extensions plugin. It replaces every character outside
`[a-zA-Z0-9_-]` with `_`, and appends `_1`, `_2`, … when a sanitized name is
already taken, so two capabilities that sanitize alike (`card.move` and
`card move`) stay distinct instead of one silently overwriting the other.

### D3 — Collision scope is per extension

The `usedNames` set is built per extension id during reconciliation, mirroring
the MCP per-server scope. The canonical name already includes the extension id,
so collisions only matter within one extension's catalog.

### D4 — The proxy call keeps the raw capability

The registered tool name is sanitized; the wire call is not. `execute` still
POSTs to `/coordinator/extensions/<extId>/tools/<raw capability>`, because the
coordinator resolves the schema and dispatches against the manifest, which is
keyed by the raw name.

### D5 — `InjectedToolEntry` records the capability

The entry stores `capability` (the raw name), not `toolName`, so the field
means what it says.

## Consequences

- An extension tool is named `extensions__<extId>__<sanitized>` for example
  `extensions__drone-swarm-project__card_move`. No dot reaches the model.
- `mcp-swarm` and `drone-swarm-project` both become Kimi-safe without a
  capability rename, a migration, or a docs sweep.
- Two capabilities that sanitize to the same segment both remain mountable.
- The sanitizer has one implementation; the MCP plugin's local copy is removed.

## Does not amend

An earlier ADR. It applies ADR [028](028-tool-name-separator.md) to the
extension-tool path and reuses ADR
[075](075-mcp-tool-name-collisions.md)'s collision design.

## Out of scope

- Renaming capability names to underscores. The dots are the protocol
  convention; sanitizing the derived tool name is sufficient.
- Sanitizing the capability name on the wire or in the coordinator manifest.
