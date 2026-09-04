---
key: memory-wiki-browser-improvements
tags:
  []
created: 2026-09-04T19:20:44.200Z
updated: 2026-09-04T20:00:15.009Z
---

# Memory Wiki Browser Improvements — Organized List (from brainstorm session)

Ready-to-plan list of improvements. Brought into future planning sessions.

## STATUS: B (edit-page back buttons) and C (session listing confirmations) COMPLETED 2026-09-04.
## STATUS: E1 PLAN APPROVED 2026-09-04 → see dedicated plan `plan-swarm-topology-live-ws-status`.

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

### A5. Connected node graph view (OPEN / deferred)
- On the fence, leaning toward liking it.
- Saved as a "human prompt" for future thinking — NOT committed.
- Possible form: tabs under sidebar items (alternatives still being explored).
- If built: nodes = pages, edges = wikilinks; toggle vs table; static vs interactive — all open.

## B. Edit Pages  ✅ COMPLETED

### B1. Back buttons
- All edit pages (wiki create/edit, skills, personas, etc.).
- Bug: item "back" does history -1 now, but edit-page back buttons navigate forward to the item view → infinite link loop.
- FIX: wiki-editor, persona-editor, skill-editor — changed main "← Back" AND bottom "Cancel" buttons to `navigate(-1)` (history-back), matching the loading-state back button and the detail-page back pattern. Tests: persona-editor.test.tsx / skill-editor.test.tsx (new) + wiki-editor.test.tsx (added) cover history-back via MemoryRouter multi-entry initialEntries.

## C. Session Listing  ✅ COMPLETED

### C1. Remove confirmation dialogs on workflow actions
- None are destructive (End / Archive / Restore).
- ARCHIVE-only "phantom row with undo": sessions.tsx no longer uses a `<Dialog>` for workflow actions (removed Dialog import, openDialog, handleDialogConfirm, dialog state/JSX). Direct handlers: handleTerminate, handleProcess, handleMarkProcessed, handleEnd, handleRestore, handleArchive, handleUndoArchive. handleArchive calls POST /archive, removes the row, sets a phantomArchive with a 5s (ARCHIVE_UNDO_MS=5000) timeout; Undo calls POST /restore + refresh; phantom row renders at top of table with Archived badge + Undo button. Terminate stays visually destructive but acts immediately. Tests added to sessions.test.tsx: direct-execute (no dialog), phantom+undo, phantom timeout.

## D. Coordinator UI General

### D1. Version number sourced from somewhere real
- Goal: monorepo-wide LOCKSTEP version once published → any consistent source works (server-reported package version, UI package.json, or build-time constant).

## E. Swarm Topology

### E1. Status indicators = live websocket state — PLAN APPROVED → `plan-swarm-topology-live-ws-status`
- Red when a beacon's websocket is NOT connected (currently misreads "recently restarted").
- Root cause confirmed: topology.tsx `isBeaconOnline` + beacon-detail.tsx `isOnline` use 5-min heartbeat heuristic, NOT live WS state. Coordinator already tracks live reverse-channel WS via `isBeaconConnected` (beacon-ws.ts).
- Decisions: untrusted pending = AMBER; only topology+beacon-detail need it; live-updating via beacon.connected/disconnected events on UI /ws; `connected` field on GET /beacons + /:id; harden half-open detection (ping/pong isAlive sweep).

## F. Session Transcript

### F1. Emit session-parameter events to coordinator
- Persona changes, focus string changes, macro executed, plus a synthetic event at session start when it's a subagent.
- All land in the readable transcript sent to the swarm memory ingest agent.

## G. Transcript tools

### G1. `defaultHidden: true` tools for transcripts
- Check for / implement `defaultHidden: true` tools for: accessing transcripts, and "workflow"-ing transcripts.

## H. Swarm memory wiki schema

### H1. "One-sentence pitch" as official schema field
- Make the one-sentence pitch an official part of the swarm memory wiki page schema.
- Source it from there in the "swarm memory RAG" prompt fragment, rather than assembling it procedurally.