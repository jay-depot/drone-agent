---
key: config-library-migration-audit
tags:
  - config-library
  - migration
  - audit
created: 2026-08-29T17:26:25.284Z
updated: 2026-08-29T17:26:25.284Z
---

Audit of skill-library → config-library migration (branch config-library-overhaul, commits 3938576c + ee000177). GOOD: all 6 persona exports in config-library/personas/ are byte-identical to their personas-backup sources and correctly omit per-persona insights/ dirs; skill bodies for domain-modelling/obsidian-vault/project-wiki/port-agent-to-persona/port-skill/tmux are byte-identical to live ~/.drone-agent/skills copies; insight data was preserved (not destroyed) in ~/.drone-agent/personas-backup. FINDINGS: (1) AGENTS.md:31 and README.md:42 still document the old skill-library/ folder name — rename commit did not sweep doc references; (2) config-library/README.md heading still says "SKILL LIBRARY"; (3) README assumed-plugin list omits the file plugin (defaultEnabled:false) although skills/macros depend on file tools; (4) two live macros not exported: ~/.drone-agent/macros/project-wiki-ingest.macro and reflect-now.macro; (5) library skills grilling/grill-with-docs/domain-modelling add a remark: frontmatter field that the skill parser (drone-agent/src/plugins/skills/loader.ts parseSkillMd) silently ignores — dead metadata + drift between the two copies; (6) all new library content (macros/, personas/, 7 skills) is untracked on the feature branch. Insight storage layout confirmed: persona insights live under ~/.drone-agent/personas/<id>/insights/ (or personas-backup/<id>/insights/), skill insights under ~/.drone-agent/insights/skill/<id>.json, project insights under project .drone-agent/insights/project/.