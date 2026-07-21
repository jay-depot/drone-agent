---
key: tui-issue2-syntax-highlighting-fix
tags:
  []
created: 2026-07-20T00:55:15.655Z
updated: 2026-07-21T18:08:03.288Z
---

# Plan: Syntax highlighting fixes

## Summary

Two issues with the TUI's syntax-highlighted code blocks:

1. **Background doesn't fill the box width** — Each line in `renderHighlightedTree()` is rendered as `<Text backgroundColor={...}>{line}</Text>`, but the background only extends to the end of the text on each line, not the full width of the code block. The code block has a border with `paddingX={1}`, so the visual gap is noticeable on short lines.

2. **Syntax highlighting colors are hardcoded** — `SYNTAX_COLORS` is a module-level `Record<string, string>` in `Markdown.tsx`. Users should be able to customize the color scheme (and the code block background color) via config.

## Config shape

New type in `drone-core/src/config-types.ts`:

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
- Defaults in `createDefaultAgentConfig()` match the current hardcoded values
- Merge logic in `applyAgentConfigLayer()` handles partial overrides (user sets only the keys they want to change)
- User-level config (project-level also works via cascade)

## Threading path

```
App (engine.getConfig().tui)
  ├── ChatLog (new props: syntaxColors, codeBackground)
  │     └── Markdown (new prop: syntaxColors, existing prop: codeBackground)
  └── AssistantMessageBlock (new props: syntaxColors, codeBackground)
        └── Markdown (new prop: syntaxColors, existing prop: codeBackground)
```

## Step-by-step implementation

### Step 1 — Add `DroneTuiConfig` type to drone-core

**File:** `drone-core/src/config-types.ts`

- Add the `DroneTuiConfig` type
- Add `tui: DroneTuiConfig` to `DroneAgentConfig`
- Add `tui?: Partial<DroneTuiConfig>` to `PartialDroneAgentConfig`
- Add defaults in `createDefaultAgentConfig()` (copying the current hardcoded values)
- Add merge logic in `applyAgentConfigLayer()` (deep merge for `syntaxHighlighting.colors`)

### Step 2 — Update Markdown.tsx to accept configurable colors

**File:** `drone-agent/src/tui/components/Markdown.tsx`

- Add `syntaxColors?: Record<string, string>` prop to `MarkdownProps`
- Change `getTokenColor()` to accept a `syntaxColors` parameter instead of using the module-level constant
- Thread `syntaxColors` through `renderToken()` → `renderCodeBlock()` → `renderHighlightedTree()`
- Keep the module-level `SYNTAX_COLORS` as the default value for the prop

### Step 3 — Fix background width in renderHighlightedTree()

**File:** `drone-agent/src/tui/components/Markdown.tsx`

- After splitting the ANSI string into lines, find the longest visual line width (strip ANSI codes for measurement)
- Pad each line with trailing spaces to that width so the `backgroundColor` fills the full box

### Step 4 — Thread config through AssistantMessageBlock.tsx

**File:** `drone-agent/src/tui/components/AssistantMessageBlock.tsx`

- Add `syntaxColors` and `codeBackground` props
- Pass them to `<Markdown>`

### Step 5 — Thread config through ChatLog.tsx

**File:** `drone-agent/src/tui/components/ChatLog.tsx`

- Add `syntaxColors` and `codeBackground` props
- Pass them to `<Markdown>` in `renderEntry()`

### Step 6 — Thread config through App.tsx

**File:** `drone-agent/src/tui/app.tsx`

- Read `tui` config from `opts.engine.getConfig()`
- Pass `syntaxColors` and `codeBackground` to `<ChatLog>` and `<AssistantMessageBlock>`

### Step 7 — Update tests

**File:** `drone-agent/test/Markdown.test.tsx`

- Add a test that verifies background padding: render a code block with lines of different lengths and check that the shorter line is padded to match the longest
- Add a test that verifies custom `syntaxColors` prop overrides the defaults

### Step 8 — Validation

- LSP: zero errors
- `pnpm -r run lint`: zero errors
- `pnpm -r run build`: zero errors
- `pnpm -r run test`: zero errors

## Dependencies

- Step 1 must be done first (config types need to exist before components can use them)
- Steps 2-3 can be done in parallel with Step 1 (they only depend on the types being defined)
- Steps 4-6 depend on Steps 2-3
- Step 7 depends on Steps 2-6
- Step 8 is final validation

## Validation criteria

- [ ] LSP diagnostics: zero errors
- [ ] `pnpm -r run lint`: zero errors
- [ ] `pnpm -r run build`: zero errors
- [ ] `pnpm -r run test`: zero errors
- [ ] Code blocks with lines of varying lengths show background filling the full width
- [ ] Setting `tui.syntaxHighlighting.colors` in user config overrides the default colors
- [ ] Setting `tui.syntaxHighlighting.codeBackground` in user config changes the code block background
- [ ] Partial color overrides work (setting only one color key leaves others at defaults)
- [ ] No regressions in existing Markdown tests