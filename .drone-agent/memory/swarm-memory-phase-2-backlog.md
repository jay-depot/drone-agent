---
key: swarm-memory-phase-2-backlog
tags:
  - phase-2
  - swarm
  - memory-pipeline
  - backlog
created: 2026-08-31T21:50:16.501Z
updated: 2026-08-31T21:50:16.501Z
---

FOLLOW-UP PHASE 2 candidates (recorded 2026-08-31, after plan-swarm-memory-bootstrap-bootstrap lands — do not start until phase 1 is implemented): (1) CLIENT-SIDE bootstrap: extend swarm-memory bootstrap story with agent opt-in to the READ side — write swarm.memory config (DroneSwarmMemoryConfig: enabled/topK/minScore/anchors/window, drone-core/src/config-types.ts:744-770) into project/user agent config, possibly a phase of the same workflow or a separate bootstrap step; docs should not imply phase 1 handles the read side. (2) WEB UI stale-session review: coordinator-ui affordance to list stale sessions and let the user CONFIRM/close them (POST /sessions/:id/end force-end exists server-side); once confirmed-ended, leak-free catch-up ingestion can pick them up — the phase-1 catch-up script deliberately ingests 'ended' only and crashed agents' stale sessions leak. (3) Librarian persona migration for existing deployments (phase 1 only logs a warning; consider a UI or CLI prompt-to-update).
