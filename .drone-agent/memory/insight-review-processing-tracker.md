---
key: insight-review-processing-tracker
tags:
  - insight-review
  - self-improvement
created: 2026-08-11T00:12:15.612Z
updated: 2026-08-11T00:14:32.628Z
---

Track which self-improvement insights have been reviewed/discussed in theme-review sessions, since no automated tracking feature exists yet. Session of 2026-08-10: reviewed all project/persona/skill insights for recurring themes. Outcomes by theme:

1. apply_diff reliability -> PROMOTED to principle "fix the tool rather than route around it" (stale literal complaints dropped; reliability fell off after 07-19/20 rewrite).
2. Mock/call-site sweeping -> PROMOTED to principle (LSP find-references + grep sweep).
3. Racy TUI test barriers -> PROMOTED to principle (waitUntilFrame content-aware polling).
4. Parallel tool-execution races on shared state -> PROMOTED to principle (per-key mutex + tmp/rename atomic writes).
5. list/mount pattern -> NOT promoted (done-deal decisions; also the 07-13 "defaultHidden redundant" insight was a lie/regression later fixed - treat with skepticism).
6. Build/package resolution footguns -> PROMOTED (pnpm -r run build after drone-core type edits). FOLLOW-UP DONE: the .jsx-vs-.js sibling import gotcha was written to docs/agents/import-conventions.md (new topic awaiting expansion).
7. plan persona boundary -> NOT promoted (already fixed by updating the plan persona definition itself).
   All 7 themes from the initial list are now dispositioned. NOTE: several insights are stale post-rewrite or describe one-off gotchas; when the tracking feature is implemented, replace this memory with structured per-insight state.
