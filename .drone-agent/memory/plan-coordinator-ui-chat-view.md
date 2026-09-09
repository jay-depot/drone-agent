---
key: plan-coordinator-ui-chat-view
tags:
  - plan
  - coordinator-ui
  - chat-view
  - session-detail
  - coordinator
  - status: completed
created: 2026-09-09T00:30:23.032Z
updated: 2026-09-09T00:51:22.359Z
---

# Plan: Coordinator UI session chat view (human-friendly event rendering + blob delivery)

status: completed (2026-09-09, session on branch feat/coordinator-ui-sessions)

## Feature

Replace the session-detail page's raw-JSON event log with a human-friendly chat transcript (TUI-inspired, web-native): user messages as right-aligned bubbles, assistant replies as markdown, tool calls/results as paired compact items, lifecycle events as dividers. Deliver oversized payloads judiciously — a trimmed summary feed over REST and WS, with full content (including `blob:`-stored payloads) fetched lazily per event. The current view stays temporarily behind a Chat/Raw toggle (chat default) and is deleted once validated.

## Locked decisions (grilling session, 2026-09-09)

1. **Chat transcript view**, TUI-inspired. User bubbles right-aligned; assistant markdown full-width; reasoning inline muted; tool call+result paired into one item (status chip `⚙ name` + args summary + result preview, red on error); `error` red; `notice`/`compaction` gray; lifecycle (`personaChanged`/`focusChanged`/`macroExecuted`/`sessionStarted`) as centered dividers. Everything visible in v1 (no progressive-disclosure polish). Per-item "view source" raw-JSON disclosure.
2. **Summary feed + lazy content, uniform REST and WS.** Feed items carry bounded `preview` (~1000 chars) + `hasFull`; full content via per-event endpoint that resolves `blob:` refs. WS session-event pushes get the same summary transform (today the push site forwards raw payloads unbounded).
3. **New endpoints (option B), deprecate old.** `GET /sessions/:id/chat` + `GET /sessions/:id/events/:eventId/content`; deprecation notices on `/events` + `/events/latest`. `/log` and `/transcript` untouched (different contract, live consumers: drone-swarm CLI, memory-pipeline ingest).
4. **DTO trimmed to display needs**: `{ id, type, name?, correlationId, createdAt, preview, hasFull }`. Dropped: full payload, metadata JSON (kind duplicates type; persona from session object), sessionId.
5. **Volume: latest-window + keyset backward cursor.** Initial load = latest ~100 items (ascending + `hasMore`/`oldestCursor`); "Load earlier" prepends via `before=<createdAt>:<id>` keyset. Live WS appends at bottom, **suspended in history mode** (discarded, "↓ N new" jump pill). **Bottom blocks unload when scrolled deep into history**; descending re-fetches the latest window (self-heals anything missed while suspended).
6. **Shared module**: `drone-coordinator/src/chat-feed.ts` — pure `toChatFeedItem` + `NOISE_EVENT_KINDS` (roundComplete, reasoningComplete, assistantMessageComplete, toolProgress — excluded server-side from both REST feed and WS session-event pushes). REST route and WS push site both consume it.
7. **Page integration**: Chat/Raw toggle URL-persisted (`?view=raw`), chat default day one; raw view deleted later.
8. **Markdown**: extract shared base component from `wiki-markdown.tsx` (it hard-codes frontmatter-splitting + wikilink preprocessing that would mangle chat text); WikiMarkdown wraps the base.
9. **Batch granularity (decided at plan time — flag at review)**: feed items stay event-granular (matches blob storage/keying); the client splits `toolCallBatch`/`toolResultBatch` into per-tool rows and pairs calls↔results positionally within a turn (results execute in order). Page-boundary orphan results render as result-only chips.

## Known facts (verified 2026-09-09)

- Payloads are full JSON-serialized DroneConversationEvent; content kinds carry `.content`, `error` carries `.message`, `toolCallBatch` = `{toolCalls:[{name,arguments}]}`, `toolResultBatch` = `{results:[{name,content,arguments}]}`. `metadata.name` is the tool name.
- Blobs: >10KB payloads stored at `<blobDir>/<sessionId>/<eventId>-<hash>.blob`, DB row holds `blob:<sessionId>/<eventId>/<hash>`. `GET /events` returns refs raw; `/log` resolves all (no pagination). `retrieveLargePayload` failure → null.
- No base64 images in events (structured `images[]` channel never reaches coordinator) — images are a non-goal.
- `GET /sessions/:id/events` has no default limit; correlationId groups = turns (proven in transcript.ts `buildSessionTranscript`).
- WS `event` messages are consumed by topology/beacon-detail for OTHER eventTypes (beacon.connected etc.) — the summary transform applies ONLY at the session-events push site (`POST /sync/events/push` loop), not the shared pubsub.
- `publishMutationEvent` at the push site currently forwards raw untruncated payloads.

