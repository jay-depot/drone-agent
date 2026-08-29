---
key: config-library-migration-audit
tags:
  - config-library
  - migration
  - audit
created: 2026-08-29T17:26:25.284Z
updated: 2026-08-29T17:37:31.674Z
---

Audit of skill-library → config-library migration (branch config-library-overhaul). PROGRESS: (Done) docs references fixed and committed as 0a59a15 — AGENTS.md:31 table row now config-library/ (alignment preserved: cell2=25 cell3=84), README.md Skill Library section rewritten as Config Library pointing to config-library/README.md; case-insensitive repo sweep confirms zero remaining "skill-library" refs. (Done by user) config-library/README.md heading now "# CONFIG LIBRARY"; missing `file` plugin added to README assumed-plugin list; previously untracked library content committed (commit 12cd9c75); missing macros now exported: project-wiki-ingest.macro present in config-library/macros/ (reflect-now.macro still absent); NEW untracked: config-library/personas/reflect/ (correctly omits live reflect/insights/ dir). REMAINING: (a) personas-backup/ in ~/.drone-agent still holds plan+code insights.json snapshots — decide keep (date it/readme it) or delete, and ~/.drone-agent/personas/ now only has reflect/ (six exported personas no longer live locally); (b) remark: frontmatter in library grilling/grill-with-docs/domain-modelling is silently ignored by parseSkillMd (drone-agent/src/plugins/skills/loader.ts only reads name/description/recall/model-invocation) — put credit in body or extend parser; (c) advanced-editing.md library copy vs live copy whitespace drift — decide source of truth. Insight storage layout: persona insights under ~/.drone-agent/personas/<id>/insights/, skill insights under ~/.drone-agent/insights/skill/<id>.json, project insights under project .drone-agent/insights/project/.