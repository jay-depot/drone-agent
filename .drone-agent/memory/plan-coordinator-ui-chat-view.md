---
key: plan-coordinator-ui-chat-view
tags:
  - plan
  - coordinator-ui
  - chat-view
  - session-detail
  - coordinator
created: 2026-09-09T00:30:23.032Z
updated: 2026-09-09T00:30:23.032Z
---

# Plan: Coordinator UI session chat view (human-friendly event rendering + blob delivery)

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

1. (coder) New `drone-coordinator/src/chat-feed.ts` — pure, no I/O:
   - `export const PREVIEW_CHARS = 1000;`
   - `export const NOISE_EVENT_KINDS = new Set(['roundComplete','reasoningComplete','assistantMessageComplete','toolProgress']);`
   - `export interface ChatFeedItem { id: string; type: string; name?: string; correlationId: string | null; createdAt: number; preview: string; hasFull: boolean; }`
   - `export function toChatFeedItem(evt): ChatFeedItem | null` — null for noise kinds. `summarizePayload(type, payloadJson)`: parse payload, per kind pick display text (content kinds → `.content`; `error` → `.message`; `toolCallBatch` → per-call `name(args…)` compact text; `toolResultBatch` → results' `.content`; fallback → raw payload). Truncate to PREVIEW_CHARS with `…[+N chars]`; `hasFull = truncated`.
   - Blob-aware preview flag: `toChatFeedItem` accepts `payloadWasBlobRef` (route resolves refs where needed); for blobbed `toolResultBatch` skip preview content entirely (`preview: ''`, `hasFull: true`) — the chip needs only `name` from metadata; keep /chat cheap on disk IO.
2. (coder) `drone-coordinator/src/db/swarm-sessions.ts` — add `getSwarmEvent(sessionId, eventId)`.
3. (coder) `drone-coordinator/src/routes/swarm.ts` — `GET /sessions/:id/chat`:
   - Query: `limit` (default 100, max 500), `before` cursor `<createdAt>:<id>` (keyset: `(createdAt < c) OR (createdAt = c AND id < i)`).
   - Fetch DESC via `getLatestSwarmEvents`-style query (add keyset support to db layer), reverse to ascending. Resolve `blob:` refs for preview except blobbed `toolResultBatch` (step 1 rule). Map through `toChatFeedItem`, drop nulls.
   - Response `{ items, hasMore, oldestCursor }`.
4. (coder) `drone-coordinator/src/routes/swarm.ts` — `GET /sessions/:id/events/:eventId/content`:
   - `getSwarmEvent` → 404 if missing/session mismatch. `blob:` ref → `retrieveLargePayload` (null → 404 `{error:'content unavailable'}`); else raw payload. Response `{ id, type, payload }` (payload = raw JSON string).
5. (coder) WS transform at the session-events push site (in `POST /sync/events/push` loop): `isNoiseEvent(type)` → skip publish; else `publishMutationEvent({ sessionId, eventType: evt.type, payload: toChatFeedItem(...) })` (blobbed toolResultBatch → preview-less item, same rule). Other publish sites untouched.
6. (coder) Deprecation notices on `GET /events` + `/events/latest`: `Deprecation` + `Sunset` headers, one-time module-level logger.warn.
7. (tester) Coordinator tests (extend `test/routes/swarm.test.ts` or new `chat.test.ts`): ascending summaries with previews; noise kinds excluded; >1000-char preview truncated + hasFull; blobbed toolResultBatch → preview '' + hasFull true without resolution; keyset pagination (before cursor, boundary ties via composite); content endpoint (inline payload, blob resolution, 404s); deprecation headers; WS push site publishes summary items and skips noise (spy on publish or ws client).

### Phase 2 — UI: base markdown extraction

8. (coder) New `drone-coordinator-ui/src/components/markdown.tsx` — extract base `Markdown` from `wiki-markdown.tsx` (styled component map, MarkdownLink internal/external behavior). `wiki-markdown.tsx` refactors to wrap base + `splitFrontmatter` + `preprocessWikiLinks`. Existing wiki-markdown tests keep passing; add a couple for the base.

### Phase 3 — UI: chat view

9. (coder) `src/lib/types.ts` (or new `chat-types.ts`): `ChatFeedItem`, `ChatFeedResponse { items, hasMore, oldestCursor }`, `EventContent { id, type, payload }`. `WsEventMessage.payload` stays `unknown` (other pages receive other payloads); session-detail narrows with a type guard.
10. (coder) New `src/components/chat/session-chat.tsx` — the transcript:
    - Turn grouping: `useMemo` group by `correlationId` (null-correlation items standalone; a `userMessage` starts a turn) — client-side mirror of transcript.ts grouping.
    - Batch splitting: `toolCallBatch` → N pending chips; pair `toolResultBatch.results[i]` positionally within the same turn (order: calls then results; orphan result at page boundary → result-only chip).
    - Renderers per locked map; tool chip expands → fetch `/events/:eventId/content` once (cache per event id), render args rows + result text (markdown for assistant only — tool content plain/pre); "view source" disclosure shows raw JSON (fetched when hasFull).
    - Auto-scroll: stick to bottom when already at bottom; never yank when scrolled up.
11. (coder) History windowing (in session-chat or a `useChatFeed` hook):
    - State: `blocks` (fetched pages), `oldestCursor`, `hasMore`, `atLatest`, `historyMode` (scrolled above threshold), `newCount`.
    - Initial `GET /chat?limit=100`; "Load earlier" prepends `?before=<oldestCursor>`; when total items exceed a cap (~600) while in history, unload newest block(s) (never the one in view) and clear `atLatest`; scrolling back near bottom when `!atLatest` → reset to latest-window fetch; WS item → append iff `atLatest && near bottom`, else bump `newCount` (discarded); jump pill "↓ N new" click → reset to latest fetch.
12. (coder) `src/pages/session-detail.tsx` integration:
    - `?view=raw` URL-persisted toggle (pattern of `?view=archived`), chat default. Raw = existing Collapsible list (kept, marked temporary). Keep live-chat input + ADR 201 resilience logic (lifecycle refetch list unchanged; WS handler now narrows `payload` to ChatFeedItem and feeds the chat view instead of synthesizing SwarmEvent for the raw view only).
13. (tester) UI tests (`session-chat.test.tsx`, `markdown.test.tsx`): per-kind rendering (bubble alignment, markdown block, muted reasoning, divider), positional pairing incl. orphan result, preview truncation + expand fetches content endpoint once (cached), view-source disclosure, grouping, load-earlier prepend, unload-when-deep, live-append suspension + jump pill. All `waitFor`-based (no fixed sleeps; remember the jsdom gotchas: scrollIntoView stub, per-test WebSocket stub re-stub, `selector: '[data-slot="badge"]'` scoping, settle initial fetch before dispatching WS events).

### Phase 4 — Validation

14. LSP diagnostics clean (all packages). `pnpm lint` (root — NOTE: `pnpm -r run lint` does not exist). `pnpm -r run build`. Fast suite = root `pnpm test` (NOTE: `pnpm -r run test` fails spuriously in drone-core). UI hermetic runner `NODE_ENV=test` in drone-coordinator-ui for the new tests.
15. Manual (if swarm up): spawn → chat renders turns live; huge tool result → chip without payload, expand fetches; Load earlier + unload behavior; WS live append + suspension pill.

## Validation criteria

- LSP clean workspace-wide; `pnpm lint`, `pnpm -r run build`, root `pnpm test` (fast) all pass; new coordinator + UI tests pass (UI under `NODE_ENV=test`).
- `/chat` serves trimmed DTO only (no full payloads); noise kinds excluded from REST + WS; keyset pagination stable under concurrent live appends.
- Content endpoint resolves blob refs; UI fetches full content only on expand (one request per event, cached).
- Chat view renders all locked kinds correctly; raw view still available behind toggle; live-chat input unaffected.
- Deprecation headers present on `/events` + `/events/latest`; `/log` + `/transcript` behavior unchanged.

## Out of scope

- Images in events (needs event-schema work in the agent).
- Server-side turn grouping (client owns it); server-side batch expansion.
- Agent-side changes (event push stays as-is).
- Deleting the raw view (follow-up once chat view is validated).
- `followup-coordinator-ws-event-ids` items that remain open (persistent event ids across REST+WS dedup) — the chat feed sidesteps the id gap by putting feed-item fields in WS payloads, but the generic dedup follow-up stays tracked.