## Steps

### Phase 1 — Coordinator (shared module + endpoints + WS transform)

1. (coder) New `drone-coordinator/src/chat-feed.ts` — pure, no I/O: ✅ (delivered as planned; plus `isNoiseEvent` helper)
2. (coder) `drone-coordinator/src/db/swarm-sessions.ts` — add `getSwarmEvent(sessionId, eventId)`. ✅ (+ `getChatFeedEvents` with keyset composite cursor `<createdAt>:<id>`, `limit+1` fetch for hasMore)
3. (coder) `GET /sessions/:id/chat` — limit (default 100, clamp [1,500]), keyset `before`, blob-aware preview (blobbed `toolResultBatch` → preview '' + hasFull, no disk IO; other blobbed kinds → resolved for preview). ✅
4. (coder) `GET /sessions/:id/events/:eventId/content` — 404 session/event mismatch; blob resolve, null → 404 'content unavailable'. ✅
5. (coder) WS transform at session-events push site — noise skipped, `payload: ChatFeedItem`. ✅
6. (coder) Deprecation notices — `Deprecation: true` + `Sunset` headers, one-time module logger.warn. ✅
7. (tester) `drone-coordinator/test/routes/chat.test.ts` (new, 12 tests): ascending trimmed summaries, noise exclusion, tool-batch name summaries, >1000-char truncation + hasFull, blobbed toolResultBatch preview-less, keyset pagination incl. createdAt-tie composite, limit clamps, content endpoint (inline/blob/missing-blob 404/session mismatch), deprecation headers, WS push-site transform via subscriber spy. ✅ 12/12

### Phase 2 — UI: base markdown extraction

8. (coder) `src/components/markdown.tsx` (new) — base `Markdown` with typed `Components` map; `wiki-markdown.tsx` refactored to wrap it (frontmatter collapse + wikilink preprocessing stay wiki-side). ✅ 8 existing wiki tests pass through the wrapper; 4 new base tests.

### Phase 3 — UI: chat view

9. (coder) `src/lib/chat-types.ts` (new): `ChatFeedItem`, `ChatFeedResponse`, `EventContent`. ✅
10. (coder) `src/components/chat/session-chat.tsx` (new): turn grouping by correlationId (adjacent-run), batch splitting `buildToolRows` (positional pairing, orphan rows, blobbed-result placeholder), per-kind renderers (bubble/markdown/reasoning muted/error red/system gray/lifecycle dividers/tool chips), expand → one content fetch per event id (Map cache), stick-to-bottom auto-scroll (distance-from-bottom heuristic). ✅
11. (coder) History windowing inside SessionChat: blocks array, `loadEarlier` on scroll-near-top (HISTORY_ENTER_PX), MAX_RENDERED_ITEMS=600 unload-newest-while-in-history with atLatest=false, resetToLatest re-fetch on "Jump to latest". ✅ (Note: the "↓ N new" live-count pill from the plan draft was simplified to a jump button — live WS items append when at bottom, matching the plan's suspension intent; the counted-pill polish is available later.)
12. (coder) `src/pages/session-detail.tsx` — `?view=raw` URL-persisted toggle (button in Session Info card), chat default; WS handler narrows ChatFeedItem-shaped payloads into the chat feed (raw view keeps legacy synthesis); ADR 201 resilience logic untouched. ✅
13. (tester) `session-chat.test.tsx` (7: buildToolRows pairing/orphan/blobbed, user+markdown rendering, lifecycle divider + muted reasoning, expand-fetch-once-cached, live-append-no-refetch) + `markdown.test.tsx` (4). ✅

### Phase 4 — Validation ✅

14. LSP clean workspace-wide; `pnpm lint` green; `pnpm -r run build` green; root `pnpm test` 2870 passed / 14 skipped; UI hermetic `NODE_ENV=test` 170 passed.
15. Manual spawn-flow check: not run this session (no live swarm) — same caveat as ADR 201; covered by API + component tests.

## Validation results

- All criteria met except the live manual check (above).
- En-route finds: Base UI Collapsible `onOpenChange(open, details)` — first arg is the boolean (the `detail.open` idiom from the draft silently no-ops; caught by the expand test, would have broken every tool-chip expand in the real UI); testing-library `selector` option filters the MATCHED element (text on inner spans can never match an ancestor selector — use a matcher fn checking `getAttribute('data-slot')`).

## Out of scope (unchanged)

- Images in events (needs event-schema work in the agent).
- Server-side turn grouping (client owns it); server-side batch expansion.
- Agent-side changes (event push stays as-is).
- Deleting the raw view (follow-up once chat view is validated).
- `followup-coordinator-ws-event-ids` items that remain open (persistent event ids across REST+WS dedup) — the chat feed sidesteps the id gap by putting feed-item fields in WS payloads, but the generic dedup follow-up stays tracked.