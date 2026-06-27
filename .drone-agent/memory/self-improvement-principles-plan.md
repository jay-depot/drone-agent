---
key: self-improvement-principles-plan
tags:
  - self-improvement
  - plugin
  - principles
  - prompt-fragment
  - enhancement
created: 2026-06-27T23:09:32.662Z
updated: 2026-06-27T23:09:32.662Z
---

# Self-Improvement Plugin Enhancement Plan

## Goal
Organize, format and add promoted "principles" for the current project and persona to system prompt fragments.

## Current State
- ✅ Insights (record/list/recall) - fully implemented
- ✅ Principles (store/list/recall/delete) - fully implemented
- ✅ DronePrinciplesCapability - offered for other plugins
- ⚠️ Persona principles fragment exists but not rendering in /systemprompt output
- ❌ Project principles prompt fragment - MISSING
- ❌ Combined/organized fragment - MISSING

## Proposed Changes

### Replace existing `persona-principles` fragment with new combined `principles` fragment

**Key:** `principles`
**Phase:** `footer`
**Rendering:** Only when principles exist

### Output Format

```markdown
## Current Project

### {category-filename}
- {principle1}
- {principle2}

### {another-category}
- {principle1}

## Current Persona

### {persona-id}
- {principle1}
- {principle2}
```

### File Structure Expected

```
.drone-agent/
├── principles/
│   └── project/
│       ├── architecture.json   → ## Current Project / ### architecture
│       ├── workflow.json       → ## Current Project / ### workflow
│       └── security.json       → ## Current Project / ### security
├── personas/
│   └── coder/
│       └── principles/
│           └── principles.json → ## Current Persona / ### coder
```

## Implementation Steps

1. Remove existing `persona-principles` fragment (lines ~745-763)
2. Add new combined `principles` fragment with:
   - Scan .drone-agent/principles/project/*.json for project principles
   - Read active persona principles from .drone-agent/personas/{id}/principles/
   - Format with two headings: "## Current Project" and "## Current Persona"
   - Subheadings for each category (filenames at project level, persona id for persona)
3. Add tests for combined fragment rendering
4. Update test expectations

## Files to Modify

| File | Change |
|------|--------|
| drone-agent/src/plugins/self-improvement/index.ts | Replace fragment, add project principles scanning |
| drone-agent/test/self-improvement.test.ts | Add tests for combined fragment |

## Notes
- Skill principles should remain in recall result only (not in system prompt)
- Fragment returns false when no principles exist (correct current behavior)
- Tool descriptions for principles tools ARE being registered (user sees them via /systemprompt), but the principles content itself isn't being rendered