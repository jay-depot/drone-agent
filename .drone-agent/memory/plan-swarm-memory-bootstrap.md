---
key: plan-swarm-memory-bootstrap
tags:
  - plan
  - swarm
  - bootstrap
  - memory-pipeline
  - completed
created: 2026-08-31T21:50:16.501Z
updated: 2026-08-31T22:21:51.867Z
---

PLAN: bootstrap__swarm-memory — interactive workflow run ON THE COORDINATOR HOST that sets up the swarm memory WRITE pipeline. ===== COMPLETED 2026-08-31 on branch feat/swarm-memory-rag (commits 3879388, 0f19dfa, 215e429, 05aedcf + final docs/validation commit) =====

WHAT WAS DONE:
- PHASE A: seedDefaults() extracted to drone-coordinator/src/default-assets.ts (seedDefaultAssets(db, log) with injectable SeedDb/SeedLogger seam). Librarian persona rewritten to query-as-input model ("Treat the user's query as the material you have been given to ingest"); phantom tool refs (session_list/session_get_log/session_mark_processed) removed from persona prompt AND memory-wiki skill body; real canonical tool names used (swarm__wiki_read/write/search/list/lint, search__text, skills__recall, memory__browse, file__read/list/glob). warnIfLibrarianPersonaIsLegacy() logs a repair warning for pre-existing broken copies (id-gated, non-mutating). Tests: drone-coordinator/test/default-assets.test.ts (6 tests: no phantom strings, idempotent seeding, warning only for librarian-id personas, no piping mechanics language).
- PHASE B+C: bootstrap__swarm-memory workflow registered in bootstrap plugin (drone-agent/src/plugins/bootstrap/swarm-memory.ts + swarm-memory-scripts.ts after B3 750-line split). Step flow with elicit confirm before EVERY write: discover (URL/beacon opt-in/batch limit/cron schedule; probe via drone-swarm session list; systemd/docker launch detection) → hook script (session process → session transcript → kickoff NDJSON → drone-agent --output-json --once --persona coordinator-wiki-librarian → session processed) → catch-up script + crontab read-modify (default 0 * * * *) → sessionEnd command trigger merged into coordinator (+optional beacon) config via REAL mergeConfig+validateConfigFile from drone-swarm-common → ask-first restarts (degrades to instruct-only when launch mode unknown) → always-on static validation (bash -n × 2, validateConfigFile on written config, crontab-present check) → confirm-first smoke on REAL ended sessions (side effects stated) → toolResult+kickMessage summary. DI: ({runner, home}) options; atomic tmp+rename writes; scripts chmod 0755. Tests: drone-agent/test/plugins/bootstrap/swarm-memory.test.ts (6 tests: full happy path with pinned elicit ordering, differing-type sessionEnd wholesale replace, hook-declined early exit, smoke decline skip, bash -n failure surfacing, unknown-launch-mode degradation).
- EN ROUTE (plan gap): drone-swarm CLI gained `session transcript <id>` (client.getSessionTranscript → GET /api/sessions/:id/transcript) because session process returns raw events, not the readable --- Turn N --- transcript the librarian needs; fixture test in drone-swarm/test/cli.test.ts (8 tests).
- PHASE D: docs/agents/memory-pipeline.md opinionated-default note rewritten (workflow NOW exists, describes actual behavior); docs/agents/bootstrap-plugin.md swarm-memory moved to Workflows list; ADR 151 Context gained a postscript correcting the phantom claim.
- TYPECHECK DEBT EN ROUTE: fixed 13 pre-existing typecheck errors to meet the zero standard: slash-swarm-memory.test.ts called createSwarmMemoryCommand with a removed 2nd arg (5 sites); drone-core/test/index.test.ts missing optional chains on anchors/window (3 sites); my own test needed DroneWorkflowRunReturn narrowing (5 sites via `(result as {toolResult?: string}).toolResult`).

VALIDATION FINAL: LSP 0 errors workspace-wide; pnpm typecheck 0; pnpm lint 0; pnpm -r build 0 errors; pnpm test 2635 passed / 14 skipped (fast suite), all new suites green. NOT done (explicitly out of plan): live-coordinator manual smoke (optional operator step; needs a live coordinator + ended sessions). Phase-2 backlog unchanged (swarm-memory-phase-2-backlog).