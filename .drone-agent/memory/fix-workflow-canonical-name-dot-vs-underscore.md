---
key: fix-workflow-canonical-name-dot-vs-underscore
tags:
  - bug
  - fix
  - workflow
  - cli
created: 2026-07-01T21:31:18.574Z
updated: 2026-07-01T21:31:18.574Z
---

# Fix: `--workflow` canonical name uses dot (`.`) instead of double-underscore (`__`)

## Bug

Running `drone-agent --workflow persona__create` crashes with:

```
[drone-agent] Error: Unknown workflow: persona.create
    at Object.runWorkflow (file:///.../plugin-engine.js:150:19)
    at main (file:///.../index.js:264:37)
```

## Root Cause

In `drone-agent/src/index.tsx`, line 307, the workflow canonical name is constructed with a **dot** separator:

```typescript
const canonicalName = `${pluginId}.${workflowName}`;
```

But the plugin engine registers workflows using `getCanonicalToolName()` (from `drone-core/src/utils.ts`), which uses a **double-underscore** (`__`) separator:

```typescript
return `${pluginId}__${toolName}`;
```

So the workflow is registered as `"persona__create"` but the CLI looks it up as `"persona.create"` → mismatch → "Unknown workflow".

The CLI parser (`cli.ts`) correctly splits on `__` — `--workflow persona__create` correctly yields `pluginId = "persona"` and `workflowName = "create"`. The bug is only in the reassembly at line 307.

No other code path has this bug — all internal `runWorkflow` calls (in `persona/index.ts`, `skills/index.ts`, `interactive.ts`) already use the `__` separator.

## Fix

**One-line change** in `drone-agent/src/index.tsx`, line 307:

```diff
- const canonicalName = `${pluginId}.${workflowName}`;
+ const canonicalName = `${pluginId}__${workflowName}`;
```

## Validation

- `pnpm typecheck` passes
- `pnpm test` passes (existing CLI workflow tests cover this path)
- `drone-agent --workflow persona__create` no longer throws "Unknown workflow"