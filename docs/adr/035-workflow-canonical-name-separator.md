---
tags: [decision]
related: [028-tool-name-separator.md, startup.md]
---

# 035: Workflow Canonical Name Separator Fix

**Status**: Implemented (2026-07-01)

## Context

Running `drone-agent --workflow persona__create` crashed with "Unknown workflow: persona.create" because the CLI reassembled the canonical name using a dot (`.`) separator on line 307 of `index.tsx`, while the plugin engine registers workflows using `getCanonicalToolName()` which uses a double-underscore (`__`) separator.

The CLI parser (`cli.ts`) correctly splits on `__` — the bug was only in the reassembly at the call site. No other code path had this issue.

## Decision

Change the workflow canonical name reassembly from dot to double-underscore to match the plugin engine's registration format.

## Consequences

- **Positive**: `--workflow persona__create` now works correctly
- **Positive**: The fix is a one-character change (`.` → `__`)
- **Negative**: None — no other code path was affected

## Implementation

- `drone-agent/src/index.tsx` line 307: Changed `\`${pluginId}.${workflowName}\``to`\`${pluginId}__${workflowName}\``

## Related

- [028-tool-name-separator](028-tool-name-separator.md) — The original tool name separator change
- startup — Startup flow including workflow dispatch
