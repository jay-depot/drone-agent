---
tags: [decision, plugin-system, tool-reduction, runtime-flags]
related:
  [
    decisions/064-mcp-deferred-tool-loading.md,
    decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md,
    decisions/068-tool-reduction-followup.md,
    decisions/069-lsp-ergonomics.md,
    decisions/098-lsp-file-list-mount-conversion.md,
    decisions/101-systemprompt-runtime-flags.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
    architecture/plugin-system.md,
  ]
---

# Decision 100: List-Mount Pattern Improvements

**Summary**: Three improvements to the list-mount tool pattern: a reusable runtime flags system for system prompt injection, LSP tool consolidation from 16 to 10, and file plugin `apply_diff` nudging to steer the LLM toward the preferred edit method.

## Context

After converting the LSP and File plugins to the list-mount pattern ([098-lsp-file-list-mount-conversion](098-lsp-file-list-mount-conversion.md)), three issues emerged:

1. **No system-prompt-level explainer** — The list-mount pattern was communicated entirely through tool descriptions. The LLM had to infer the workflow from `__list_tools`/`__mount_tool` descriptions alone, with no overarching guidance.

2. **LSP tool count still high** — Even behind list-mount, 16 tools in the LSP cache meant a long `list_tools` response and high cognitive load for the LLM to pick the right tool.

3. **`apply_diff` under-utilized** — When File tools used list-mount, the LLM never mounted `apply_diff`, defaulting to `write` for all edits. The preferred edit method was invisible unless the LLM happened to call `file__list_tools`.

## Decision

### 1. Runtime Flags System

A `RuntimeFlagRegistry` in drone-core (`src/runtime-flags.ts`) — a core runtime mechanism (not a plugin) for injecting system prompt content.

**Architecture:**

- The registry is created by the plugin engine at init time
- Exposed via the `_runtime` capability (alongside existing `subagentId`/`persona` fields)
- Rendered into the system prompt by `context-budget-service.ts` between `config.systemPrompt` and plugin prompt fragments
- Plugins access it via `registration.request<{ flags?: RuntimeFlagRegistry }>('runtime')`

**The `list-mount` flag:**

All 5 list-mount plugins (file, lsp, git, mcp, swarm) call `runtime?.flags?.append('list-mount', '<pluginId>')` during registration. The `render()` method produces a `# Runtime Flags` block with a `## List/Mount Pattern` explainer and `Active list-mount plugins: file, lsp, git, mcp, swarm`.

**Reusability:**

The flags system is designed for future use beyond list-mount. Any plugin can set a flag, and the rendered output includes all flags as `key: value` lines. Potential future uses: debug subsystems, swarm connection state, compaction mode.

**Key files:**

- `drone-core/src/runtime-flags.ts` — `RuntimeFlagRegistry` class with `set`, `append` (comma-separated, dedup), `get`, `has`, `entries`, `render`
- `drone-agent/src/runtime/plugin-engine.ts` — Creates registry, exposes via `_runtime`, returns via `getRuntimeFlags()`
- `drone-agent/src/runtime/context-budget-service.ts` — Accepts `runtimeFlags` lazy getter, injects into `buildSystemMessages()`
- `drone-agent/src/index.tsx` — Passes `runtimeFlags: () => getEngine().getRuntimeFlags()` to budget service

### 2. LSP Tool Consolidation (16 → 10)

Merged related tools by adding a parameter to select the mode:

| Previous Tools                                            | Consolidated Into | Parameter                                                                  |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `call_hierarchy_incoming` + `call_hierarchy_outgoing`     | `call_hierarchy`  | `direction: "incoming" \| "outgoing"`                                      |
| `go_to_definition` + `type_definition` + `implementation` | `go_to`           | `kind: "definition" \| "type" \| "implementation"` (default: "definition") |
| `document_symbols` + `workspace_symbol`                   | `symbols`         | `scope: "document" \| "workspace"`                                         |
| `hover` + `signature_help`                                | `inspect`         | (always returns both)                                                      |

**`server_status` moved to prompt fragment** — Removed as a tool entirely. Now rendered as a prompt fragment alongside the existing diagnostics fragment, producing:

```
# LSP Servers

typescript: connected

# LSP Diagnostics

Clean. No errors or warnings detected.
```

