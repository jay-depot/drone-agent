---
tags: [decision, tool-gating, persona]
related: [entities/Persona.md, decisions/002-plugin-system.md, concepts/broker-provider.md, decisions/071-tool-consolidation-batch-2.md]
---

# ADR 030: Default-Hidden Tool Gating

**Summary**: Tools can be marked `defaultHidden: true` in their definition, causing them to be hidden from the LLM unless the active persona explicitly includes them via `allowedTools`. The persona creation wizard auto-excludes these tools from new personas.

## Context

Powerful tools (wiki write, principles store, memory store) were available to the LLM by default, which led to coding and planning agents creating wiki pages when those things should go in project memory. The project's "model-centric" design principle says tools should be available to the LLM, but some tools are too powerful for general use.

## Decision

Add a `defaultHidden?: boolean` field to `DroneToolDefinition` and `DroneToolDescriptor`. The persona plugin's `getFilteredTools()` hides these tools when no persona is active or when a persona has no explicit `allowedTools`. When a persona has explicit `allowedTools`, the persona's patterns take full control — they can re-include hidden tools by explicitly naming them.

The persona creation wizard (`persona__create`) queries the coordinator for the list of `defaultHidden` tools and auto-injects `!<toolName>` exclusion patterns into the new persona's `tools:` frontmatter.

## Consequences

- **Positive**: Default experience is safe — powerful tools are opt-in
- **Positive**: Persona authors explicitly opt into powerful tools via `allowedTools`
- **Positive**: Backward compatible — existing personas without `allowedTools` still see all tools
- **Positive**: The coordinator aggregates tool definitions from all connected agents, so the persona wizard has a complete picture
- **Negative**: User-provided plugins need to be installed on the whole swarm, or their `defaultHidden` tools won't be known to the coordinator

## Implementation

- `DroneToolDefinition.defaultHidden` — added to `drone-core/src/plugin-system.ts`
- `DroneToolDescriptor.defaultHidden` — added to `drone-core/src/session-types.ts`
- Engine propagation — `plugin-engine.ts` `listTools()` includes `defaultHidden`
- Persona filtering — `persona/index.ts` `getFilteredTools()` respects `defaultHidden`
- Built-in tools originally marked: `swarm__wiki_write`, `swarm__wiki_delete`, `self-improvement__insight`, `self-improvement__principles-store`, `self-improvement__principles-delete`, `memory__store`, `memory__delete`. Note: the self-improvement and memory tools were later consolidated in [071-tool-consolidation-batch-2](071-tool-consolidation-batch-2.md) into single action-based tools (`self-improvement__insight`, `self-improvement__principle`, `memory__manage`, `memory__browse`) which are no longer `defaultHidden`. The terminal plugin's 7 tools are the remaining `defaultHidden` tools.
- Tool definitions table in coordinator DB with pre-seeded built-in hidden tools
- Agent pushes tool definitions on connect via `POST /sync/tools/push`
- Coordinator serves `GET /tools/default-hidden` for the persona wizard

## Source

Commits `4e5bbf6` (Phase 1), `d7874bb` (Phase 2), `ed8e4c4` (Phase 3 routes), `ef3945e` (Phase 5 client)
