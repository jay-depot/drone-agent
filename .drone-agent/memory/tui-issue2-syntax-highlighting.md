---
key: tui-issue2-syntax-highlighting
tags:
  - tui
  - bugs
  - syntax-highlighting
  - plan
created: 2026-07-20T00:38:46.154Z
updated: 2026-07-20T00:38:46.154Z
---

# Plan: Fix syntax-highlighted code blocks (TUI Issue 2)

## Summary

`renderHighlightedTree()` renders each syntax token as a separate nested `<Text>` element. In Ink, nested `<Text>` elements with different `color` props create separate Yoga layout nodes, and Yoga miscalculates the inline flow, inserting line breaks between tokens. The fix: render each line as a single `<Text>` element with raw ANSI escape codes for color changes — the same pattern used by `renderWithCursor()` in `MultilineTextInput.tsx`.

## Steps

### Step 1: Add ANSI color helper

Add a helper function that maps a color name to its ANSI foreground code. Ink's `<Text color={...}>` uses the same color names as terminal ANSI codes, so we can build a simple mapping.

### Step 2: Rewrite `renderHighlightedTree`

Replace the nested `<Text>` approach with a single `<Text>` per line containing raw ANSI escape codes:

```tsx
function renderHighlightedTree(tree: any, backgroundColor: string): ReactNode {
  const lines = tree.children;
  return (
    <>
      {lines.map((line: any, lineIndex: number) => {
        const tokens = line.children ?? [];
        let rendered = '';
        for (const token of tokens) {
          const color = SYNTAX_COLORS[token.type] || 'white';
          const ansiCode = ANSI_COLORS[color] || '37';
          rendered += `\u001b[${ansiCode}m${token.value}\u001b[39m`;
        }
        return (
          <Text key={lineIndex} backgroundColor={backgroundColor}>
            {rendered || line.value}
          </Text>
        );
      })}
    </>
  );
}
```

### Step 3: Verify build, lint, and tests pass

- LSP must pass
- `pnpm -r run build` must pass
- `pnpm -r run lint` must pass
- `pnpm exec vitest run` must pass

## Validation Criteria

- [ ] `renderHighlightedTree` uses raw ANSI escape codes instead of nested `<Text>` elements
- [ ] Code blocks render as readable inline text without spurious newlines between tokens
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