**Enhanced descriptions** — All 10 tool descriptions were rewritten with "when to use" guidance (e.g., "Use this to check for errors and warnings", "Use kind: 'definition' (default), 'type', or 'implementation'").

**Shared position properties** — The common parameter set (filePath, line, column, text, symbol) was extracted as a `POSITION_PROPERTIES` const object and spread into each tool's schema, keeping the code DRY.

**Key files:**

- `drone-agent/src/plugins/lsp/plugin.ts` — 10 tools, updated descriptions, server_status prompt fragment
- `drone-agent/src/plugins/lsp/tools/navigation.ts` — `go_to` + `find_references`
- `drone-agent/src/plugins/lsp/tools/symbols.ts` — `symbols` (scope param)
- `drone-agent/src/plugins/lsp/tools/completion.ts` — `inspect` + `completion`
- `drone-agent/src/plugins/lsp/tools/hierarchy.ts` — `call_hierarchy` (direction param)
- `drone-agent/src/plugins/lsp/tools/index.ts` — Updated barrel exports
- `drone-agent/src/plugins/lsp/tools/status.ts` — **Deleted** (moved to prompt fragment)

### 3. File Plugin `apply_diff` Nudging

Three layers to make `apply_diff` the preferred edit path:

1. **Prompt fragment** — Registers an `editing-convention` header fragment: "For editing existing files, prefer `apply_diff` over `write`. Mount it with `file__mount_tool` if not already available."

2. **Reordered `FILE_TOOL_DESCRIPTIONS`** — `apply_diff` now appears before `write` in the list_tools output, making it the "default" edit tool the LLM encounters first.

3. **Enhanced descriptions** — `apply_diff` description marked as "Preferred for editing existing files", `write` description marked as "Use for new files or complete rewrites". The `list_tools` description also highlights `apply_diff` as preferred.

**Key files:**

- `drone-agent/src/plugins/file.ts` — Prompt fragment, reordered descriptions, enhanced descriptions

## Consequences

### Positive

- **Runtime flags are reusable** — The system is designed for any plugin to set any flag. The `list-mount` flag is the first use case, but the architecture supports debug flags, swarm state, compaction mode, etc.
- **LSP tools are more discoverable** — 10 tools with clear "when to use" descriptions is easier for the LLM to navigate than 16 terse one-liners.
- **`apply_diff` is visible in system prompt** — The editing convention fragment ensures the LLM knows about `apply_diff` before it ever needs to edit, without requiring it to call `list_tools` first.
- **`server_status` is always visible** — Moving to a prompt fragment means the LLM always knows LSP server connection state without needing to mount and call a tool.

### Negative

- **Mock engine maintenance burden** — Adding `getRuntimeFlags()` to the `DronePluginEngine` type required updating 4 test files with manually-constructed mock engines. A shared mock engine factory would reduce this.
- **`inspect` always returns both hover and signature** — Slightly more tokens per call than separate tools, but the simplicity of one tool outweighs the cost.
- **The `apply_diff` prompt fragment adds ~30 tokens** to every system prompt when the file plugin is enabled — acceptable, but easy to remove if the other two nudging layers prove sufficient.

## Implementation

- **Branch**: `feat/lsp-file-list-mount-conversion`
- **Commit**: `4ad68e7`
- **Files changed** (27 total):

### Follow-up: `/systemprompt` Runtime Flags Visibility

After implementation, it was discovered that the `/systemprompt` slash command did not show the runtime flags block — it was sent to the LLM but invisible to the user. Fixed in commit `693e44d` by adding `buildSystemMessages` to the engine interface and having the handler use it instead of manually assembling the pieces. See [101-systemprompt-runtime-flags](101-systemprompt-runtime-flags.md).

**Validation**: 108 test files, 1694 tests passed. Lint, build, LSP diagnostics all clean.

- **New**: `drone-core/src/runtime-flags.ts`, `drone-core/test/runtime-flags.test.ts`, `drone-agent/test/context-budget-service.test.ts`
- **Deleted**: `drone-agent/src/plugins/lsp/tools/status.ts`
- **Modified**: 23 files across drone-core, drone-agent (plugins, runtime, tests)
- **Validation**: 108 test files, 1694 tests passed. Lint, build, LSP diagnostics all clean.
