---
tags: [decision, prompt-fragments, system-prompt]
related: [modules/drone-agent-plugins.md, concepts/notepad.md, concepts/session-management.md]
---

# 126. Prompt Fragment Improvements

**Summary**: Refined several system prompt fragments to resolve issues with passivity, vagueness, and potential contradictions. The goal is to provide firmer guidance to the LLM without triggering robotic over-correction.

## Context

Several prompt fragments in the drone-agent plugins were too passive, vague, or contradictory, leading to suboptimal LLM behavior:

1. **File Editing fragment** (`file.ts`): "prefer `apply_diff` over `write`" was a suggestion, not a requirement. LLMs often default to `write` because it's simpler, even when it's dangerous for large files (risking token truncation or accidental deletion of code).

2. **Session Notepad fragment** (`notepad.ts`): Descriptive rather than prescriptive. It told the agent what the notepad *is*, but not *when* or *how* it should be used to be effective.

3. **Current Focus fragment** (`focus.ts`): Hyperbolic "UTTERLY OBSESSED" language could trigger an LLM's refusal or "over-correction" behavior where it ignores critical side-effects or warnings because it's too focused on the one goal. It lacked a "safety valve."

4. **Workspace fragment** (`startup.ts`): Potentially contradictory. Immediately after telling the agent "Do NOT use paths like /home/...", the fragment provides the `User's home directory` (which is a `/home/...` path). This can confuse the agent on whether the home directory is a "safe zone" or a forbidden zone.

## Decision

### 1. File Editing fragment

Changed from a passive preference to a firm guideline:

```
# File Editing

**Guideline:** When modifying existing files, use `apply_diff` to ensure precision and prevent data loss. Use `write` only for creating new files or performing complete rewrites. If `apply_diff` is not available when you need to edit, mount it via `runtime__mount_tool({ "tool": "file__apply_diff" })`.
```

### 2. Session Notepad fragment

Shifted from a descriptive tone to an operational one, emphasizing "working memory" over "TODO list":

```
# Session Notepad

===

${state.currentNotepad}

===

Use the `notepad__*` tools to maintain a "working memory" for the current session. This is ideal for tracking complex constraints, temporary variables, or specific notes that should remain visible above the conversational noise. Refer to this notepad to maintain continuity during complex multi-step tasks.
```

### 3. Current Focus fragment

Replaced hyperbolic "obsessed" language with high-authority "Strict Adherence" language and added clear exit conditions:

```
# Current Focus

**Primary Objective:** ${state.currentFocus}

**Strict Adherence:** You are currently in a "focused state." Prioritize all actions toward fulfilling this objective and do not deviate from it until the task is finished or you have been explicitly told to clear your focus. You may only deviate if you encounter a critical blocker that requires immediate resolution to proceed.
```

### 4. Workspace fragment

Clarified boundaries and added a "user override" clause to resolve contradictions:

```
# Workspace

**Root Directory:** ${cwd}
**Path Rule:** All file paths in this session should be relative to this directory.
**Boundary:** Do not assume or use paths outside this workspace (e.g., /workspace/... or /home/...) unless specifically instructed to do so by the user or unless accessing the User Home Directory listed below.

**User Home:** ${homeDir}
**OS:** ${osInfo}
**Current Time:** ${dateTime}
```

## Consequences

- The file editing fragment now provides firmer guidance without being so aggressive that "explore" agents panic-mount `apply_diff` for every tiny read operation.
- The notepad fragment encourages use as a cognitive aid without forcing it to become a redundant second TODO list.
- The focus fragment maintains intensity but adds a clear exit condition.
- The workspace fragment has clear boundaries with an explicit "User Override" clause.

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — The `file`, `notepad`, `focus`, and `startup` plugin rows
- notepad — Session notepad concept
- session-management — Session state and context budgeting
