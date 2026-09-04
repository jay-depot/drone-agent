---
key: memory-wiki-browser-improvements
tags:
  []
created: 2026-09-04T19:20:44.200Z
updated: 2026-09-04T23:24:07.305Z
---

# Memory Wiki Browser Improvements — Organized List (from brainstorm session)

Ready-to-plan list of improvements. Brought into future planning sessions.

## STATUS: B, C, E1, F1, H1, A5 COMPLETED. A1-A4, D1, G1 open. See plans: `plan-swarm-topology-live-ws-status` (E1), `plan-swarm-session-param-events` (F1), `plan-swarm-memory-wiki-pitch-field` (H1), `plan-swarm-wiki-graph-view` (A5).

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

### A5. Connected node graph view  ✅ COMPLETED → `plan-swarm-wiki-graph-view`
- Interactive force-directed graph of wiki pages (nodes) and [[wikilinks]] (edges), toggled on the `/wiki` page (`?view=graph`), backed by coordinator-only `GET /api/wiki/graph`.
- IMPLEMENTED: `buildGraph()` in `drone-swarm-common/src/wiki-storage.ts` (all pages as nodes incl. orphans, forward edges deduped, broken-link targets as `exists:false` placeholder nodes). Coordinator route added. UI: `?view=graph` toggle (sessions-style), `?node=<pageId>` focus state URL-persisted, click node → focus/expand neighborhood, inline preview panel (title/id/pitch/tags + "Open full page"), "Show all" resets, background-click clears focus, double-click opens. Graph library: `force-graph` v1.51.4 (NOT `react-force-graph` — that package is blocked by pnpm 11.8 `blockExoticSubdeps` via its `3d-force-graph-vr`→`aframe`→git-resolved `three-bmfont-text` transitive dep; user approved the underlying engine directly). Thin wrapper component (`wiki-graph.tsx`) with injectable `forceGraphFactory` for testability; `useWikiGraph(enabled)` hook gates the fetch to graph view; `buildFocusedSubgraph` pure util.

## B. Edit Pages  ✅ COMPLETED

### B1. Back buttons
- All edit pages (wiki create/edit, skills, personas, etc.).
- Bug: item "back" does history -1 now, but edit-page back buttons navigate forward to the item view → infinite link loop.
- FIX: wiki-editor, persona-editor, skill-editor — changed main "← Back" AND bottom "Cancel" buttons to `navigate(-1)` (history-back), matching the loading-state back button and the detail-page back pattern. Tests: persona-editor.test.tsx / skill-editor.test.tsx (new) + wiki-editor.test.tsx (added) cover history-back via MemoryRouter multi-entry initialEntries.

## C. Session Listing  ✅ COMPLETED

### C1. Remove confirmation dialogs on workflow actions
- None are destructive (End / Archive / Restore).
- ARCHIVE-only "phantom row with undo": sessions.tsx no longer uses a `<Dialog>` for workflow actions. Direct handlers: handleTerminate, handleProcess, handleMarkProcessed, handleEnd, handleRestore, handleArchive, handleUndoArchive. handleArchive calls POST /archive, removes the row, sets a phantomArchive with a 5s (ARCHIVE_UNDO_MS=5000) timeout; Undo calls POST /restore + refresh; phantom row renders at top of table with Archived badge + Undo button. Tests added: direct-execute (no dialog), phantom+undo, phantom timeout.

## D. Coordinator UI General

### D1. Version number sourced from somewhere real
- Goal: monorepo-wide LOCKSTEP version once published → any consistent source works (server-reported package version, UI package.json, or build-time constant).

## E. Swarm Topology

### E1. Status indicators = live websocket state  ✅ COMPLETED → `plan-swarm-topology-live-ws-status`
- Red when a beacon's websocket is NOT connected.
- IMPLEMENTED: coordinator exposes `connected` (isBeaconConnected) on GET /beacons + /beacons/:id + /ws initial beacons; beacon-ws.ts published beacon.connected/beacon.disconnected events over UI /ws and hardened half-open detection with a ping/pong startBeaconLivenessSweep (30s, isAlive, terminate dead sockets). UI topology.tsx + beacon-detail.tsx use `connected` with green/red/amber dots and live-update. Tests: coordinator beacon-ws.test.ts + routes/beacons.test.ts; UI topology.test.tsx + beacon-detail.test.tsx.

## F. Session Transcript

### F1. Emit session-parameter events to coordinator  ✅ COMPLETED → `plan-swarm-session-param-events`
- Persona changes, focus string changes, macro executed, plus a synthetic event at session start when it's a subagent.
- IMPLEMENTED: 4 new DroneConversationEvent kinds (personaChanged/focusChanged/macroExecuted/sessionStarted) emitted via new unified `registration.emitEvent` API (Option A). Coordinator transcript KEPT_EVENT_KINDS + renderEvent surface all 4. Tests: coordinator transcript.test.ts + agent session-param-events.test.ts + macros.test.ts.

## G. Transcript tools

### G1. `defaultHidden: true` tools for transcripts
- Check for / implement `defaultHidden: true` tools for: accessing transcripts, and "workflow"-ing transcripts.

## H. Swarm memory wiki schema

### H1. "One-sentence pitch" as official schema field  ✅ COMPLETED → `plan-swarm-memory-wiki-pitch-field`
- Make the one-sentence pitch an official part of the swarm memory wiki page schema.
- Source it from there in the "swarm memory RAG" prompt fragment, rather than assembling it procedurally.
- IMPLEMENTED: optional `pitch?: string` on `DroneWikiPageMeta`; stored in frontmatter (build/parse/read/list in `wiki-storage.ts`); beacon+coordinator PUT accept it; `/wiki/semantic-search` enriches results with metadata pitch; retriever prefers stored pitch over `matchedChunk`; `swarm__wiki_write`, drone-swarm CLI (`--pitch`), and migration carry it; UI editor + detail page now have a Pitch field/row (grid untouched); librarian persona + memory-wiki skill seeds instruct writing a pitch.