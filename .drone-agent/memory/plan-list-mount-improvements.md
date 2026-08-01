---
key: plan-list-mount-improvements
tags:
  - plan
  - list-mount
  - lsp
  - file
  - runtime-flags
created: 2026-08-01T20:32:21.584Z
updated: 2026-08-01T20:32:21.584Z
---

# Plan: List-Mount Pattern Improvements

## Summary

Three improvements to the list-mount tool pattern across drone-agent:

1. **Runtime Flags System** — A core runtime mechanism (not a plugin) that injects a system prompt block listing active runtime flags, including a list-mount pattern explainer with the names of active list-mount plugins. This is reusable for future features (debug flags, swarm state, etc.).

2. **LSP Tool Consolidation** — Reduce 16 LSP tools to 10 by merging related tools with parameters, moving `server_status` to a prompt fragment, and enriching the freed context with better descriptions, "when to use" guidance, and examples.

3. **File Plugin apply_diff Nudging** — Three layers to make `apply_diff` the preferred edit path: (1) a file plugin prompt fragment naming `apply_diff` as preferred for edits, (2) enhanced `list_tools` description with `apply_diff` listed before `write`, (3) enhanced short description in the tool list.

## Implementation Steps

### Step 1: Runtime Flags Registry in drone-core

**File: `drone-core/src/runtime-flags.ts` (NEW)**

Create a `RuntimeFlagRegistry` class:

```typescript
export type RuntimeFlagRegistry = {
  set(key: string, value: string): void;
  append(key: string, value: string): void;  // comma-separated, dedup
  get(key: string): string | undefined;
  has(key: string): boolean;
  entries(): Map<string, string>;
  render(): string | null;  // null if empty
};
```

- `append(key, value)`: If key doesn't exist, set to `value`. If it exists, split on `, `, check if `value` is already present, if not append `, value`. This is the primary method for list-mount plugins.
- `render()`: Produces a `# Runtime Flags` block. For the `list-mount` key specifically, includes the explainer text with the list of active plugins. Other keys render as `key: value` lines. Returns `null` if no flags are set.

**Render output when list-mount flag is active:**
```
# Runtime Flags

## List/Mount Pattern

Some plugin tools use a list-mount pattern to keep context costs low.
Call `<plugin>__list_tools` to browse available tools, then
`<plugin>__mount_tool` to activate the ones you need. Mounted tools
get their full schemas. Call `<plugin>__unmount_tool` when done to
reduce clutter.

Active list-mount plugins: file, lsp, git, mcp, swarm
```

**Render output when only non-list-mount flags are active:**
```
# Runtime Flags

debug: llm, mcp
```

**Export from `drone-core/src/index.ts`**: Add `RuntimeFlagRegistry` type and `createRuntimeFlagRegistry()` factory.

**Validation**: Unit tests for set, append (with dedup), get, has, entries, render (empty, with list-mount, with other flags, with both).

---

### Step 2: Wire Runtime Flags into Plugin Engine

**File: `drone-agent/src/runtime/plugin-engine.ts`**

1. Import `createRuntimeFlagRegistry` from drone-core.
2. Create a registry instance in `createDronePluginEngine`.
3. Expose the registry via the `_runtime` capability (extend the existing `runtimeOptions` object):
   ```typescript
   capabilities.set('_runtime', {
     subagentId: runtimeOptions?.subagentId,
     persona: runtimeOptions?.persona,
     isSubagent: !!runtimeOptions?.subagentId,
     flags: runtimeFlagRegistry,  // NEW
   });
   ```
4. Return the registry from `createDronePluginEngine` (alongside the existing return values) so it can be passed to the context budget service.

**Validation**: LSP must pass. Unit test that plugins can request the `_runtime` capability and access `flags`.

---

### Step 3: Inject Runtime Flags into System Prompt

**File: `drone-agent/src/runtime/context-budget-service.ts`**

1. Add `runtimeFlags?: RuntimeFlagRegistry` to `CreateContextBudgetServiceOptions`.
2. In `buildSystemMessages()`, after `config.systemPrompt` and before rendered fragments, inject the flags:
   ```typescript
   const flagsContent = runtimeFlags?.render();
   if (flagsContent) {
     base.push({ role: 'system', content: flagsContent });
   }
   ```

