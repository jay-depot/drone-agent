---
tags: [decision, tui, syntax-highlighting, markdown, bug-fix]
related: [drone-agent-tui.md, DroneAgentConfig.md, 077-tui-syntax-highlighting-ansi-escape-codes.md, 055-tui-tail-scrollback-formatting-preservation.md]
---

# 163: TUI Markdown Foreground/Background Color Collision Fix

**Status**: Implemented (2026-08-26, branch `feat/display-fixes`, commit `63f0f67b`)

## Context

Markdown text in the TUI could become literally invisible because a foreground color equaled — or was promoted onto — the code background color. The failure class was established empirically by probing rendered output with `ink-testing-library` under `FORCE_COLOR=2` and reading raw escape sequences out of Ink frames. Six defects, two visible and four latent:

1. **Inline codespans forced `fg black` on `bg gray`.** `Markdown.tsx` rendered `` `code` `` as `<Text backgroundColor="gray" color="black">`. When nested inside `<Text bold>` prose (e.g. `` **bold claim** `identifierName` ``), the parent leaves SGR 1 active, and terminals with **bold-promotion** render requested fg black (30) as bright black (90) — which is exactly the palette slot of the gray background (100). Emitted frame: `\e[1mbefore \e[100m\e[30midentifierName\e[39m\e[49m` → invisible on xterm.js / VS Code / kitty defaults.
2. **Every fenced-code comment was invisible everywhere.** `SYNTAX_COLORS.comment = 'gray'` produced fg 90 on bg 100 — the *same* palette slot, no promotion needed.
3. **The `ANSI_COLORS` map was lossy.** Only the 8 base colors + gray existed; configured hex or 256-color values silently fell back to white ('37'), so users could not tune their way out of a collision. Separately, `SYNTAX_COLORS.strong='bold'` and `.emphasis='italic'` encoded *attributes* inside a color map, so those highlight.js classes lost styling entirely.
4. **Codespan background ignored config.** The gray background was hardcoded; `tui.syntaxHighlighting.codeBackground` never applied to inline code.
5. **Latent crash:** `renderBlockquote` joined `ReactNode[]` into a string (`'[object Object]'` if ever reached; currently shadowed by the `token.text` short-circuit).
6. **Dead imports** in `Markdown.tsx`: `extractTokenText`, `getTokenColor` (imported, unused).

Scope agreed up front: `Markdown.tsx` + `syntax-highlight.ts` only. `FileReadBlock.tsx` stays untouched this phase and inherits the fixes because `renderHighlightedTree` remains signature-compatible. Deferred to Phase 2: raw-ANSI survival across Ink soft line wraps (user-reported), first-class `FileReadBlock` migration, and deprecation/removal of the `SYNTAX_COLORS`/`ANSI_COLORS` public surface.

## Decision

### Fix 1: Attribute-aware `SyntaxStyle` / `SyntaxTheme` model

Token styling moves from string-valued pseudo-colors to a structured style:

```typescript
type SyntaxStyle = { color?: string; bold?: boolean; italic?: boolean; underline?: boolean };
type SyntaxTheme = Record<string, SyntaxStyle>; // highlight.js class name → style
```

Attributes are first-class instead of being smuggled through color strings, so `strong`/`emphasis` get real styling and any style may combine a color with attributes. In `DEFAULT_SYNTAX_THEME`, comment styling is **deliberately italic-only**: an attribute-only style carries no foreground, making collision with any background impossible by construction. This kills the universal gray-on-gray invisible-comment bug rather than picking a different gray.

### Fix 2: Proper SGR emission (`sgrOpen` / `sgrClose`)

Opening sequence emits attributes in fixed order — bold (1), italic (3), underline (4) — then foreground; closing mirrors it (39 first, then 22/23/24 in reverse-open order). Color parsing upgrades from the 9-entry name map to: hex (`#rgb`/`#rrggbb` → `38;2;r;g;b`), decimal 256-color indices (≤255 → `38;5;n`), and named base colors (`3X`/`90`). An **unparseable color emits no foreground at all** — the text inherits the ambient foreground instead of being forced to white, so a config typo degrades to readable-but-unstyled rather than silently wrong.

