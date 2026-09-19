---
key: plan-transcript-tools-eidetic-memory
tags:
  - plan
  - seed
  - transcript
  - memory
  - default-hidden
  - eidetic-memory
created: 2026-09-19T01:50:43.791Z
updated: 2026-09-19T01:50:43.791Z
---

# Plan seed: Transcript tools for human-guided memory ("eidetic memory")

SEED only — extracted 2026-09-18 out of `memory-wiki-browser-improvements` item G1 because it is agent-side tooling, unrelated to the coordinator-UI wiki-browser plan. Not yet planned; needs its own planning session.

## Idea

Register agent-side tools that give a persona direct access to session transcripts, marked `defaultHidden: true` so they stay out of the LLM's tool list unless a persona explicitly opts in (via `allowedTools`, or `premountedTools` for a deliberate distraction warning).

Two intended uses:

1. **Human-guided memory pipeline** — a stand-alone building block for users who want to curate what gets ingested (a human in the loop), instead of an automated session-end trigger.
2. **Eidetic memory for one persona** — *very* accurate (and deliberately distracting) recall of specific past sessions.

## Why `defaultHidden`

Transcript reads are token-heavy and highly distracting to a general-purpose persona. They must be off by default and surfaced only to personas that deliberately want them.

## What exists today (verified 2026-09-18)

- Coordinator: `GET /api/sessions/:id/transcript` (bounded 200KB / 400-char tool args, ADR 185), plus `/api/sessions` (`status`/`exclude`/`sortBy`/`sortDirection`/`limit`/`offset`), `/log`, `/chat`, `/events`, `/events/search`.
- Beacon: proxies session reads (`GET /sessions`, `GET /sessions/:id/transcript`) and coordinator tools via `/coordinator/*`.
- Agent swarm plugin: `session-import.ts` `fetchTranscript()` + `/swarm-session import` (summarizes + injects). **No transcript TOOL is registered.**
- `defaultHidden` semantics live in `drone-core/src/tool-registry.ts` + plugin-engine tool filtering + persona filtering. The `terminal` plugin already uses `defaultHidden: true` (7 tools) — a working precedent.
- Session transcripts are NOT wiki pages; they are coordinator SQLite (`swarm_sessions`/`swarm_events`).

## Open design questions (for its own session)

- Which tools? (e.g. `session__list`, `session__transcript`, maybe `session__search`).
- "Workflow"-ing transcripts: a workflow that walks the user through curating transcript content into the wiki (ties into the human-guided pipeline use).
- Scope: project / user / swarm? Extend the `swarm` plugin or start a new plugin?
- Gating: per-persona `allowedTools` opt-in (recommended) vs a config flag.
- Chunking / token budget for transcript reads (bounded transcript is already 200KB).
- Relationship to `/swarm-session import` and the memory-pipeline (avoid duplicate machinery).