**File: `drone-agent/src/index.tsx`**

3. Pass the runtime flag registry from the engine to `createContextBudgetService`.

**Validation**: LSP must pass. Unit test that `buildSystemMessages` includes the flags block when flags are set and excludes it when empty.

---

### Step 4: List-Mount Plugins Set the Flag

**Files to modify:**
- `drone-agent/src/plugins/file.ts`
- `drone-agent/src/plugins/lsp/plugin.ts`
- `drone-agent/src/plugins/git/index.ts`
- `drone-agent/src/plugins/mcp/index.ts`
- `drone-agent/src/plugins/swarm/index.ts`

In each plugin's `register()` function, request the `_runtime` capability and call:
```typescript
const runtime = registration.request<RuntimeCapability>('runtime');
runtime?.flags?.append('list-mount', '<pluginId>');
```

Where `<pluginId>` is `file`, `lsp`, `git`, `mcp`, `swarm` respectively.

**Validation**: LSP must pass. Verify the flags registry contains all active list-mount plugin IDs after engine initialization.

---

### Step 5: LSP Tool Consolidation

**Files: `drone-agent/src/plugins/lsp/tools/`**

#### 5a: Merge `call_hierarchy_incoming` + `call_hierarchy_outgoing` → `call_hierarchy`

**File: `drone-agent/src/plugins/lsp/tools/hierarchy.ts`**

Replace two factory functions with one:
```typescript
export function createCallHierarchyTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'call_hierarchy',
    description: 'Return the call hierarchy for a symbol. Use `direction: "incoming"` to see callers leading to this symbol, or `direction: "outgoing"` to see callees invoked by this symbol. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath', 'direction'],
      properties: {
        filePath: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        direction: { type: 'string', enum: ['incoming', 'outgoing'], description: 'Direction of the call hierarchy.' },
        line: { type: 'integer', description: '1-based line number (optional if text or symbol is provided).' },
        column: { type: 'integer', description: '1-based column number (optional if text or symbol is provided).' },
        text: { type: 'string', description: 'Text content to search for in the file (alternative to line/column).' },
        symbol: { type: 'string', description: 'Symbol name to resolve (alternative to line/column).' },
      },
    },
    execute: async (args) => {
      // Route to incoming or outgoing based on args.direction
    },
  };
}
```

#### 5b: Merge `go_to_definition` + `type_definition` + `implementation` → `go_to`

**File: `drone-agent/src/plugins/lsp/tools/navigation.ts`**

Replace three factory functions with one:
```typescript
export function createGoToTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'go_to',
    description: 'Navigate to a symbol\'s definition, type definition, or implementation. Use `kind: "definition"` (default) to find where a symbol is defined, `kind: "type"` to find its type definition, or `kind: "implementation"` to find implementations of an interface. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        kind: { type: 'string', enum: ['definition', 'type', 'implementation'], description: 'Navigation kind. Default: "definition".', default: 'definition' },
        line: { ... },
        column: { ... },
        text: { ... },
        symbol: { ... },
      },
    },
    execute: async (args) => {
      // Route to definition, typeDefinition, or implementation based on args.kind
    },
  };
}
```

#### 5c: Merge `document_symbols` + `workspace_symbol` → `symbols`

**File: `drone-agent/src/plugins/lsp/tools/symbols.ts`**

Replace two factory functions with one:
```typescript
export function createSymbolsTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'symbols',
    description: 'List symbols in a file or search across the workspace. Use `scope: "document"` to list all symbols in a specific file (functions, classes, variables), or `scope: "workspace"` to search for symbols by name across the entire workspace with fuzzy matching.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: {
        scope: { type: 'string', enum: ['document', 'workspace'], description: 'Search scope.' },
        filePath: { type: 'string', description: 'File path (required when scope is "document").' },
        query: { type: 'string', description: 'Symbol name or substring to search for (required when scope is "workspace").' },
        limit: { type: 'integer', description: 'Optional max results (workspace scope only, default 200).' },
      },
    },
    execute: async (args) => {
      // Route to documentSymbols or workspaceSymbol based on args.scope
    },
  };
}
```

#### 5d: Merge `hover` + `signature_help` → `inspect`

