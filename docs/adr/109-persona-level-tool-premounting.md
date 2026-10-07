---
tags: [decision, persona, tool-premount, list-mount, feature]
related: [entities/Persona.md, entities/DronePlugin.md, architecture/plugin-system.md, concepts/default-hidden-tools.md, decisions/105-runtime-level-list-mount.md]
---

# ADR 109: Persona-Level Tool Pre-mounting

**Status**: Implemented (commit `75679e5`)

## Context

Under the runtime-level list-mount pattern ([[105-runtime-level-list-mount]]), all tools start unmounted. The LLM must discover tools via `runtime__list_tools` and mount them via `runtime__mount_tool` before they appear in the tool list. While this keeps the default surface minimal, certain personas conceptually want a **predictable, pre-wired toolset** — e.g. a "coder" persona that always wants `file__read`, `file__list`, `file__apply_diff`, `git__commit` available without the LLM having to mount them first.

There was no way to express "this persona always has these tools mounted" in the persona definition. The only mechanism was `allowedTools`, which controls **visibility** (filtering) of tools but does not **mount** them — a persona with `allowedTools` could still not see a tool unless it was mounted, and there was no persona-driven way to mount tools automatically.

## Decision

Add a `premountedTools` field to `DronePersonaDefinition` — a nested map of plugin id → list of tool names (without the `pluginId__` prefix). On **every persona change** (activation, switch, clear, reload re-activation, session-start activation), the persona broker plugin:

1. **Unmounts all currently-mounted non-`runtime__*` tools** — iterating `registration.listMountedTools()` and filtering out `runtime__` meta-tools
2. **Mounts the newly-active persona's premounted tools** — via `registration.mountTool(canonical)` for each declared tool

A premounted tool that is `defaultHidden` is **still visible to the LLM** even if absent from `allowedTools`, with a `registration.logger.warn` so the user knows to reconcile the two lists.

### Frontmatter format

```markdown
---
name: Coder
premountedTools:
  file:
    - read
    - list
    - apply_diff
  git:
    - commit
---
```

Parsed by the extended loader into `definition.premountedTools = { file: ['read', 'list', 'apply_diff'], git: ['commit'] }`.

### Engine primitive: `listMountedTools()`

A new `listMountedTools()` method was added to `DronePluginRegistration` (implemented in `plugin-engine.ts` via `toolRegistry.listMounted()`), letting any plugin enumerate currently-mounted tools. This is the general-purpose primitive; the "unmount all non-runtime" logic lives in the caller (the persona plugin), which iterates `listMountedTools()` and filters `runtime__*` itself.

### `getFilteredTools()` union

`getFilteredTools()` in the persona plugin now **unions the premounted canonical names** so premounted tools stay visible in both the no-`allowedTools` branch and the `allowedTools` branch:

```typescript
const premountedNames = new Set(expandPremountedCanonical());
// no activePersona / no allowedTools branch:
return allTools.filter(t => !t.defaultHidden || premountedNames.has(t.name));
// allowedTools branch:
return allTools.filter(t => filteredSet.has(t.name) || premountedNames.has(t.name));
```

### Wizard

`buildPersonaSystemPrompt()` in the persona wizard now teaches the LLM about the `premountedTools:` frontmatter format so `persona.create` can emit it.

## Out of Scope (Deliberately Deferred)

A tool-level `autoMount` flag on `DroneToolDefinition` is **intentionally NOT introduced** in this change. If/until a forced use case arises, the "none" persona's automount list is just the hardcoded `runtime__*` meta-tools. Revisit "other auto-mount tools merge into the persona automount list" if `autoMount` is ever added.

## Consequences

### Positive

- Personas can now express a predictable, pre-wired toolset — the LLM always sees exactly the right tools for the persona's job without a mounting step
- The premount lifecycle is centralized in `notifyChange()` — the single choke point for all persona changes (activate, clear, `persona.select` "none" branch, `reloadPersonas` re-activation, session-start activation)
- `listMountedTools()` is a broadly reusable engine primitive (not just for premounting)
- Premounting a `defaultHidden` tool makes it work as an intentional opt-in, with a warning to reconcile `allowedTools`

### Neutral

- On every persona change, all non-runtime mounted tools are unmounted and remounted — this is intentional to guarantee a clean, persona-specific tool surface
- The loader's line-by-line frontmatter parser was extended to handle the nested map-of-arrays; it now tracks an `inPremountMode` state plus a current plugin key

## Tests

- `persona-loader.test.ts` — 3 tests: parses the nested map into `Record<string, string[]>`, leaves `premountedTools` undefined when omitted, coexists with `tools`/`skills`/`fragments` in one file
- `persona-premount.test.ts` (new file) — 8 tests: mounts on activation, unmounts previous + mounts new on switch, clearing unmounts all non-runtime, `runtime__*` stays mounted across changes, session-start activation premounts, defaultHidden premounted tool visible via `getFilteredTools`, warns for unknown tool, warns for defaultHidden tool not in allowedTools
- `plugin-engine.test.ts` — 1 test: `listMountedTools()` reflects `toolRegistry` mount state

## Related

- [[entities/Persona]] — Persona definition now includes `premountedTools`
- [[entities/DronePlugin]] — `DronePluginRegistration` now includes `listMountedTools`
- [[decisions/105-runtime-level-list-mount]] — The runtime list-mount foundation this builds on
- [[concepts/default-hidden-tools]] — `defaultHidden` + `allowedTools` interplay with premounting
