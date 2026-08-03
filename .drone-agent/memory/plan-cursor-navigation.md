---
key: plan-cursor-navigation
tags:
  - plan
  - tui
  - cursor-navigation
  - input
created: 2026-08-03T20:41:28.717Z
updated: 2026-08-03T20:41:28.717Z
---

# Plan: Enhanced Cursor Navigation for TUI Input

## Summary

Improve the `MultilineTextInput` component with full keyboard cursor navigation (Up/Down arrows, Home/End, Ctrl+Left/Right word-jump, Ctrl+U/K line kill), visual line tracking with word-wrap awareness, and mouse click-to-position (SGR mode 1000). Replace the simpler `FreeformInput` in `ElicitationPrompt.tsx` with the enhanced `MultilineTextInput`.

## Why

The current input only supports Left/Right arrow navigation. Users composing multi-line messages (Ctrl+J) have no way to navigate back to earlier lines without deleting and retyping. The visual line model also fixes a subtle rendering glitch where soft-wrapped lines don't track cursor position correctly.

## Architecture

### New module: `src/tui/shared/visual-text-model.ts`

A pure, testable module that models text as visual lines with word-wrap awareness. No React dependencies.

**Exports:**

```ts
type VisualLine = {
  /** Character offset of the first character in this visual line */
  startOffset: number;
  /** Character offset of the first character past this visual line (exclusive) */
  endOffset: number;
  /** Whether this visual line is a continuation of a soft-wrapped logical line */
  isContinuation: boolean;
};

function computeVisualLines(text: string, width: number): VisualLine[];
function offsetToVisual(text: string, offset: number, width: number): { line: number; col: number };
function visualToOffset(text: string, line: number, col: number, width: number): number;
function findWordStart(text: string, offset: number): number;
function findWordEnd(text: string, offset: number): number;
function findLineStart(text: string, offset: number): number;
function findLineEnd(text: string, offset: number): number;
```

**Word-wrap algorithm:** Split on `\n` for logical lines, then for each logical line, split into words (whitespace boundaries), and pack words into visual lines of at most `width` characters. A word longer than `width` is character-wrapped as a fallback.

### New hook: `src/tui/hooks/useSgrMouse.ts`

Enables SGR mouse mode (1000 + 1006) on mount, disables on unmount. Returns click events.

```ts
type SgrMouseEvent = {
  row: number;   // 1-based terminal row
  col: number;   // 1-based terminal column
  button: 'left' | 'middle' | 'right';
  action: 'press' | 'release';
};

function useSgrMouse(): { lastClick: SgrMouseEvent | null };
```

Mode 1000 = report button press/release events (not drags). Mode 1006 = SGR extended coordinates (supports > 223 rows/cols). No mode 1002 = drag events are NOT captured, so native text selection via drag still works.

### Modified: `MultilineTextInput.tsx`

**New props:**
- `columns: number` — terminal width for visual line calculation
- `onMouseClick?: (row: number, col: number) => void` — mouse click handler

**New keybindings:**

| Key | Action |
|---|---|
| Up arrow | Move cursor up one visual line (preferred column tracking) |
| Down arrow | Move cursor down one visual line (preferred column tracking) |
| Home | Move cursor to start of logical line |
| End | Move cursor to end of logical line |
| Ctrl+Left | Move cursor to start of previous word |
| Ctrl+Right | Move cursor to start of next word |
| Ctrl+U | Delete from cursor to start of logical line |
| Ctrl+K | Delete from cursor to end of logical line |

**Preferred column tracking:** Store `preferredColumn` in a ref. On Up/Down, compute the visual column of the current cursor, store it as preferred. On subsequent Up/Down, use preferred column instead of the new line's actual column. On any non-vertical movement (Left/Right, typing, click), reset preferred column to null.