**File: `drone-agent/src/plugins/lsp/tools/completion.ts` (or a new `inspect.ts`)**

Replace two factory functions with one:
```typescript
export function createInspectTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'inspect',
    description: 'Inspect a symbol at a position. Returns hover information (type docs, documentation) and signature help (active parameter info for function calls) in a single response. Use this to understand what a symbol is, its type, or what parameters a function expects. Supports `text` and `symbol` parameters for position resolution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        line: { ... },
        column: { ... },
        text: { ... },
        symbol: { ... },
      },
    },
    execute: async (args) => {
      // Call both hover and signatureHelp, merge results
      // Return both sections in the response
    },
  };
}
```

#### 5e: Move `server_status` to prompt fragment

**File: `drone-agent/src/plugins/lsp/plugin.ts`**

Remove the `server_status` tool from the cache. Add a new prompt fragment (or extend the existing diagnostics fragment) to include server connection status:

```typescript
registration.registerPromptFragment({
  key: 'server-status',
  phase: 'header',
  render: async () => {
    const statuses = server.getServerStatuses();
    if (statuses.length === 0) return false;
    const lines = statuses.map(s => `${s.languageId}: ${s.connected ? 'connected' : 'disconnected'}`);
    return `# LSP Servers\n\n${lines.join('\n')}`;
  },
});
```

Or merge with the existing diagnostics fragment so it becomes:
```
# LSP

