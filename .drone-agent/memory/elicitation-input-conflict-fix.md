---
key: elicitation-input-conflict-fix
tags:
  - tui
  - elicitation
  - bug-fix
  - persona
created: 2026-06-25T06:18:10.522Z
updated: 2026-06-25T06:18:10.522Z
---

# Implementation Plan: Disable Chat Input During Freeform Elicitation

## Problem
When using `/persona create` in the TUI, the prompt to enter the persona's name appears, but `<enter>` sends the answer to BOTH the elicitation prompt AND the chat input.

## Root Cause
In `app.tsx`, both `<InputLine>` (chat input) and `<ElicitationPrompt>` are rendered simultaneously when a question is active:

```tsx
// Line ~538
<InputLine
  value={input}
  onChange={setInput}
  onSubmit={value => {
    setInput('');
    void runSlashCommand(value);
  }}
  ...  // No disabled/focus prop
/>

{activeQuestion ? (
  <ElicitationPrompt ... />
) : null}
```

The `InputLine` component has a `focus` prop that controls whether its input handler is active (see `MultilineTextInput.tsx` lines ~43-46). However, `InputLine` always passes `focus={true}` (or defaults to true).

When a freeform question is active:
1. User types characters → both elicitation input AND main input receive them
2. User presses Enter → both elicitation AND chat submit handlers fire

## Solution
Pass `focus={!activeQuestion}` to `InputLine` so it only listens when there's no active elicitation question.

## Implementation Steps

### Step 1: Add `disabled` or `focus` prop to InputLine component
**File:** `src/tui/components/InputLine.tsx`

Add a `disabled` prop (or reuse `focus` from existing MultilineTextInput):

```tsx
// In props interface, add:
disabled?: boolean;

// In component, pass to MultilineTextInput:
<MultilineTextInput
  value={value}
  onChange={onChange}
  onSubmit={onSubmit}
  focus={!disabled}  // Pass inverted disabled state
/>
```

### Step 2: Pass disabled state from App
**File:** `src/tui/app.tsx`

Around line 538, modify the InputLine call:

```tsx
<InputLine
  value={input}
  onChange={setInput}
  onSubmit={value => {
    setInput('');
    void runSlashCommand(value);
  }}
  scheme={scheme}
  promptLabel={buildPromptLabel(opts)}
  llmFrame={llmFrame}
  llmColor={llmColor}
  disabled={activeQuestion !== null}  // ADD THIS LINE
/>
```

## Behavior After Fix
- **Freeform questions:** Main input is disabled, user types only in elicitation prompt, Enter submits only there
- **Closed-set (picker) questions:** Main input is disabled, but user uses arrow keys (handled by app.tsx's useInput) - this prevents accidental chat input during selection
- **After question resolves:** Main input re-enables, user can type chat messages or slash commands

## Files to Modify
1. `drone-agent/src/tui/components/InputLine.tsx` - Add disabled prop support
2. `drone-agent/src/tui/app.tsx` - Pass disabled={activeQuestion !== null} to InputLine

## Testing
1. Run `/persona create`
2. When prompted for name, verify typing appears only in elicitation prompt
3. Press Enter - should submit to elicitation, NOT to chat
4. Verify chat input is disabled during elicitation (cannot type in main input)