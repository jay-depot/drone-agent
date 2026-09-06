---
key: memory-wiki-browser-improvements
tags:
  - brainstorm
  - backlog
created: 2026-09-04T19:20:44.200Z
updated: 2026-09-06T21:26:34.508Z
---

# Memory Wiki Browser Improvements — Organized List (from brainstorm session)

Ready-to-plan list of improvements. Brought into future planning sessions.

## STATUS: B, C, E1, F1, H1, A5 COMPLETED + INGESTED (ADRs 191–195, 2026-09-06; the completed plan memories were deleted after ingest — see the wiki). A1-A4, D1, G1 open.

## A. Wiki Browser

### A1. Table layout (replaces cards)

- Columns: Title, Tags (collapsable or on-hover to save space), Create Date, Last Updated, Word Count, Source Sessions
- Create date alongside last updated confirmed. Tags space concern resolved via collapsable/on-hover.

### A2. Full filter set (beyond keyword)

- Tag (multi-select), date range (created / last updated), source session, page state (has links / has sources / recently created)
- User-facing semantic search deferred to a SEPARATE future phase (not now).

### A3. Click-to-sort column headings

- All columns sortable asc/desc EXCEPT Tags (likely the only non-sortable one).

### A4. "Sources" → session logs

- Target existing "session transcript" pages (currently raw JSON, minimal formatting); link sources to them and make those pages pretty as part of this work.

### A5. Connected node graph view ✅ COMPLETED + INGESTED

- Implemented + 27 polish rounds + live updates. See [[decisions/194-wiki-graph-view]] and [[decisions/195-wiki-graph-visual-polish]] in the project wiki (`/home/unleet/Obsidian/drone-agent-project/decisions/`). Graph library: `force-graph` v1.51.4 directly (NOT `react-force-graph` — blocked by pnpm 11.8 `blockExoticSubdeps` via git-resolved transitive deps).

## B. Edit Pages ✅ COMPLETED

### B1. Back buttons

- All edit pages use `navigate(-1)` history-back (wiki/persona/skill editors); tests cover history-back via MemoryRouter multi-entry initialEntries.

## C. Session Listing ✅ COMPLETED

### C1. No confirmation dialogs on workflow actions + archive phantom row with 5s undo (see [[decisions/190-coordinator-session-archive]]).

## D. Coordinator UI General

### D1. Version number sourced from somewhere real (OPEN)

- Goal: monorepo-wide LOCKSTEP version once published → any consistent source works (server-reported package version, UI package.json, or build-time constant).

## E. Swarm Topology

### E1. Status indicators = live websocket state ✅ COMPLETED + INGESTED ([[decisions/191-topology-live-ws-status]])

## F. Session Transcript

### F1. Emit session-parameter events to coordinator ✅ COMPLETED + INGESTED ([[decisions/192-session-param-events]])

## G. Transcript tools

### G1. `defaultHidden: true` tools for transcripts (OPEN)

- Check for / implement `defaultHidden: true` tools for: accessing transcripts, and "workflow"-ing transcripts.

## H. Swarm memory wiki schema

### H1. "One-sentence pitch" as official schema field ✅ COMPLETED + INGESTED ([[decisions/193-wiki-pitch-field]])