### Fix 3: Dual-format seam in `renderHighlightedTree`

The function keeps its `(tree, backgroundColor, colors)` signature, but the third parameter now accepts either the legacy `Record<string, string>` map or a `SyntaxTheme`; input is normalized once up front (`normalizeLegacyColors` maps `'bold'`/`'italic'`/`'underline'` values to attributes and everything else to `{ color }`). This is what lets untouched callers (`FileReadBlock`) pick up the new behavior with zero changes. Line padding continues to fill the background width but now carries **no foreground SGR** — padding spaces need no fg, and fg-bearing padding is precisely how collisions crept in.

### Fix 4: Codespans render background-only

Inline code is now `<Text backgroundColor={codeBackground}>` with **no forced foreground** — the codespan inherits the surrounding prose color. The bold-promotion collision is structurally impossible: whatever fg the ambient context resolves to cannot equal the background unless the theme itself sets it. The background now honors `tui.syntaxHighlighting.codeBackground`.

### Fixes 5 & 6: Landmine removal

`blockquote` collapses to `token.text ?? ''` (deleting the ReactNode-join hazard), and the dead imports are removed.

### Fix 7 (found by the new tests): drop the legacy default in `Markdown.tsx`

The component's default `syntaxColors = SYNTAX_COLORS` prop meant `DEFAULT_SYNTAX_THEME` never engaged on the default path — frames still showed `\e[100m\e[90m// comment` even after the renderer upgrade. The default was dropped; omission now falls through to `DEFAULT_SYNTAX_THEME` inside `renderHighlightedTree`. `SYNTAX_COLORS` remains exported solely for `FileReadBlock` until the Phase 2 migration, and `tsc` required widening `renderToken`/`renderCodeBlock` color params to `Record<string,string> | undefined` once the default disappeared.

## Alternatives Considered

| Alternative | Verdict |
|-------------|---------|
| Keep string-encoded pseudo-colors (`'bold'`/`'italic'`) | Rejected — lossy, blocks hex/256 support, keeps the collision class alive |
| Force a known-safe fg (e.g. white) on codespans | Rejected — overrides user prose/theme colors; inheritance is strictly safer |
| White fallback for unparseable config colors (prior behavior) | Rejected — silent misconfiguration; emitting nothing makes bad values visible-but-readable |
| Migrate `FileReadBlock` to `SyntaxTheme` natively now | Deferred — scope control; it inherits the fixes via the dual-format input |

## Validation

- LSP: zero TypeScript errors/warnings workspace-wide (six pre-existing CSS `unknownAtRules` warnings in untouched `drone-coordinator-ui` remain, documented, not ours).
- `pnpm -r run build` ✅ · `pnpm lint` ✅ · fast suite ✅ 157 files / 2290 tests.
- New `drone-agent/test/syntax-highlight.test.ts`: 22 tests over literal SGR emission, normalization, and bg-only padding. `Markdown.test.tsx` grew 9 → 16 with a "foreground/background collision regressions" suite asserting raw escape codes in ink frames.
- Each planned behavioral assert (a)–(f) mapped to a named passing test via `--reporter=verbose`.
- Manual smoke: real Ink renderer in tmux, `capture-pane -e` ground truth — codespans emit `\e[100midentifierName\e[49m` (no fg between), comments emit italic + `\e[100m` only, keyword/string/number tokens colored distinctly on the background, padding fg-free.

## Phase 2 Backlog (unchanged)

Raw ANSI across Ink soft line wraps; native `FileReadBlock` `SyntaxTheme` migration + retiring the `SYNTAX_COLORS`/`ANSI_COLORS` public surface; blockquote inline-markdown rendering upgrade (`normalizeLegacyColors` gains its first production caller in that migration).

## Related

- [[decisions/077-tui-syntax-highlighting-ansi-escape-codes]] — the v2 raw-ANSI pipeline this fix hardens
- [[decisions/046-tui-tail-region-refactor]] — tail region rendering context
- [[decisions/055-tui-tail-scrollback-formatting-preservation]] — why Markdown renders identically in tail and scrollback
- [[modules/drone-agent-tui]] — module overview and the v1 → v2 → v3 pipeline history
