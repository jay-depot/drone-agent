---
key: plan-fix-tui-markdown-color-collisions
tags:
  - plan
  - tui
  - markdown
  - syntax-highlighting
  - phase-1
created: 2026-08-26T00:08:25.974Z
updated: 2026-08-26T00:08:25.974Z
---

PLAN: Fix TUI markdown fg/bg color collisions (Phase 1 of 2) — status: ready for execution.

WHY: Some markdown constructs render text invisible because foreground color equals (or is promoted onto) background color. Empirically probed via ink-testing-library with FORCE_COLOR=2:
1. Inline codespans (Markdown.tsx ~L147) hardcode `<Text backgroundColor="gray" color="black">`. When nested in `<Text bold>` (**bold** prose), the parent leaves SGR 1 active; terminals with bold-promotion render fg black(30) as bright black(90) = the exact palette slot of bg gray(100). Emitted: `\e[1mbefore \e[100m\e[30midentifierName\e[39m\e[49m` → invisible on xterm.js/VS Code/kitty defaults. Repro: `` `identifierName` `` inside `**bold claim**`.
2. Fenced-code comments: SYNTAX_COLORS.comment='gray' → fg 90 on bg 100 (same slot) → invisible in EVERY terminal.
3. ANSI_COLORS map is lossy: only 8 base colors + gray; hex/256-color configs silently fall back to white ('37'), so users cannot tune their way out. Also SYNTAX_COLORS.strong='bold'/emphasis='italic' are attributes-not-colors → those hljs classes lose styling entirely.
4. Codespan ignores tui.syntaxHighlighting.codeBackground config (hardcoded 'gray').
5. Latent: renderBlockquote joins ReactNode[] into a string → '[object Object]' if reached (currently shadowed by token.text short-circuit).
6. Dead imports in Markdown.tsx: extractTokenText, getTokenColor (imported, unused).

SCOPE (agreed with user): Markdown.tsx + syntax-highlight.ts only. FileReadBlock.tsx untouched — inherits fixes because renderHighlightedTree stays signature-compatible. Blockquote = one-liner collapse to token.text ?? ''. No new required config keys; existing tui.syntaxHighlighting.colors/codeBackground keep working but hex/256 start working and strong:/emphasis: become real attributes. DEFERRED to Phase 2: raw-ANSI survival across Ink soft line wraps (user reports frequent); first-class FileReadBlock migration; SYNTAX_COLORS deprecation/removal.

DESIGN:
A) New exports in drone-agent/src/tui/shared/syntax-highlight.ts:
```ts
export type SyntaxStyle = {
  color?: string;      // named | '#rrggbb' | 0-255/'colorN' — anything chalk accepts
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};
export type SyntaxTheme = Record<string, SyntaxStyle>;
export const DEFAULT_SYNTAX_THEME: SyntaxTheme = {
  keyword: { color: 'magenta' }, function: { color: 'cyan' },
  'function-variable': { color: 'cyan' }, string: { color: 'green' },
  number: { color: 'yellow' }, comment: { italic: true },        // was 'gray' — THE invisible-comment bug
  variable: { color: 'blue' }, attr: { color: 'yellow' },
  tag: { color: 'magenta' }, built_in: { color: 'cyan' },
  literal: { color: 'yellow' }, selector: { color: 'yellow' },
  'selector-class': { color: 'yellow' }, 'selector-id': { color: 'yellow' },
  property: { color: 'blue' }, title: { color: 'cyan' },
  params: { color: 'white' }, sub: { color: 'gray' }, sup: { color: 'gray' },
  emphasis: { italic: true }, strong: { bold: true },            // now actually work
};
export function normalizeLegacyColors(colors?: Record<string, string>): SyntaxTheme
// undefined/empty → DEFAULT_SYNTAX_THEME; key 'bold'|'italic'|'underline' → attribute form;
// else { color: value }. Unknown keys preserved (map semantics, matches config deep-merge).
```
B) SGR emission helpers (internal): sgrOpen(style)/sgrClose(style) emitting in fixed order bold(1)/italic(3)/underline(4) then fg; close in reverse with 22/23/24 + 39. Color translation: '#rrggbb' → 38;2;r;g;b; /^color?(\d{1,3})$/ or bare 0-255 → 38;5;N; base names via existing ANSI_COLORS → 3X (gray→90 kept). UNPARSEABLE value → emit nothing for fg (inherit), NEVER white fallback.
C) renderHighlightedTree(tree, backgroundColor, colors) — SIGNATURE UNCHANGED, accepts legacy Record<string,string> OR SyntaxTheme; normalizeLegacyColors once at entry. Per-token: first hljs-* className match resolves style (existing precedence); wrap token text in sgrOpen/text/sgrClose; padding run gets NO fg SGR (bg-only, collision-proof). Keep emitting backgroundColor first per line (Ink soft-wrap SGR-state caveat is Phase 2).
D) Markdown.tsx codespan becomes `<Text backgroundColor={codeBackground}>{token.text}</Text>` — no color prop → inherits ambient fg incl. parent bold; bg alone differentiates. Fixes bold-promotion collision AND makes codeBackground config work.
E) renderBlockquote: content collapses to `token.text ?? ''` (removes join-on-nodes landmine; matches today's effective output since text short-circuit already wins).
F) Remove dead imports (extractTokenText, getTokenColor) from Markdown.tsx.
G) KEEP SYNTAX_COLORS export unchanged this phase (FileReadBlock fallback feeds legacy format; normalization handles it). Its cleanup belongs to the FileReadBlock-migration phase.

