---
key: plan-codeql-reflected-xss-suppression
tags:
  - codeql
  - security
  - suppression
  - xss
  - complete
created: 2026-08-14T18:42:52.383Z
updated: 2026-08-14T19:10:44.755Z
---

# Plan: CodeQL — Reflected XSS suppression (4 alerts)

## Summary
CodeQL flags "Reflected cross site scripting" at 4 `return skill;` / `return persona;` statements in Fastify PUT handlers where request-body data flows back out in the JSON response. Data is trusted (single-user swarm); the consuming React web UI auto-escapes (zero dangerouslySetInnerHTML/innerHTML usages), so there is no real XSS sink. We suppress the alerts.

## Research finding (documentation-grounded)
- `// lgtm[rule-id]` is LGTM.com syntax, NOT recognized by GitHub CodeQL/code scanning (LGTM.com shut down Dec 2022). This is why the earlier `lgtm` comments did nothing.
- The correct, currently-supported inline suppression is `// codeql[rule-id]`, placed on the sink line or the line immediately before it.
- Rule ID is `js/reflected-xss` (no `ts/` variant — TypeScript is analyzed by the JS query suite). The `js/` prefix was correct; the `lgtm` keyword was the problem.
- Suppression targets the sink location (the `return` line), not the source/intermediate lines.
- One comment per alert location; each of the 4 needs its own comment.
- Suppression takes effect on the next scan after commit.
- `// nosemgrep` is Semgrep-only, irrelevant. `paths-ignore` config is too coarse (would blind whole files). Alert dismissal via UI/API is not durable/source-controlled.

## Steps
1. Add `// codeql[js/reflected-xss]` on the line immediately before each sink (or as a trailing comment on the sink line):
   - `drone-coordinator/src/routes/skills.ts:30` → `return skill;`
   - `drone-coordinator/src/routes/personas.ts:36` → `return persona;`
   - `drone-beacon/src/routes/skills.ts:56` → `return skill;`
   - `drone-beacon/src/routes/personas.ts:71` → `return persona;`
   Recommended form (preceding line, keeps the sink line clean):
   ```ts
   // codeql[js/reflected-xss]
   return skill;
   ```
2. No behavior change, no tests needed (comment-only change).
3. Validation: LSP zero errors; `pnpm lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes. (Comment-only, but run the standard gates.)
4. After commit, re-run code scanning; the 4 alerts will be marked suppressed. Optionally dismiss the 4 existing alerts in the GitHub UI to close them immediately.

## Files touched
- drone-coordinator/src/routes/skills.ts
- drone-coordinator/src/routes/personas.ts
- drone-beacon/src/routes/skills.ts
- drone-beacon/src/routes/personas.ts

## Notes
- No drone-core changes → no cross-package rebuild needed before typecheck, but run `pnpm -r run build` as part of validation anyway.
- Do NOT use `// lgtm[...]` (unsupported), `// nosemgrep` (wrong tool), or `paths-ignore` (too coarse).

## Completed (2026-08-14)
All 4 suppressions added and committed in commit b740c63. Validation passed:
- LSP: zero errors (only pre-existing warnings for CSS @rules and unused variables)
- `pnpm lint`: zero errors
- `pnpm -r run build`: zero errors  
- `pnpm test` (fast test suite): all tests passed