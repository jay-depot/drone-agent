---
tags: [decision, memory-pipeline, bootstrap, workflow, session-end, cli]
related: [decisions/151-memory-pipeline-infra.md, decisions/179-swarm-memory-rag-retrieval.md, concepts/memory-pipeline.md, modules/drone-swarm.md, modules/drone-coordinator.md]
---

# 180 — Swarm memory bootstrap workflow

**Date**: 2026-08-31 · **Status**: Accepted · **Branch**: `feat/swarm-memory-rag` (`3879388..c22a8d0`)

## Context

ADR 151's Context referred to `bootstrap__swarm-memory` as the "opinionated default" and `docs/agents/memory-pipeline.md` recommended it as the complete pipeline — but a workspace sweep found **no such workflow in the code** (total registered workflows: `bootstrap__project`, `bootstrap__user`, `skills__create`, `persona__create`, macros `reload`). Git history confirmed it was never committed. The docs described a phantom. The other half of the claimed default, the seeded `coordinator-wiki-librarian` persona, *was* real but **broken**: its prompt instructed it to call `session_list`/`session_get_log`/`session_mark_processed` — tools that exist nowhere — and to hunt for sessions itself, while its allowlist used patterns matching no canonical tool name (`wiki_*` vs the real `swarm__wiki_*`; `!file.write` vs `file__write`; `!exec.*` vs id `exec`), and the seeded `memory-wiki` skill taught the same phantom workflow. Any `sessionEnd` spawn trigger would fire a librarian whose steps 2/3/6 were unexecutable.

Separately, `drone-swarm session process` returns raw event JSON, but the ingester needs the readable `--- Turn N ---` transcript (`GET /api/sessions/:id/transcript`, built for ADR 146 session import) — a plan-gap the user confirmed mid-flight.

## Decision

Four pieces, shaped by explicit user direction (see log for the interview): a setup **workflow** runs *on the coordinator host* and writes server-side config/scripts with a check-in before every mutation; restarts are **sanctioned with a confirm gate** instead of banned (the user's reasoning: models improvise restarts anyway — teach the guided path and gate it); the librarian is re-modeled as ingest-what-you're-given; and validation follows check-always-static + confirm-first-live.

**1. The `bootstrap__swarm-memory` workflow** (`drone-agent/src/plugins/bootstrap/swarm-memory.ts` + `swarm-memory-scripts.ts` after a 750-line-limit split; registered in `bootstrap/index.ts`). Step flow, each mutating step = one `ctx.elicit` confirm with full preview:
- **Discover**: coordinator URL (probe via `drone-swarm session list --limit 1`), beacon opt-in, catch-up batch limit, cron schedule (defaults: `http://localhost:3456`, coordinator-only, 5, `0 * * * *`).
- **Scripts** (`~/.drone-swarm-memory/bin/`): `session-end-ingest.sh` (claim via `session process` → `session transcript` → kickoff NDJSON → `drone-agent --output-json --once --persona coordinator-wiki-librarian` → `session processed --summary`) and `catch-up-ingest.sh` (list `ended` newest-first, batch limit, per-session failure isolation, feeds the hook). Atomic tmp+rename writes, `chmod 0755`.
- **Config merge**: `sessionEnd: {type:'command', command:'<hook> {session_id}'}` merged into `~/.drone-coordinator/config.json` (+ optional beacon) via the **real** `drone-swarm-common` `mergeConfig`+`validateConfigFile` (the same code the server runs; differing-type triggers replace wholesale; never copy loader logic).
- **Restarts**: launch-mode detection (systemd/docker/unknown); offers the exact command, ask-first; verify-by-reprobe; instruct-only fallback when mode unknown.
- **Static validation always**: `bash -n` both scripts, `validateConfigFile` on the written config, crontab-present check; failures inline with artifact names.
- **Smoke on real conversations, confirm-first**: pick a real ended session, push it through the hook by hand, verify via `wiki search`; side effects stated plainly (session permanently `processed`; real wiki pages written). `toolResult` + `kickMessage` summary with per-step status.
- DI seam `({ runner, home })` for tests; runner via `node:child_process`.

**2. drone-swarm gains `session transcript <id>`** — client `getSessionTranscript()` (`GET /api/sessions/:id/transcript`) + CLI verb, printing the readable turn transcript the hook pipes into the librarian kickoff. Fixture-tested in `drone-swarm/test/cli.test.ts` (8 tests).

**3. Librarian persona + memory-wiki skill repaired** — `seedDefaults()` extracted to `drone-coordinator/src/default-assets.ts` as `seedDefaultAssets(db, log)` with injectable `SeedDb`/`SeedLogger`. New prompt models **query-as-input** ("Treat the user's query as the material you have been given to ingest… Do not go searching for conversations, sessions, or logs on your own"), no piping mechanics mentioned. Allowlist = real canonical names: `swarm__wiki_read/write/search/list/lint`, `search__text`, `skills__recall`, `memory__browse`, `file__read/list/glob`; allowlist-only design (the old exclusion patterns like `!file.write`/`!exec.*` were dead patterns against canonical names). `memory-wiki` skill body updated to match (canonical tool names; "work on the material in your input"). **Legacy warning**: `warnIfLibrarianPersonaIsLegacy()` (id-gated, non-mutating) logs a repair warning at startup when an existing librarian copy references phantom tools — pre-existing deployments keep their copy (seed-if-missing preserved); prompt-to-update migration is phase 2.

**4. Docs honesty** — `docs/agents/memory-pipeline.md` opinionated-default note rewritten to describe the real workflow; `bootstrap-plugin.md` moves swarm-memory into Workflows; this ADR + a postscript on ADR 151 record the phantom.

## Consequences

- The "opinionated default" in the memory-pipeline story is finally real: run an agent on the coordinator host with `--plugin bootstrap` (plus `exec`), invoke `bootstrap__swarm-memory`, and get hook + catch-up + config + librarian validated end-to-end.
- Write-side setup is now **confirm-gated throughout**; generated scripts are pure templates (DI + pure builders) fully covered by tests, and both ingestion paths go through the same `session transcript` + headless-agent mechanism.
- Stale sessions (crashed agents) still **leak** — scripts ingest `ended` only; force-ending via the web UI + client-side `swarm.memory` opt-in are phase 2 (see project memory `swarm-memory-phase-2-backlog`).
- The librarian can't self-serve: without the spawn trigger or catch-up cron it only works when fed. This is the intended shape (external orchestration owns discovery).
- En-route: fixed 13 typecheck errors to keep the zero standard (8 pre-existing on the branch: 5 stale-arity calls in `slash-swarm-memory.test.ts`, 3 missing optional chains in `drone-core/test/index.test.ts`; plus 5 in the new test narrowing `DroneWorkflowRunReturn`).

## Related

- [[decisions/151-memory-pipeline-infra]] · [[decisions/179-swarm-memory-rag-retrieval]] (read side)
- [[concepts/memory-pipeline]] · [[concepts/session-processing-pipeline]]
- [[decisions/146-swarm-session-import]] — transcript builder shared with the ingest hook