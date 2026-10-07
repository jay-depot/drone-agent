---
tags: [decision, tui, rendering]
related: [078-pretty-tool-output.md, 080-subagent-dispatch-pretty-output.md, 081-meta-tool-pretty-output.md, modules/drone-agent-tui.md, modules/drone-agent-plugins.md]
---

# ADR 079: Pretty Tool Output — Phase 2 (Extended Tools)

**Status**: Implemented (commit `054b3cb`, 2026-07-21)

## Context

Phase 1 covered the 7 core workhorse tools. Phase 2 extends custom TUI rendering to 12 more tools across 6 plugins: `utils`, `config`, `memory`, `skills`, `persona`, `notepad`, and `self-improvement` (insight only).

Also includes three retroactive tweaks to the Phase 1 components:
1. Add tool names (e.g. `file__read`, `file__write`) to the running/done headers of `FileReadBlock`, `FileWriteBlock`, `FileApplyDiffBlock`, `FileListBlock`, `FileGlobBlock`
2. Bump `FileReadBlock` preview from 5 to 10 lines
3. Thread user's syntax highlighting settings through to `FileReadBlock` so it uses the configured colors instead of hardcoded `SYNTAX_COLORS`

## Decision

### Infrastructure

- `syntaxColors?: Record<string, string>` and `codeBackground?: string` fields added to `ToolRenderState` in `drone-core/src/session-types.ts`
- Threaded through `app.tsx` event handlers (`toolCallBatch`, `toolProgress`, `toolResultBatch`) via `syntaxColorsRef` and `codeBackgroundRef`

### Render Components (13 new files)

| Component | File | Behavior |
|-----------|------|----------|
| `UtilsBlock` | `tui/components/UtilsBlock.tsx` | Calculator result (`"5 + 5" = 10`) and string operations (`count_words → 2 words`, `spell → s t r a w b e r r y`) |
| `ConfigGetBlock` | `tui/components/ConfigGetBlock.tsx` | `config.get: ollama.model = "llama3"` or `config.get: all (N keys)` |
| `ConfigSetBlock` | `tui/components/ConfigSetBlock.tsx` | `config.set: ollama.model → project scope (restart to apply)` |
| `MemoryManageBlock` | `tui/components/MemoryManageBlock.tsx` | store/delete/recall; recall renders value as Markdown |
| `MemoryBrowseBlock` | `tui/components/MemoryBrowseBlock.tsx` | list/search with entries and count |
| `SkillsRecallBlock` | `tui/components/SkillsRecallBlock.tsx` | Shows skill id + body rendered as Markdown |
| `SkillsListBlock` | `tui/components/SkillsListBlock.tsx` | Lists skills with descriptions |
| `SkillsCreateBlock` | `tui/components/SkillsCreateBlock.tsx` | `✓ skills.create: Workflow completed.` |
| `PersonaListBlock` | `tui/components/PersonaListBlock.tsx` | Lists personas, shows active |
| `PersonaSelectBlock` | `tui/components/PersonaSelectBlock.tsx` | `✓ persona.select: "plan" → active` or error/clear |
| `PersonaCreateBlock` | `tui/components/PersonaCreateBlock.tsx` | `✓ persona.create: Workflow completed.` |
| `NotepadBlock` | `tui/components/NotepadBlock.tsx` | Shows operation + content rendered as Markdown |
| `SelfImprovementInsightBlock` | `tui/components/SelfImprovementInsightBlock.tsx` | record/list/recall actions |

### Plugin Registration Changes

Each plugin registered its `renderComponent` on the relevant tool definitions:
- `utils.ts` — `UtilsBlock` on calculator + string
- `config/index.ts` — `ConfigGetBlock` on get, `ConfigSetBlock` on set
- `memory/index.ts` — `MemoryManageBlock` on manage, `MemoryBrowseBlock` on browse
- `skills/index.ts` — `SkillsRecallBlock` on recall, `SkillsListBlock` on list, `SkillsCreateBlock` on create
- `persona/index.ts` — `PersonaListBlock` on list, `PersonaSelectBlock` on select, `PersonaCreateBlock` on create
- `notepad.ts` — `NotepadBlock` on manage
- `self-improvement/tools/insight.ts` — `SelfImprovementInsightBlock` on insight

### Tests

52 tests in `test/pretty-tool-output-phase-2.test.tsx` covering all 13 components in running/done/error states, multiple operation modes.

## Consequences

### Positive
- All commonly-used tools now have purpose-built TUI render components
- Configurable syntax highlighting colors thread through to file previews
- Phase 1 components improved (tool names in headers, 10-line preview)

### Negative
- 13 more TUI components to maintain
- `ToolRenderState` now carries syntax color config (slightly more data per render)

## Related

- [078-pretty-tool-output](078-pretty-tool-output.md) — Phase 1: 7 core tools
- [080-subagent-dispatch-pretty-output](080-subagent-dispatch-pretty-output.md) — Subagent dispatch TUI rendering
- [081-meta-tool-pretty-output](081-meta-tool-pretty-output.md) — Reusable list/mount/unmount meta-tool components
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI module documentation
