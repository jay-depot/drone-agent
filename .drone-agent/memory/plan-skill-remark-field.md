---
key: plan-skill-remark-field
tags:
  - skills
  - remark
  - feature-plan
  - completed
created: 2026-08-29T18:00:51.284Z
updated: 2026-08-29T18:16:13.906Z
---

IMPLEMENTATION PLAN — skill `remark` frontmatter field (v1, local-scope) — branch config-library-overhaul. STATUS: COMPLETED 2026-08-29.

FEATURE: Make `remark` an officially supported, optional skill frontmatter field: author-facing comment (attribution/license note), shown to the user on listings, NEVER exposed to the LLM. Previously silently dropped by parseSkillMd.

DECISIONS: Q1 v1 local-scope only (swarm propagation = B phase, non-goal). Q2 option X: skills__list optional includeRemark input (default false, not advertised in tool description); /skills list + /skills reload pass includeRemark:true; SkillsListBlock renders remark line only when present in JSON; skills__recall payload remark-free; /skills recall confirmation line appends remark. Q3 wizard untouched (B phase: default remark "Created at [datetime] by create-skill workflow"). Q4 skills-only; personas = B-phase work.

COMPLETED WORK (all validation criteria met 2026-08-29):
- drone-core/src/skill-types.ts: remark?: string added to DroneSkillDefinition (optional-additive; find_references sweep over 43 refs confirmed no breaks; pnpm -r run build re-run before trusting LSP dist/).
- drone-agent/src/plugins/skills/loader.ts: parseSkillMd 'remark' branch (same quote-strip, empty -> undefined) + docstring format example + author-facing/never-LLM note.
- drone-agent/src/plugins/skills/index.ts: skills__list includeRemark schema prop + conditional payload spread; /skills list and /skills reload pass includeRemark:true; /skills recall confirmation uses getSkillById and appends " — <remark>"; fragment untouched (remark-free verified by test).
- drone-agent/src/tui/components/SkillsListBlock.tsx: indented italic "↳ <remark>" line (scheme.toolResult color, no dedicated muted field exists) rendered only when remark present in payload.
- Tests: NEW test/skills-loader.test.ts (6 tests: parse, single/double quote strip, absent→undefined, empty→undefined, recall interleave intact, unknown keys ignored); test/skills-plugin.test.ts extended (+5: default list payload remark-free, includeRemark:true includes, recall payload remark-free, skills prompt fragment via engine.buildSystemMessages() remark-free, /skills recall confirmation contains " — <remark>" via engine.dispatchSlashCommand with mock logger); NEW test/skills-list-block.test.tsx (2 ink tests: ↳ line iff remark present).
- Validation: LSP clean on all touched files; pnpm -r run build 0 errors; pnpm lint 0 errors (caught 1 unused helper var); pnpm test 2398 passed / 0 failed (164 files); diff review confirmed zero changes to non-goals (wizard.ts, persona/, swarm/, drone-beacon/, drone-coordinator*, domain-types.ts).

IMPLEMENTATION NOTES for executors: commit = "feat(skills): remark frontmatter field..." on config-library-overhaul. Known gotchas encountered: (1) apply_diff anchored a docstring insert on the wrong close-delimiter — always re-read files with multi-hunk patches targeting similar-looking blocks (two inputSchema property blocks both contained `id: { type: 'string' ...`); (2) vitest must run from repo root (include patterns are root-relative); (3) prettier --fix rewrites .drone-agent/memory/*.md prose (double-underscore identifiers become bold-style mangling) — the memory store is canonical, regenerate projections after lint; (4) file__write can corrupt content mid-generation — always read back new files before running them.