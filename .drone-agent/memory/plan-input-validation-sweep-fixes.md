---
key: plan-input-validation-sweep-fixes
tags:
  - completed
created: 2026-08-25T18:42:41.513Z
updated: 2026-08-25T19:15:45.050Z
---

# Plan: Fix remaining input-validation gaps across plugins (follow-up to plan-self-improvement-trim-before-validate)

## Summary

The project-wide sweep (see memory: audit-input-validation-sweep) found 1 CRASH + 6 latent clusters of required-but-unenforced tool inputs. Because executeTool dispatches straight to tool.execute with no schema enforcement, these produce raw TypeErrors, misleading downstream errors (/wiki/undefined 404s, "Unknown action: undefined"), or false successes. Scope approved by user: crash + all misleading-error latents (items 1-7). DEFERRED by user decision: bootstrap elicitation-answer hardening (~10 sites) — contract-backed by both elicit hosts populating every requested id; revisit only if ask() semantics change.

Conventions per plugin family (fixes MUST match local style):
- memory: throws Error with friendly messages
- swarm tools (wiki/coordinator/message): return JSON.stringify({success:false, error})
- notepad: returns {success:false, error} JSON
- subagent return tool: throw (error surfaces to subagent LLM via executeToolSafely, teaching retry)

## Implementation steps

### Step 1 — shared helper `drone-agent/src/plugins/swarm/string-params.ts`: firstMissingString(params, fields) returns first field name whose value is not a non-empty string.
### Step 2 — tools-wiki.ts: guard-first in wiki_read/wiki_search/wiki_delete (pageId/query) + wiki_write (pageId,title,content).
### Step 3 — tools-coordinator.ts: guard-first in swarm_spawn/get_spawn/list_spawns/terminate_spawn.
### Step 4 — tools-message.ts send branch: plain typeof+length check on body (no trim).
### Step 5 — memory/index.ts manage: typeof-guard key + action-membership throw; browse: action-membership throw.
### Step 6 — notepad.ts: action-membership {success:false} before any state mutation.
### Step 7 — subagent/plugin.ts return tool: throw on missing/mistyped/blank result.
### Steps 8-11 — tests: extended memory-index.test.ts (+4), subagent-plugin.test.ts (+2); NEW swarm-tool-input-validation.test.ts (13 cases incl. fetch-not-called assertions + happy path) and notepad.test.ts (7 cases incl. state-untouched-after-failure).

## Validation criteria
1. New regression cases fail pre-fix / pass post-fix. 2. Targeted vitest green. 3. LSP zero errors/warnings. 4. build + lint pass. 5. Full fast suite passes. 6. Greps clean; bootstrap untouched. 7. Conventions preserved.

---

# COMPLETION SUMMARY (executed 2026-08-25)

All steps executed; ALL validation criteria met:

- Source: string-params.ts helper created; guards in tools-wiki (4), tools-coordinator (4), tools-message send branch, memory manage (key typeof-guard + action membership) and browse (action membership), notepad action-membership, subagent return result guard. Bootstrap untouched as deferred.
- Tests: +28 new cases across memory-index.test.ts, subagent-plugin.test.ts, NEW swarm-tool-input-validation.test.ts, NEW notepad.test.ts. V1 stash-dance proved 22 new-case failures against pre-fix source, all pass post-fix.
- V2 targeted: 51/51 green across the five touched specs.
- V3 LSP: zero errors/warnings on all touched files (also removed a pre-existing unused SwarmContext import in tools-coordinator.ts).
- V4: pnpm -r run build all packages Done; pnpm lint exit 0, prettier unchanged everything.
- V5: full fast suite 2227 passed / 9 skipped (up from 2199 baseline).
- V6/V7: greps confirm exact guard counts, no cast-trim remains in memory, bootstrap diff empty, conventions preserved (memory/subagent throw; swarm/notepad {success:false}).

Committed on fix/insight-logging-hints with .drone-agent artifacts per repo convention.

## Execution lessons (see also persona insights)
- The fuzzy patcher MISAPPLIED multi-hunk patches three times when several hunks in one file had near-identical shape: guards stacked into the FIRST matching execute (wiki_read got all four wiki guards; swarm_list_agents got all four coordinator guards; browse guard landed inside manage's execute) even with unique trailing context supplied. Symptom signature: "Tests N passed" but "Test Files X failed" (transform/syntax errors outside test scope => 'const missing has already been declared'). Reliable recovery: restore file pristine via git checkout HEAD -- <file>, then REWRITE the whole file with file__write instead of iterating patches. For files with repeated structurally-identical regions, go straight to full-file write for multi-site edits.
- vitest must run from workspace ROOT (drone-agent/ subdir finds no test files).