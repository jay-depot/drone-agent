---
tags: [decision]
related: [plugin-system.md, DronePlugin.md]
---

# ADR 002: Everything-Is-a-Plugin Architecture

**Status**: Accepted (2026-06-18)

## Context

The agent needed an extensibility model. Options included: hardcoded features, MCP-only extensions, or a plugin system.

## Decision

Everything is a plugin. Each plugin implements `DronePlugin` with a `register(registration)` function.

## Rationale

- **Minimalist core**: The agent should work with almost nothing enabled. Plugins add functionality.
- **Uniform interface**: Tools, prompts, workflows, slash commands, capabilities, and hooks all use the same registration pattern
- **Dynamic enabling**: Plugins can be enabled mid-session without restart
- **Testability**: Plugins can be tested in isolation with mock registrations
- **Replaceability**: Any built-in plugin can be replaced with a custom one

## Consequences

- The plugin engine (`runtime/plugin-engine.ts`) manages all plugin lifecycle
- Built-in plugins are listed in `src/plugins/index.ts`
- Plugins can depend on each other via capabilities
- The `--plugin` CLI flag enables plugins for the current session

## Related

- [[plugin-system]] — Plugin architecture
- [[entities/DronePlugin]] — Plugin interface
