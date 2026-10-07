---
tags: [decision]
related: [plugin-system.md, DronePlugin.md]
---

# ADR 015: Unified Slash Command Registry

**Status**: Accepted (2026-06-28)

## Context

Built-in slash commands (`/exit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`) were hardcoded in the TUI and CLI, bypassing the engine's slash command system. This created two code paths and prevented plugins from overriding built-in commands.

## Decision

Move all built-in slash commands into the engine's slash command registry with a precedence model: plugin commands have higher precedence than built-in commands, allowing plugins to override them.

## Rationale

- **Philosophy**: Everything should be replaceable by plugins, including core commands
- **Consistency**: Single code path for all slash commands
- **Error handling**: Unrecognized slash commands show an error instead of being sent to the LLM
- **Discoverability**: Unified registry makes `/help` output consistent

## Implementation

- Engine gains `builtInSlashCommands` registry (lower precedence) alongside existing `pluginSlashCommands` (higher precedence)
- 9 built-in commands registered: `/exit`, `/quit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`
- TUI and CLI simplified: all hardcoded checks removed, unified dispatch through engine
- `?` alias for `/help` removed
- Unrecognized commands show error instead of being sent to LLM
- Override detection logs warning when plugin overrides a built-in

## Consequences

- Single code path for all slash commands
- Plugins can override any built-in command
- Unrecognized commands show clear error messages
- `/help` output dynamically lists all commands from the unified registry

## Related

- [[plugin-system]] — Plugin architecture
- [[entities/DronePlugin]] — Plugin interface