STEPS:
1. [coder] syntax-highlight.ts: add SyntaxStyle/SyntaxTheme/DEFAULT_SYNTAX_THEME/normalizeLegacyColors + sgr helpers. New test/syntax-highlight.test.ts covering: legacy passthrough, attribute keys, hex→38;2, 256→38;5, unknown-key preservation, unparseable→no fg SGR, DEFAULT_SYNTAX_THEME has no color-only-'gray'-on-gray pairs.
2. [coder] Rewrite renderHighlightedTree internals (dual-format input, per-line SGR strategy, bg-only padding). Existing Markdown.test.tsx content assertions stay green.
3. [coder] Markdown.tsx: simplify codespan, remove dead imports, blockquote collapse. Update/extend tests: codespan-in-bold emits NO \e[30m after \e[100m (FORCE_COLOR=2); codeBackground prop honored (custom bg appears in frame); hex + 256 + 'strong:' custom colors produce expected SGR; blockquote with inline markup renders without '[object Object]'.
4. [reviewer] Blunt review: FileReadBlock untouched yet improved; dual-format seam acceptable as temporary; no dead code; comment policy (jsdoc-only) respected; no duplicated color logic.
5. [tester] Full validation sweep (see criteria). Manual visual smoke: run TUI, feed assistant markdown containing bold+codespan + fenced ```ts with comments; verify visibility in real terminal (tmux capture-pane -e for escape-sequence inspection if needed).

TEST INFRA NOTE (critical): ink-testing-library strips color unless FORCE_COLOR is set before ink/chalk import; vitest hoists static imports so top-of-file process.env assignment is too late. Pattern: set process.env.FORCE_COLOR='2' inside the describe, then `const { render } = await import('ink-testing-library')` / `const { Text } = await import('ink')` dynamically. Probes proved frames carry raw SGR under FORCE_COLOR=2.

VALIDATION CRITERIA (all must pass):
- LSP diagnostics: zero errors/warnings across workspace (lsp__get_diagnostics).
- `pnpm -r run build` passes (root).
- `pnpm lint` passes (eslint+prettier; re-read files after prettier reformat before any further edits).
- `pnpm test` fast suite green, including new test/syntax-highlight.test.ts and extended test/Markdown.test.tsx.
- Behavioral asserts: (a) codespan-in-bold output contains no fg-black-after-bg-gray sequence; (b) comment-styled tokens never emit \e[90m adjacent to \e[100m; (c) hex/256 custom colors appear as truecolor/256 SGR; (d) 'strong:'/'emphasis:' config entries yield bold/italic SGR; (e) codeBackground prop reaches codespans; (f) no '[object Object]' anywhere.
- Manual: bold+codespan and code comments visibly readable in a live terminal run.
- All existing 10 Markdown.test.tsx tests remain passing.

PHASE 2 BACKLOG (separate planning session): raw ANSI codes breaking across Ink soft line wraps in highlighted output; migrate FileReadBlock to SyntaxTheme natively; retire/deprecate SYNTAX_COLORS + ANSI_COLORS public surface; consider blockquote inline-markdown rendering upgrade.