---
tags: [decision, tui, syntax-highlighting, markdown]
related: [drone-agent-tui.md, DroneAgentConfig.md, 001-use-ink.md, 046-tui-tail-region-refactor.md]
---

# 077: TUI Syntax Highlighting — ANSI Escape Codes + Configurable Colors

**Status**: Implemented (2026-07-21, branch `fix/tui-syntax-highlighting`, 7 commits)

## Context

The TUI's syntax-highlighted code blocks had three bugs:

1. **Yoga layout breaks between tokens** — `renderHighlightedTree()` rendered each syntax token as a separate nested `<Text color={...}>` element. Ink's Yoga layout creates separate layout nodes for each nested `<Text>`, miscalculating the inline flow and inserting spurious line breaks between tokens. This made syntax-highlighted code blocks unreadable.

2. **Stray "undefined" strings and missing colors** — The lowlight AST has two node types: text nodes (with `value`) and element nodes (with `children` arrays and color info in `properties.className`). The original code used `token.value` directly (undefined for element nodes → literal "undefined" in output) and `token.type` as the color key (never matched → no color applied).

3. **Flat AST not treated as flat** — The lowlight AST is flat: `tree.children` is an array of all tokens, not an array of lines. Newlines are embedded inside text node values (e.g., `";\n"`). The original code treated each token as a separate line, putting each on its own `<Text>` element, causing spurious line breaks between every token.

Additionally, two enhancements were needed:

4. **Background doesn't fill box width** — Each line is rendered as `<Text backgroundColor={...}>{line}</Text>`, but the background only extends to the end of the text. Short lines leave a visual gap inside the bordered code block.

5. **Syntax colors are hardcoded** — `SYNTAX_COLORS` was a module-level constant in `Markdown.tsx`. Users couldn't customize the color scheme or code block background.

## Decision

### Fix 1: Raw ANSI escape codes instead of nested `<Text>` elements

Replace the nested `<Text color={...}>` approach with a single `<Text>` per line containing raw ANSI escape codes for color changes. Add an `ANSI_COLORS` mapping from Ink color names to ANSI foreground codes:

```typescript
const ANSI_COLORS: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37', gray: '90',
};
```

Each token is rendered as `\u001b[${ansiCode}m${text}\u001b[39m` (set color, text, reset). This avoids Yoga layout nodes entirely — Ink sees a single `<Text>` with raw escape sequences and renders them inline.

### Fix 2: Proper lowlight AST traversal

Add two helper functions:

- **`extractTokenText(token)`** — recursively walks `children` arrays to extract text from both text nodes (`token.value`) and element nodes (`token.children`). Returns `''` for empty tokens (no stray "undefined").

- **`getTokenColor(token, syntaxColors)`** — reads `token.properties.className`, strips the `hljs-` prefix (e.g., `['hljs-keyword']` → `'keyword'`), and looks up the color in the provided `syntaxColors` map. Falls back to `'white'` for text nodes (no className) or unknown types.

### Fix 3: Flat AST → single ANSI string → split on `\n`

Build a single ANSI string from all tokens in `tree.children`, then split on `\n` to create one `<Text>` per logical line. This correctly handles newlines embedded inside text node values.

### Fix 4: Background width padding

After splitting into lines, find the longest visual line width (strip ANSI codes for measurement). Pad each line with trailing spaces to that width so `backgroundColor` fills the full code block width.

### Fix 5: Configurable colors via `DroneTuiConfig`

Add a new `DroneTuiConfig` type to `drone-core/src/config-types.ts`:

```typescript
export type DroneTuiConfig = {
  syntaxHighlighting: {
    colors: Record<string, string>;  // e.g. { "keyword": "red", "string": "green" }
    codeBackground: string;          // e.g. "black" or "#333"
  };
};
```

- Added to `DroneAgentConfig` as `tui: DroneTuiConfig`
- Added to `PartialDroneAgentConfig` as `tui?: Partial<DroneTuiConfig>`
- Defaults in `createDefaultAgentConfig()` match the previous hardcoded values
- Merge logic in `applyAgentConfigLayer()` supports partial overrides (setting only one color key leaves others at defaults)
- Config threads through `App.tsx` → `ChatLog.tsx` / `AssistantMessageBlock.tsx` → `Markdown.tsx`
- `App.tsx` uses refs (`syntaxColorsRef`, `codeBackgroundRef`) to avoid stale closures in event listeners

## Consequences

- Syntax-highlighted code blocks are now readable — no spurious line breaks between tokens
- No stray "undefined" strings in highlighted output
- Colors are correctly applied based on lowlight's `hljs-*` class names
- Background fills the full code block width on all lines
- Users can customize colors and background via `tui.syntaxHighlighting.colors` and `tui.syntaxHighlighting.codeBackground` in their config (user or project scope)
- Partial color overrides work — set only the keys you want to change
- ANSI escape codes are consumed by Ink's rendering pipeline and don't appear as raw sequences in output
- 8 new test cases in `Markdown.test.tsx` covering: TSX/JS/Python code blocks, plaintext blocks, mixed element/text tokens, background padding, single-line blocks, custom `syntaxColors` prop, and inline codespan

## Files Changed

| File | Change |
|------|--------|
| `drone-core/src/config-types.ts` | Added `DroneTuiConfig` type, `tui` field to `DroneAgentConfig`/`PartialDroneAgentConfig`, defaults in `createDefaultAgentConfig()`, merge logic in `applyAgentConfigLayer()` |
| `drone-agent/src/tui/components/Markdown.tsx` | Added `ANSI_COLORS` mapping, `extractTokenText()` helper, `getTokenColor()` helper, `syntaxColors` prop, ANSI escape code rendering, flat AST → split on `\n`, background width padding |
| `drone-agent/src/tui/components/AssistantMessageBlock.tsx` | Added `syntaxColors` and `codeBackground` props, passed to `<Markdown>` |
| `drone-agent/src/tui/components/ChatLog.tsx` | Added `syntaxColors` and `codeBackground` props, passed to `renderEntry()` → `<Markdown>` |
| `drone-agent/src/tui/app.tsx` | Reads `tui` config, creates refs, passes to `<ChatLog>` and `<AssistantMessageBlock>` |
| `drone-agent/test/Markdown.test.tsx` | 8 new test cases for syntax highlighting, background padding, custom colors |

## Related

- [[drone-agent-tui]] — TUI architecture
- [[DroneAgentConfig]] — Config schema (now includes `tui` section)
- [[001-use-ink]] — Why Ink was chosen
- [[046-tui-tail-region-refactor]] — Tail region architecture
