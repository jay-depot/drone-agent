---
key: plan-prompt-fragment-improvements
tags:
  []
created: 2026-08-13T23:52:25.098Z
updated: 2026-08-13T23:52:25.098Z
---

# Plan: Improve Prompt Fragments

## Summary
Refine several prompt fragments in the `drone-agent` plugins to resolve issues with passivity, vagueness, and potential contradictions. The goal is to provide firmer guidance to the LLM without triggering robotic over-correction.

## Implementation Steps

### 1. Update File Editing Fragment (`drone-agent/src/plugins/file.ts`)
- **Target:** `editing-convention` fragment.
- **Change:** Update the text to be a firm guideline rather than a mere preference.
- **New Content:**
  `# File Editing\n\n**Guideline:** When modifying existing files, use \`apply_diff\` to ensure precision and prevent data loss. Use \`write\` only for creating new files or performing complete rewrites. If \`apply_diff\` is not available when you need to edit, mount it via \`runtime__mount_tool({ "tool": "file__apply_diff" })\`.`

### 2. Update Session Notepad Fragment (`drone-agent/src/plugins/notepad.ts`)
- **Target:** `notepad-current` fragment.
- **Change:** Shift from a descriptive tone to an operational one, emphasizing "working memory" over "TODO list."
- **New Content:**
  `# Session Notepad\n\n===\n\n${state.currentNotepad}\n\n===\n\nUse the \`notepad__*\` tools to maintain a "working memory" for the current session. This is ideal for tracking complex constraints, temporary variables, or specific notes that should remain visible above the conversational noise. Refer to this notepad to maintain continuity during complex multi-step tasks.`

### 3. Update Current Focus Fragment (`drone-agent/src/plugins/focus.ts`)
- **Target:** `focus-current` fragment.
- **Change:** Replace hyperbolic "obsessed" language with high-authority "Strict Adherence" language and add clear exit conditions.
- **New Content:**
  `# Current Focus\n\n**Primary Objective:** ${state.currentFocus}\n\n**Strict Adherence:** You are currently in a "focused state." Prioritize all actions toward fulfilling this objective and do not deviate from it until the task is finished or you have been explicitly told to clear your focus. You may only deviate if you encounter a critical blocker that requires immediate resolution to proceed.`

### 4. Update Workspace Fragment (`drone-agent/src/plugins/startup.ts`)
- **Target:** `startup-banner` fragment.
- **Change:** Clarify boundaries and add a "user override" clause to resolve contradictions.
- **New Content:**
  `# Workspace\n\n**Root Directory:** ${cwd}\n**Path Rule:** All file paths in this session should be relative to this directory.\n**Boundary:** Do not assume or use paths outside this workspace (e.g., /workspace/... or /home/...) unless specifically instructed to do so by the user or unless accessing the User Home Directory listed below.\n\n**User Home:** ${homeDir}\n**OS:** ${osInfo}\n**Current Time:** ${dateTime}`

## Validation Criteria
- [ ] All changed files pass LSP type-checking.
- [ ] `pnpm -r run lint` and `pnpm -r run build` pass.
- [ ] Verify fragments render correctly in the TUI (manual check or test).