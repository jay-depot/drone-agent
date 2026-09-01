---
key: swarm-memory-bootstrap-gap
tags:
  - swarm
  - bootstrap
  - memory-pipeline
  - resolved
created: 2026-08-31T21:14:33.642Z
updated: 2026-09-01T20:28:05.985Z
---

RESOLVED (2026-09-01): The 2026-08-31 finding that `bootstrap__swarm-memory` was a docs phantom is now historical — the workflow was implemented and shipped (ADR 180, branch feat/swarm-memory-rag, commits 3879388..c22a8d0). Reality today: workflow registered at drone-agent/src/plugins/bootstrap/index.ts:595 (createSwarmMemoryWorkflow in src/plugins/bootstrap/swarm-memory.ts, script builders in swarm-memory-scripts.ts). It writes ~/.drone-swarm-memory/bin/{session-end-ingest.sh,catch-up-ingest.sh}, merges `sessionEnd: {type:'command', command:'<hook> {session_id}'}` into ~/.drone-coordinator/config.json (+ optional beacon) via drone-swarm-common mergeConfig+validateConfigFile, installs a cron catch-up entry (default `0 * * * *`), offers gated systemd/docker restarts, runs static validation (bash -n, config validate, crontab-present), and a confirm-first smoke test on a real ended session. The librarian persona was re-modeled as query-as-input (drone-coordinator/src/default-assets.ts, seedDefaults extracted + warnIfLibrarianPersonaIsLegacy for pre-repair copies; seed-if-missing means old copies are NOT auto-updated). drone-swarm gained `session transcript` for the hook. Remaining phase-2 items (see project memory swarm-memory-phase-2-backlog): stale/processing sessions still leak (scripts ingest `ended` only), swarm.memory read-side config not part of bootstrap, prompt-to-update migration for legacy librarian copies. One quirk noticed while re-reading: detectLaunchMode probes `systemctl status drone-coordinator` but restartServer runs `systemctl restart coordinator` / `docker restart coordinator` (server arg is 'coordinator', not 'drone-coordinator') — unit/container naming mismatch possible; restart failures are reported gracefully in pendingRestart.