Servers: typescript (connected), eslint (connected)
Diagnostics: Clean. No errors or warnings detected.
```

#### 5f: Update tool list and descriptions

**File: `drone-agent/src/plugins/lsp/plugin.ts`**

Update `LSP_TOOL_DESCRIPTIONS` to the 10 consolidated tools with enhanced descriptions:

```typescript
const LSP_TOOL_DESCRIPTIONS = [
  { name: 'get_diagnostics', description: 'Return LSP diagnostics for the workspace or a specific file. Use this to check for errors and warnings.' },
  { name: 'inspect', description: 'Inspect a symbol at a position — returns hover info (type, docs) and signature help (function parameters) together.' },
  { name: 'go_to', description: 'Navigate to a symbol\'s definition, type definition, or implementation. Use kind: "definition" (default), "type", or "implementation".' },
  { name: 'find_references', description: 'Find all references to a symbol across the workspace.' },
  { name: 'symbols', description: 'List symbols in a file (scope: "document") or search the workspace (scope: "workspace").' },
  { name: 'completion', description: 'Get completion suggestions at a position — includes kind, detail, and documentation.' },
  { name: 'code_action', description: 'Get quick fixes, refactorings, and source actions for a file or position.' },
  { name: 'rename', description: 'Rename a symbol across the entire workspace. Returns a preview, or applies directly with apply: true.' },
  { name: 'call_hierarchy', description: 'Get the call hierarchy for a symbol — direction: "incoming" (callers) or "outgoing" (callees).' },
  { name: 'formatting', description: 'Format a file using the LSP server. Applies formatting edits directly.' },
];
```

Update the `lsp__list_tools` description:
```
List all available LSP tools. Tools include: get_diagnostics, inspect, go_to, find_references, symbols, completion, code_action, rename, call_hierarchy, formatting. Mount the ones you need with lsp__mount_tool.
```

#### 5g: Update tool factory wiring

**File: `drone-agent/src/plugins/lsp/plugin.ts`**

Update the tool registration to use the new consolidated factories:
```typescript
const tools = [
  createGetDiagnosticsTool(server),
  createInspectTool(server),
  createGoToTool(server),
  createFindReferencesTool(server),
  createSymbolsTool(server),
  createCompletionTool(server),
  createCodeActionTool(server),
  createRenameTool(server),
  createCallHierarchyTool(server),
  createFormattingTool(server),
];
for (const tool of tools) {
  lspCache.addTool(tool.name, tool);
}
```

#### 5h: Update exports

**File: `drone-agent/src/plugins/lsp/tools/index.ts`**

Update barrel exports to reflect the consolidated functions.

**Validation**: LSP must pass. All existing LSP tests must pass (update test imports/factory calls as needed). New tests for each consolidated tool verifying both modes work.

---

### Step 6: File Plugin apply_diff Nudging

#### 6a: File prompt fragment

**File: `drone-agent/src/plugins/file.ts`**

Register a prompt fragment:
```typescript
registration.registerPromptFragment({
  key: 'editing-convention',
  phase: 'header',
  render: async () =>
    `# File Editing\n\nFor editing existing files, prefer \`apply_diff\` over \`write\`. Mount it with \`file__mount_tool\` if not already available. Use \`write\` only for creating new files or complete rewrites.`,
});
```

#### 6b: Reorder and enhance FILE_TOOL_DESCRIPTIONS

**File: `drone-agent/src/plugins/file.ts`**

Reorder to put `apply_diff` before `write`:
```typescript
const FILE_TOOL_DESCRIPTIONS = [
  { name: 'read', description: 'Read a file (absolute path). Optional 1-based startLine/endLine.' },
  { name: 'list', description: 'List a directory (absolute path). Returns names, types, sizes.' },
  { name: 'apply_diff', description: 'Apply a unified diff patch to a file. **Preferred for editing existing files** — preserves context and minimizes changes.' },
  { name: 'write', description: 'Write content to a file (absolute path). Creates parents; overwrites. Use for new files or complete rewrites.' },
  { name: 'glob', description: 'Find files matching a glob (e.g. **/*.ts). Uses **, *, ? patterns.' },
  { name: 'read_image', description: 'Read an image file and return its base64-encoded data. Supported formats: JPEG, PNG, WebP, GIF.' },
];
```

#### 6c: Update list_tools description

**File: `drone-agent/src/plugins/file.ts`**

Update the `file__list_tools` description:
```
List all available file tools. Tools include: read, list, apply_diff (preferred for editing existing files), write, glob, read_image. Mount the ones you need with file__mount_tool.
```

**Validation**: LSP must pass. Unit tests for the prompt fragment rendering. Verify tool ordering in list_tools output.

---

### Step 7: Update Tests

#### 7a: Runtime flags tests
**File: `drone-core/test/runtime-flags.test.ts` (NEW)**
- Test set, get, has, append (with dedup), entries, render (empty, with flags, with list-mount)

#### 7b: Context budget service tests
**File: `drone-agent/test/context-budget-service.test.ts` (modify or create)**
- Test that buildSystemMessages includes runtime flags when set
- Test that buildSystemMessages excludes runtime flags when empty

#### 7c: LSP tool tests
**File: `drone-agent/test/lsp-tools.test.ts` (modify or create)**
- Test each consolidated tool handles both/all modes
- Test `inspect` returns both hover and signature data
- Test `go_to` routes to correct LSP method based on `kind`
- Test `call_hierarchy` routes based on `direction`
- Test `symbols` routes based on `scope`
- Test `server_status` prompt fragment renders correctly

#### 7d: File plugin tests
**File: `drone-agent/test/file-plugin.test.ts` (modify or create)**
- Test prompt fragment renders the editing convention
- Test list_tools output ordering (apply_diff before write)

**Validation**: All tests pass with `pnpm -r run test`.

---

### Step 8: Final Validation

1. `pnpm -r run lint` — zero errors
2. `pnpm -r run build` — zero errors
3. `pnpm -r run test` — all tests pass
4. LSP diagnostics clean (no errors or warnings)
5. Verify in a live session:
   - Runtime flags appear in system prompt when list-mount plugins are active
   - LSP list_tools shows 10 tools with enhanced descriptions
   - File list_tools shows apply_diff before write
   - File prompt fragment appears in system prompt
   - LSP server_status appears in prompt fragment (not as a tool)

## Validation Criteria

- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run test` passes (all packages)
- [ ] LSP diagnostics show no errors or warnings
- [ ] RuntimeFlagRegistry unit tests pass (set, append with dedup, render with/without flags)
- [ ] Context budget service correctly injects runtime flags into system messages
- [ ] LSP tools consolidated from 16 to 10 (call_hierarchy, go_to, symbols, inspect merged; server_status moved to prompt fragment)
- [ ] All consolidated LSP tools handle both/all modes correctly
- [ ] LSP server_status renders as a prompt fragment
- [ ] File plugin registers editing-convention prompt fragment
- [ ] File list_tools shows apply_diff before write with enhanced description
- [ ] All list-mount plugins append to the runtime flags registry