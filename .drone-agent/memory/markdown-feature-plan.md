---
key: markdown-feature-plan
tags:
  - tui
  - markdown
  - planning
created: 2026-06-24T03:17:48.718Z
updated: 2026-06-24T03:17:48.718Z
---

# Markdown Rendering Feature Plan for drone-agent TUI

## Current State
- TUI uses Ink (React for terminals)
- Currently renders plain text with basic color tags
- No markdown rendering exists yet

## Parser Options (pick one)
1. **marked** - Most popular, fast, outputs HTML or tokens
2. **remark** (unified) - More modern, plugins for everything
3. **markdown-it** - Feature-rich, extensible

## Feasible Features by Complexity

### Tier 1: Easy (High Value)
- **Bold** (`**text**` or `__text__`) - Ink `<Text bold>`
- **Italic** (`*text*` or `_text_`) - Ink `<Text italic>`
- **Strikethrough** (`~~text~~`) - Ink `<Text strikethrough>`
- **Inline code** (`` `code` ``) - Different background color
- **Links** (`[text](url)`) - Color + underline (optional)

### Tier 2: Medium (Good Value)
- **Code blocks** (```) - Box with different bg, monospace
- **Syntax highlighting** - `shiki` or `highlight.js` tokenization
- **Headers** (`#`, `##`, `###`) - Larger text + bold
- **Blockquotes** (`> text`) - Left border + italic
- **Lists** (ordered/unordered) - Bullet/number + indentation
- **Horizontal rules** (`---`) - Box border or line

### Tier 3: Ambitious (Lower Priority)
- **Tables** - Box/Grid layout with alignment
- **Nested task lists** - Checkboxes with indentation
- **Images** (alt text only in terminals) - Show alt text as fallback
- **Footnotes** - Render inline as superscript refs

## Code Highlighting Options
1. **shiki** - Best quality, theme support, but larger bundle
2. **highlight.js** - Good selection, lighter than shiki
3. **lowlight** (highlight.js for virtual DOM) - Good for React

## Recommended Approach
- Parse with **marked** (lightweight, flexible)
- Custom renderer that outputs Ink `<Text>` components
- Add syntax highlighting with **lowlight** or basic token colors
- Use existing theme system (DroneColorScheme) for colors

## Next Steps
1. Choose parser (marked vs remark vs markdown-it)
2. Decide on code highlighting (shiki vs highlight.js vs basic)
3. Prototype bold + italic rendering first