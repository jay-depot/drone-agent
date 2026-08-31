---
key: plan-swarm-memory-bootstrap
tags:
  - plan
  - swarm
  - bootstrap
  - memory-pipeline
created: 2026-08-31T21:50:16.501Z
updated: 2026-08-31T21:50:16.501Z
---

PLAN: bootstrap__swarm-memory — interactive workflow run ON THE COORDINATOR HOST that sets up the swarm memory WRITE pipeline. Full plan text (requirements + phases A–D + validation):

REQUIREMENTS (user decisions): (1) Coordinator-host scope only; client-side swarm.memory opt-in = phase 2. (2) Writes server config files DIRECTLY but step-by-step — elicit check-in before EVERY change (show change → confirm → apply), no batch writes. (3) Restarts OFFERED ask-first every time; detect systemd/docker/bare; degrade to instruct-only if exec unavailable. Rationale: models improvise restarts anyway — sanction with guided path + confirm gate. (4) Librarian persona fix: remove session_list/session_get_log/session_mark_processed refs (don't exist); remove self-directed session-finding; re-model prompt so piped-in transcript = the user's query (no explicit piping mention). (5) TWO ingestion paths: cron catch-up script (ended sessions, newest-first, batch limit → headless librarian sessions) + hook script on sessionEnd trigger. Stale sessions LEAK (ended-only) — force-ending stale = phase 2 with web UI. (6) Validation: static checks ALWAYS (bash -n, validateConfigFile on merged config, crontab confirm) + smoke on REAL conversations (not synthetic) with confirm BEFORE each run (side effects stated: session → processed permanent; real wiki pages written).

PHASE A — persona fix (drone-coordinator/src/index.ts seedDefaults ~L652-717): A1 rewrite prompt (query-as-input model; allowlist corrected to REAL wiki tool names — verify swarm__* vs wiki_* naming against drone-agent/src/plugins/swarm/tools-*.ts); A2 warn-if-existing-persona-contains-phantom (seed-if-missing contract preserved); A3 coordinator test (no phantom strings; warning fires).
PHASE B — workflow (drone-agent/src/plugins/bootstrap/swarm-memory.ts, registered in index.ts as name:'swarm-memory'; DI'd run(cmd[]) helper using node:child_process execFile): B2 step flow: discover (configs, drone-swarm reachability, launch mode; elicit URL/layers) → hook script ~/.drone-swarm-memory/bin/session-end-ingest.sh (session process → pipe to drone-agent --output-json --once --persona coordinator-wiki-librarian [verify flag vs subagent spawn code] → session processed) → catch-up script + cron install (read-modify crontab, default 0 * * * *) → merge sessionEnd trigger into server configs via mergeConfig + validateConfigFile from drone-swarm-common (add pkg dep if needed; NEVER copy loader logic; differing-type trigger replaces wholesale) → restart offers → static validation → real-data smoke offers → toolResult+kickMessage summary. B3 reviewer sweep: find-references, dedupe atomic-write helpers.
PHASE C — tests (test/plugins/bootstrap/swarm-memory.test.ts): mock elicit + runner + temp HOME; assert elicit-before-every-write, real validateConfigFile pass, {session_id} substitution, static-check surfacing, smoke-decline skip, no-exec degradation.
PHASE D — docs: memory-pipeline.md:9-13 rewrite (workflow NOW exists; primitives stay roll-your-own path); bootstrap-plugin.md move swarm-memory to Workflows (swarm/standalone stay future); ADR 151 postscript re phantom.
ORDER: A1→A2→A3, B1→B2→B3, C1 parallel with B3, D last. VALIDATION: LSP zero; pnpm -r lint/build zero errors; fast suite green incl. new tests; docs accuracy; optional manual smoke on live coordinator.
KEY CODE FACTS: SessionEndTrigger={type:'command',command}|{type:'spawn',persona,beaconId?}; ServerConfigFile allowed keys port/host/webPort/webHost/dbPath/useHttps/autoApproveBeacons/sessionEnd; mergeConfig shallow-except-sessionEnd-deep-within-same-type; workflows surface as tools (toolResult JSON to caller, kickMessage re-enters chat); config-file-only sessionEnd (not CLI flags).