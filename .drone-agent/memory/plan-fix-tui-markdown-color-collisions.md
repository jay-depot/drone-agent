---
key: plan-fix-tui-markdown-color-collisions
tags:
  - plan
  - tui
  - markdown
  - syntax-highlighting
  - phase-1
  - completed
created: 2026-08-26T00:08:25.974Z
updated: 2026-08-26T00:39:03.319Z
---

PLAN: Fix TUI markdown fg/bg color collisions (Phase 1 of 2) — status: COMPLETED 2026-08-26 on branch feat/display-fixes.

==== COMPLETION SUMMARY ====
All steps executed and all validation criteria met by the code persona.

WHAT SHIPPED
- syntax-highlight.ts: new SyntaxStyle/SyntaxTheme types, DEFAULT_SYNTAX_THEME (comment = italic-only attribute style — kills the universal gray-on-gray invisible-comment bug; strong/emphasis are real attributes now), normalizeLegacyColors(), SGR open/close helpers with hex→38;2;r;g;b, decimal→38;5;n, named→3X/90, unparseable color → NO fg emitted (inherit) instead of white fallback. renderHighlightedTree keeps its (tree, backgroundColor, colors) signature but accepts legacy Record<string,string> OR SyntaxTheme; padding carries no foreground SGR.
- Markdown.tsx: codespan renders backgroundColor only (no forced fg → bold-promotion collision impossible; honors tui.syntaxHighlighting.codeBackground); dead imports removed; blockquote collapses to token.text (join-on-ReactNodes landmine gone); component no longer defaults syntaxColors to legacy SYNTAX_COLORS — omission now falls through to DEFAULT_SYNTAX_THEME inside renderHighlightedTree.
- FileReadBlock.tsx untouched (per plan); inherits fixes via renderHighlightedTree dual-format input.
- Tests: new drone-agent/test/syntax-highlight.test.ts (22 tests over literal SGR emission, normalization, bg-only padding); Markdown.test.tsx grew from 9 to 16 with a 'foreground/background collision regressions' suite asserting raw escape codes in ink frames.

DEVIATIONS FROM PLAN TEXT (all justified, none silent)
1. Plan step D said "keep signature" for renderHighlightedTree — kept, but third param widened to accept SyntaxTheme (dual-format seam as designed).
2. Plan gap found BY the new tests: Markdown's `syntaxColors = SYNTAX_COLORS` default prop meant DEFAULT_SYNTAX_THEME never engaged on the default path (frames showed \e[100m\e[90m// comment). Fixed by dropping the legacy default in Markdown.tsx; SYNTAX_COLORS stays exported solely for FileReadBlock until Phase 2 migration.
3. tsc (pnpm -r run build) flagged renderToken/renderCodeBlock needing `Record<string,string> | undefined` after (2); fixed. Lesson reinforced: run the real build, LSP diagnostics lagged stale state twice this session.
4. Existing Markdown tests numbered 9, not the plan's stated 10 — criterion interpreted as "all pre-existing tests pass", satisfied.
5. FORCE_COLOR dynamic-import dance from the plan's test-infra note proved unnecessary: vitest setupFiles already runs drone-agent/test/setup-color.ts (sets process.env.FORCE_COLOR='1' before any import).

VALIDATION EVIDENCE
- LSP: zero TS errors/warnings workspace-wide (6 pre-existing css unknownAtRules warnings in untouched drone-coordinator-ui remain, documented, not ours).
- pnpm -r run build ✅ · pnpm lint ✅ (prettier reformatted nothing) · pnpm test fast suite ✅ 157 files / 2290 tests.
- Behavioral asserts a–f each mapped to named passing tests via --reporter=verbose.
- Manual smoke: real Ink renderer in tmux, capture-pane -e ground truth — codespan emits \e[100midentifierName\e[49m (no fg between), comments emit italic+\e[100m only, keyword/string/number tokens colored distinctly on bg, padding fg-free.

PHASE 2 BACKLOG (unchanged): raw ANSI across Ink soft line wraps; FileReadBlock native SyntaxTheme migration + retire SYNTAX_COLORS/ANSI_COLORS public surface; blockquote inline-markdown rendering upgrade; normalizeLegacyColors gains its first production caller in that migration.

(Original plan text below, preserved for reference.)

WHY: Some markdown constructs render text invisible because foreground color equals (or is promoted onto) background color. Empirically probed via ink-testing-library with FORCE_COLOR=2:
1. Inline codespans (Markdown.tsx ~L147) hardcode `<Text backgroundColor="gray" color="black">`. When nested in `<Text bold>` (**bold** prose), the parent leaves SGR 1 active; terminals with bold-promotion render fg black(30) as bright black(90) = the exact palette slot of bg gray(100). Emitted: `\e[1mbefore \e[100m\e[30midentifierName\e[39m\e[49m` → invisible on xterm.js/VS Code/kitty defaults. Repro: `` `identifierName` `` inside `**bold claim**`.
2. Fenced-code comments: SYNTAX_COLORS.comment='gray' → fg 90 on bg 100 (same slot) → invisible in EVERY terminal.
3. ANSI_COLORS map is lossy: only 8 base colors + gray; hex/256-color configs silently fall back to white ('37'), so users cannot tune their way out. Also SYNTAX_COLORS.strong='bold'/emphasis='italic' are attributes-not-colors → those hljs classes lose styling entirely.
4. Codespan ignores tui.syntaxHighlighting.codeBackground config (hardcoded 'gray').
5. Latent: renderBlockquote joins ReactNode[] into a string → '[object Object]' if reached (currently shadowed by token.text short-circuit).
6. Dead imports in Markdown.tsx: extractTokenText, getTokenColor (imported, unused).

SCOPE (agreed with user): Markdown.tsx + syntax-highlight.ts only. FileReadBlock.tsx untouched — inherits fixes because renderHighlightedTree stays signature-compatible. Blockquote = one-liner collapse to token.text ?? ''. No new required config keys; existing tui.syntaxHighlighting.colors/codeBackground keep working but hex/256 start working and strong:/emphasis: become real attributes. DEFERRED to Phase 2: raw-ANSI survival across Ink soft line wraps (user reports frequent); first-class FileReadBlock migration; SYNTAX_COLORS deprecation/removal.

DESIGN: A) SyntaxStyle {color?,bold?,italic?,underline?}; SyntaxTheme Record<string,SyntaxStyle>; DEFAULT_SYNTAX_THEME (comment italic-only, emphasis italic, strong bold, rest palette); normalizeLegacyColors maps 'bold'/'italic'/'underline' values to attributes else {color}. B) sgrOpen/sgrClose: attributes order bold(1)/italic(3)/underline(4) then fg; close reverse with 22/23/24+39; unparseable fg emits nothing. C) renderHighlightedTree signature unchanged, dual-format input normalized once, first-hljs-class precedence, bg-only padding, bg emitted first per line. D) codespan = <Text backgroundColor={codeBackground}> inheriting fg. E) blockquote collapses to token.text. F) remove dead imports. G) SYNTAX_COLORS export retained this phase for FileReadBlock fallback.

STEPS: 1) theme+helpers+unit tests 2) renderHighlightedTree internals 3) Markdown.tsx codespan/dead imports/blockquote 4) blunt review 5) validation sweep + manual smoke. TEST INFRA NOTE: FORCE_COLOR must precede chalk import (vitest hoisting) — superseded by setup-color.ts during execution.

VALIDATION CRITERIA: LSP zero; build/lint/test green; behavioral asserts (a)-(f); manual visibility; all pre-existing Markdown tests passing. ALL SATISFIED — see summary above.