**Mouse click:** When a click event arrives, compute the visual line/column from the terminal row (relative to the input box's position) and convert to a character offset. The input box's screen position is tracked via a ref set on the outer `<Box>` element using Ink's `useStdout` and measuring rendered height.

### Modified: `InputLine.tsx`

- Accept `columns: number` prop
- Pass it through to `MultilineTextInput`

### Modified: `app.tsx`

- Import and use `useSgrMouse` hook
- Import `useDebouncedWindowSize` (already used) and pass `columns` to `InputLine`
- Wire mouse click events to `MultilineTextInput` via a ref/callback pattern

### Modified: `ElicitationPrompt.tsx`

- Replace `FreeformInput` with `MultilineTextInput`
- Pass `columns` through from the parent
- Remove the now-unused `FreeformInput` component

---

## Step-by-step Implementation Plan

### Step 1: Create `visual-text-model.ts`

**File:** `drone-agent/src/tui/shared/visual-text-model.ts`

**Agent:** coder

**Instructions:**

Create a pure module with the following exports:

1. `VisualLine` type as described above
2. `computeVisualLines(text, width)` — word-wrap algorithm
3. `offsetToVisual(text, offset, width)` — map char offset to visual position
4. `visualToOffset(text, line, col, width)` — map visual position to char offset
5. `findWordStart(text, offset)` — find start of word at/before offset
6. `findWordEnd(text, offset)` — find end of word at/after offset
7. `findLineStart(text, offset)` — find start of logical line (previous `\n` or 0)
8. `findLineEnd(text, offset)` — find end of logical line (next `\n` or end)

Word-wrap details:
- Split text on `\n` to get logical lines
- For each logical line, split into words on whitespace boundaries (preserve whitespace as part of the word they trail)
- Pack words into visual lines: if adding a word would exceed `width`, start a new visual line
- If a single word exceeds `width`, character-wrap it (split at `width` boundary)
- Mark continuation lines with `isContinuation: true`

**Dependencies:** None (pure TypeScript, no React/Ink imports)

**Tests:** `drone-agent/test/visual-text-model.test.ts` — cover:
- Empty string
- Single line shorter than width
- Single line that wraps
- Multiple logical lines
- Word longer than width (character-wrap fallback)
- offsetToVisual round-trip
- visualToOffset round-trip
- Word boundary detection
- Line start/end detection

### Step 2: Create `useSgrMouse.ts`

**File:** `drone-agent/src/tui/hooks/useSgrMouse.ts`

**Agent:** coder

**Instructions:**

Create a React hook that:

1. On mount, writes `\x1b[?1000h\x1b[?1006h` to stdout (enable SGR mouse mode 1000 + 1006)
2. On unmount, writes `\x1b[?1000l\x1b[?1006l` to stdout (disable)
3. Listens to `process.stdin` `data` events for SGR mouse escape sequences: `\x1b[<row;col;buttonM` (press) or `\x1b[<row;col;buttonm` (release)
4. Parses the row, col, and button (0=left, 1=middle, 2=right)
5. Returns `{ lastClick: SgrMouseEvent | null }` — updated on each click

**Important:** Only mode 1000 (not 1002) is enabled, so drag events are NOT captured. This preserves native text selection via drag.

**Edge cases:**
- If stdin is not a TTY, do nothing
- If the terminal doesn't support SGR (1006), the escape sequences will just display as garbage characters in the input — this is acceptable degradation
- Buffer partial sequences across multiple `data` chunks

**Tests:** `drone-agent/test/useSgrMouse.test.tsx` — cover:
- Enable/disable sequences written on mount/unmount
- Parsing of SGR mouse events
- No-op when stdin is not a TTY

### Step 3: Modify `MultilineTextInput.tsx`

**File:** `drone-agent/src/tui/components/MultilineTextInput.tsx`

**Agent:** coder

**Instructions:**

Add the following changes:

1. **New props:**
   - `columns: number` (required)
   - `onMouseClick?: (row: number, col: number) => void` (optional)

2. **State changes:**
   - Replace flat `cursorOffset` with a ref-based model that also tracks `preferredColumn: number | null`
   - Add a ref for the input container element to measure its screen position

3. **New keybindings** (add to `useInput` handler, before the Left/Right arrow handling):

   ```ts
   // Up arrow — move up one visual line
   if (key.upArrow) {
     const visual = offsetToVisual(value, offset, columns);
     if (visual.line > 0) {
       const preferred = preferredColumnRef.current ?? visual.col;
       const newOffset = visualToOffset(value, visual.line - 1, preferred, columns);
       setCursorOffset(newOffset);
       preferredColumnRef.current = preferred;
     }
     return;
   }

   // Down arrow — move down one visual line
   if (key.downArrow) {
     const visual = offsetToVisual(value, offset, columns);
     const lines = computeVisualLines(value, columns);
     if (visual.line < lines.length - 1) {
       const preferred = preferredColumnRef.current ?? visual.col;
       const newOffset = visualToOffset(value, visual.line + 1, preferred, columns);
       setCursorOffset(newOffset);
       preferredColumnRef.current = preferred;
     }
     return;
   }

   // Home — start of logical line
   if (key.home) {
     setCursorOffset(findLineStart(value, offset));
     preferredColumnRef.current = null;
     return;
   }

   // End — end of logical line
   if (key.end) {
     setCursorOffset(findLineEnd(value, offset));
     preferredColumnRef.current = null;
     return;
   }

   // Ctrl+Left — previous word
   if (key.ctrl && input === 'left') { // or detect via key.leftArrow + ctrl
     setCursorOffset(findWordStart(value, offset));
     preferredColumnRef.current = null;
     return;
   }

   // Ctrl+Right — next word
   if (key.ctrl && input === 'right') { // or detect via key.rightArrow + ctrl
     setCursorOffset(findWordEnd(value, offset));
     preferredColumnRef.current = null;
     return;
   }

   // Ctrl+U — delete to start of line
   if (key.ctrl && input === 'u') {
     const lineStart = findLineStart(value, offset);
     const next = value.slice(0, lineStart) + value.slice(offset);
     onChange(next);
     setCursorOffset(lineStart);
     preferredColumnRef.current = null;
     return;
   }

   // Ctrl+K — delete to end of line
   if (key.ctrl && input === 'k') {
     const lineEnd = findLineEnd(value, offset);
     const next = value.slice(0, offset) + value.slice(lineEnd);
     onChange(next);
     preferredColumnRef.current = null;
     return;
   }
   ```

   **Note on Ctrl+Left/Right detection:** Ink's `useInput` provides `key.leftArrow` and `key.ctrl` separately. So `key.leftArrow && key.ctrl` detects Ctrl+Left. Same for Ctrl+Right.

4. **Mouse click handling:**
   - Accept `onMouseClick` prop
   - When a click event fires, the parent (app.tsx) will call this with terminal row/col
   - Convert terminal row/col to visual position using the input box's screen position (tracked via a ref on the outer element)
   - Use `visualToOffset` to find the character offset

5. **Reset preferred column** on Left/Right arrow, typing, paste, and mouse click.

6. **Update `renderWithCursor`** — no changes needed, it already works with flat offset.

**Tests:** Update `drone-agent/test/multiline-text-input.test.tsx` — add tests for:
- Up arrow moves to previous visual line
- Down arrow moves to next visual line
- Home/End navigation
- Ctrl+Left/Right word jump
- Ctrl+U/K line kill
- Preferred column tracking (up from a long line to a short line, then down again)
- Mouse click positioning (mock the visual model)

### Step 4: Modify `InputLine.tsx`

**File:** `drone-agent/src/tui/components/InputLine.tsx`

**Agent:** coder

**Instructions:**

1. Add `columns: number` prop
2. Pass it through to `MultilineTextInput`
3. Add `onMouseClick` prop and pass it through

### Step 5: Modify `app.tsx`

**File:** `drone-agent/src/tui/app.tsx`

**Agent:** coder

**Instructions:**

1. Import `useSgrMouse` from hooks
2. Import `useDebouncedWindowSize` (already imported) — use its `columns` value
3. In the App component body:
   ```ts
   const { columns } = useDebouncedWindowSize(120);
   const { lastClick } = useSgrMouse();
   ```
4. Pass `columns` to `InputLine`
5. Wire mouse clicks: when `lastClick` changes, determine if the click is within the input box area and call the input's click handler. This requires a ref to the input component or a callback pattern.

   **Approach:** Store a callback ref `onInputMouseClick` in a ref. The `InputLine` receives `onMouseClick` and passes it to `MultilineTextInput`. When `MultilineTextInput` mounts, it sets the callback. When a mouse click arrives, `app.tsx` calls the callback with the terminal row/col.

   ```ts
   const onInputMouseClickRef = useRef<((row: number, col: number) => void) | null>(null);

   // In the render:
   <InputLine
     onMouseClick={(row, col) => { onInputMouseClickRef.current = (row, col); }}
     ...
   />

   // Effect to handle mouse clicks:
   useEffect(() => {
     if (lastClick && onInputMouseClickRef.current) {
       onInputMouseClickRef.current(lastClick.row, lastClick.col);
     }
   }, [lastClick]);
   ```

   Actually, a simpler approach: pass `lastClick` as a prop to `InputLine` → `MultilineTextInput`, and have `MultilineTextInput` process it in a `useEffect`. This avoids the ref callback pattern.

   ```tsx
   // In app.tsx:
   <InputLine
     columns={columns}
     mouseClick={lastClick}
     ...
   />
   ```

### Step 6: Replace `FreeformInput` with `MultilineTextInput`

**File:** `drone-agent/src/tui/components/ElicitationPrompt.tsx`

**Agent:** coder

**Instructions:**

1. Remove the `FreeformInput` component entirely
2. Replace its usage in `FreeformPrompt` with `MultilineTextInput`
3. Pass `columns` prop through from the parent
4. The `FreeformPrompt` already has `value`, `onChange`, `onSubmit` — these map directly to `MultilineTextInput`'s props
5. Add `onSubmit` to `MultilineTextInput` — when Enter is pressed, call `onSubmit` with the current value (this already exists)
6. Remove the `useBracketedPaste` import from `ElicitationPrompt.tsx` since `MultilineTextInput` already handles paste

### Step 7: Update tests

**Files:**
- `drone-agent/test/multiline-text-input.test.tsx`
- `drone-agent/test/visual-text-model.test.ts` (new)
- `drone-agent/test/useSgrMouse.test.tsx` (new)
- `drone-agent/test/elicitation.test.ts` (update for FreeformInput removal)

**Agent:** tester

**Instructions:**

1. **`visual-text-model.test.ts`** — comprehensive tests for the pure module (see Step 1)
2. **`multiline-text-input.test.tsx`** — add tests for all new keybindings
3. **`useSgrMouse.test.tsx`** — test SGR mouse hook
4. **`elicitation.test.ts`** — update to reflect that FreeformInput is now MultilineTextInput

### Step 8: Verify

**Agent:** reviewer

**Instructions:**

1. Run `pnpm -r run typecheck` — must pass with zero errors
2. Run `pnpm -r run lint` — must pass with zero errors
3. Run `pnpm -r run test` — must pass with zero errors
4. Run `pnpm -r run build` — must pass with zero errors
5. Manual smoke test: launch the TUI and verify:
   - Up/Down arrows navigate visual lines
   - Home/End jump to logical line boundaries
   - Ctrl+Left/Right jump words
   - Ctrl+U/K kill lines
   - Mouse click positions cursor (in a terminal that supports SGR)
   - Freeform elicitation input works with full navigation

---

## Validation Criteria

- [ ] `pnpm -r run typecheck` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run test` passes with zero errors (all existing + new tests)
- [ ] `pnpm -r run build` passes with zero errors
- [ ] All new code has unit tests
- [ ] No dead code or unused variables
- [ ] No fluff comments (only jsdoc, complex algorithm explanations, or TODO/FIXME)
- [ ] `FreeformInput` component is removed (not just deprecated)
- [ ] SGR mouse mode 1000 (not 1002) — text selection via drag still works
- [ ] Visual line model handles word-wrap correctly for all edge cases
- [ ] Preferred column tracking works correctly for Up/Down navigation
