---
key: plan-merge-footer-fragments-single-message
tags:
  - plan
  - llm
  - footer-fragments
  - glm
  - prompt-cache
  - bug-fix
created: 2026-09-10T17:02:54.459Z
updated: 2026-09-10T17:44:23.271Z
---

PLAN: Merge trailing footer fragments into one system message (fix for GLM-5.3-flash intermittent "narration, no tool call" round-ends + elevated reasoning-only events, onset after PR #99 ce7aab2 phase-aware footer rendering).

Hypothesis: trailing RUNS of consecutive role:'system' messages after conversation turns are an untrained shape for this chat template; single trailing system message is proven safe (nudges did this pre-#99 without issue). Merging tests and fixes simultaneously; preserves #99's cache win and topic boundaries via fragments' mandated top-level # Headings.

Steps: (1) context-budget-service.ts buildFooterMessages (L173) — join rendered footer fragments with '\n\n' into ONE {role:'system'} message instead of one-per-fragment. (2) plugin-engine.ts buildFooterMessages fallback (~L1018) — same join for host-absent path. (3) Tests: plugin-engine.test.ts (add multi-fragment case asserting exactly 1 footer message, heading-delimited), context-budget-service.test.ts ('builds headers and footers' now expects array-of-one), conversation-service.test.ts phase-ordering test unchanged (footer still between last turn and reminder), helpers.ts mocks unchanged. (4) Validate: pnpm typecheck/lint/build + fast suite; then live A/B on GLM-5.3-flash vs today's baseline (narration-without-tool-call incidence, reasoning-only guardrail notices, reasoning_tokens spread in OpenRouter activity). (5) If confirmed: log ADR amending #99 per meta/decision-bug-fixes-go-in-decisions; if not: move merged footer to header to isolate trailing-content vs run-length.

Validation criteria: LSP clean; lint/build/fast-suite green; phase-ordering test shows exactly one trailing system message between last turn and queued reminder.

STATUS: EXECUTED 2026-09-10. All steps 1-4 complete and validated (LSP clean, pnpm typecheck/lint/build green, full fast suite 205 files/2876 tests 0 failures). Committed as 3df2c76 on branch fix/merge-footer-fragments-single-message (rebased onto main; the branch had been accidentally created off fix/swarm-wiki-delete carrying PR #101 commits — reset to main, committed memory files edf6ffc, then the fix). PR #102 opened (https://github.com/jay-depot/drone-agent/pull/102). Step 5 (live A/B on GLM-5.3-flash) is the remaining follow-up — compare narration-without-tool-call incidence + reasoning-only guardrail notices + reasoning_tokens spread in OpenRouter activity vs today's baseline; if confirmed, log ADR amending #99 per meta/decision-bug-fixes-go-in-decisions.