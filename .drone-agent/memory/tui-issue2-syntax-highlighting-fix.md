---
key: tui-issue2-syntax-highlighting-fix
tags:
  - plan
  - tui
  - syntax-highlighting
  - bug-fix
  - completed
created: 2026-07-20T00:55:15.655Z
updated: 2026-07-20T01:00:13.129Z
---

# Plan: Fix syntax highlighting bugs in Markdown.tsx

## Summary

The recent fix to `renderHighlightedTree` (commit `1e1a7c8`) replaced nested `<Text>` elements with raw ANSI escape codes to avoid Yoga layout bugs. However, it introduced two bugs:

1. **Stray `"undefined"` strings** — The lowlight AST contains **element nodes** (with `children` arrays) alongside **text nodes** (with `value` strings). When `token.value` is `undefined` (element nodes), JavaScript string interpolation converts it to the literal string `"undefined"`.

2. **No color** — The old code used `token.type` (`'text'` or `'element'`) as the key into `SYNTAX_COLORS`, which never matched. The actual color information is in `token.properties.className` (e.g., `['hljs-keyword']`), which was never consulted.

## Root cause analysis

Lowlight's AST structure:
- **Text nodes**: `{ type: 'text', value: 'const' }` — have `value`, no `children`, no `properties`
- **Element nodes**: `{ type: 'element', tagName: 'span', properties: { className: ['hljs-keyword'] }, children: [{ type: 'text', value: 'const' }] }` — have `children`, no `value`, color info in `properties.className`

The old code rendered each token as a separate `<Text>` element. React silently ignored `undefined` children, so element nodes produced no visible output (but also no color). The new code concatenates into a string, exposing the `undefined` values.

## Plan

### Step 1: Add `extractTokenText` helper function

Add a recursive function that extracts text from both text nodes and element nodes:

```tsx
function extractTokenText(token: any): string {
  if (token.value) return token.value;
  if (token.children) {
    return token.children.map(extractTokenText).join('');
  }
  return '';
}
```

### Step 2: Add `getTokenColor` helper function

Add a function that extracts the color from a token's className:

```tsx
function getTokenColor(token: any): string {
  // Element nodes carry color info in properties.className (e.g. ['hljs-keyword'])
  if (token.properties?.className) {
    for (const cls of token.properties.className) {
      if (typeof cls === 'string' && cls.startsWith('hljs-')) {
        const key = cls.slice(5); // strip 'hljs-' prefix
        if (SYNTAX_COLORS[key]) return SYNTAX_COLORS[key];
      }
    }
  }
  // Text nodes and fallback: use default color
  return 'white';
}
```

### Step 3: Update `renderHighlightedTree` to use the new helpers

Replace the inner loop:

```tsx
for (const token of tokens) {
  const color = SYNTAX_COLORS[token.type] || 'white';
  const ansiCode = ANSI_COLORS[color] || '37';
  rendered += `\u001b[${ansiCode}m${token.value}\u001b[39m`;
}
```

With:

```tsx
for (const token of tokens) {
  const color = getTokenColor(token);
  const ansiCode = ANSI_COLORS[color] || '37';
  const text = extractTokenText(token);
  if (text) {
    rendered += `\u001b[${ansiCode}m${text}\u001b[39m`;
  }
}
```

### Step 4: Add unit tests

Create `drone-agent/test/tui/Markdown.test.tsx` with tests for:
- Code block with syntax highlighting (TSX) — verify no `"undefined"` strings in output
- Code block with plaintext — verify plain rendering
- Code block with mixed element/text nodes — verify colors are applied
- Inline codespan — verify it still works

### Step 5: Verify

- `pnpm -r run test` passes
- LSP diagnostics pass
- `pnpm -r run build` passes
- `pnpm -r run lint` passes

## Validation criteria

- [x] No `"undefined"` strings appear in syntax-highlighted output
- [x] Syntax highlighting applies correct colors (keyword=magenta, string=green, number=yellow, etc.)
- [x] All existing tests pass
- [x] New tests cover the fix
- [x] LSP diagnostics pass
- [x] `pnpm -r run build` passes
- [x] `pnpm -r run lint` passes

## Work completed (2026-07-19)

Implemented the fix in commit `8854f09`:

1. Added `extractTokenText(token)` — recursively extracts text from both text nodes (`value`) and element nodes (`children`)
2. Added `getTokenColor(token)` — reads `properties.className`, strips `hljs-` prefix, looks up color in `SYNTAX_COLORS`
3. Updated `renderHighlightedTree` loop to use both helpers, skipping empty text
4. Added `drone-agent/test/Markdown.test.tsx` with 6 tests covering TSX, JS, Python code blocks, plaintext blocks, mixed element/text tokens, and inline codespan
5. All validation criteria pass: 1483 tests (99 files), clean LSP, build, lint