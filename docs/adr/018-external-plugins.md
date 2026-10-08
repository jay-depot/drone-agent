---
tags: [decision]
related: [external-plugins.md, plugin-system.md, DroneAgentConfig.md]
---

# ADR 018: External Plugin Loading

**Status**: Implemented (2026-06-29)

## Context

The drone-agent plugin system was designed for static, build-time plugin registration. All plugins were compiled into the binary at build time. There was no mechanism for users or projects to add custom plugins without modifying the source code.

We needed a way for:

1. Users to install custom plugins in their home directory
2. Projects to ship custom plugins in their `.drone-agent/` directory
3. The system to handle trust for project-level plugins (since a project could push arbitrary code)

## Decision

### Auto-discovery from well-known directories

External plugins are discovered by scanning `~/.drone-agent/plugins/` and `<project>/.drone-agent/plugins/` for subdirectories containing `index.js` or `index.mjs` files.

### Plugin format

Each plugin is a directory named `<plugin-id>/` containing at minimum an `index.js` (or `.mjs`) that exports a `DronePlugin` object. The export can be either the default export or a named export `plugin`.

### Trust system

- User-scope plugins are loaded silently (the user owns their own config)
- Project-scope plugins require user trust on first encounter
- Trust decisions are stored in `~/.drone-agent/trusted-plugins.json` (user-scoped, so a project cannot push its own trust)
- Three options: "Yes, trust it", "No, skip this time", "No, and don't ask again"

### Engine integration

A new `engine.addExternalPlugin(plugin)` method was added to support post-construction plugin registration. This was necessary because the existing `enablePlugin()` only works for plugins already in the registry.

### Config dir override

If `--config-dir` is provided, the user plugins directory follows (e.g., `--config-dir /custom/path` → `/custom/path/.drone-agent/plugins/`).

### No `--plugin` path support

In this iteration, external plugins are only loaded from well-known directories. Future iterations may add `--plugin ./path/to/plugin` support.

## Consequences

### Positive

- Users can install custom plugins without modifying the source code
- Projects can ship custom plugins in their `.drone-agent/` directory
- Trust system prevents automatic execution of untrusted project code
- Config dir override works consistently for plugins
- The `addExternalPlugin()` method enables future dynamic plugin loading scenarios

### Negative

- Dynamic imports add complexity to the startup flow
- Trust prompting requires interactive mode; deferred plugins are silently skipped in non-interactive modes
- No versioning or dependency management for external plugins (they must handle their own dependencies)

## Related

- external-plugins — How external plugins work
- [plugin-system](002-plugin-system.md) — Plugin architecture
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — Config schema with new fields
