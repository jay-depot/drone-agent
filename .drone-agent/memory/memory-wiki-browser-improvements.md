---
key: memory-wiki-browser-improvements
tags:
  []
created: 2026-09-04T19:20:44.200Z
updated: 2026-09-04T19:34:50.712Z
---

# Memory Wiki Browser Improvements — Organized List (from brainstorm session)

Ready-to-plan list of improvements. Brought into future planning sessions.

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

## B. Edit Pages

### B1. Back buttons
- All edit pages (wiki create/edit, skills, personas, etc.).
- Bug: item "back" does history -1 now, but edit-page back buttons navigate forward to the item view → infinite link loop.
- Fix: reuse the standard history-back pattern used everywhere else.

## C. Session Listing

### C1. Remove confirmation dialogs on workflow actions
- None are destructive (End / Archive / Restore).
- Archive-only "phantom row with undo" (lingering a few seconds); all other actions leave item in place for easy reversion anyway.

## D. Coordinator UI General

### D1. Version number sourced from somewhere real
- Goal: monorepo-wide LOCKSTEP version once published → any consistent source works (server-reported package version, UI package.json, or build-time constant).

## E. Swarm Topology

### E1. Status indicators = live websocket state
- Red when a beacon's websocket is NOT connected (currently misreads "recently restarted").
- If already wired to WS, investigate why connections are unstable.
- Open: "never seen" handling — red since coordinator restart; if never seen at all, ambiguous (pending TOFU approval) → find a place that needs it.

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