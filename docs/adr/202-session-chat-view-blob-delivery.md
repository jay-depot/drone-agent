---
tags: [coordinator, coordinator-ui, chat, events, adr]
related:
  [
    drone-coordinator.md,
    drone-coordinator-ui.md,
    decisions/198-coordinator-ui-launch-interact.md,
    decisions/201-session-detail-live-chat-resilience.md,
    decisions/203-coordinator-ui-archive-undo-and-error-display.md,
    decisions/205-session-chat-truncation-expansion.md,
  ]
---

# Coordinator UI session chat view: human-friendly event rendering + blob delivery

**Summary**: Replaces the session-detail page's raw-JSON event log with a human-friendly chat transcript (TUI-inspired, web-native): user messages as right-aligned bubbles, assistant replies rendered as markdown, tool calls/results as paired compact chips, lifecycle events as dividers. Delivering oversized payloads becomes judicious — a trimmed summary feed (`preview` ≤1000 chars + `hasFull`) served over both REST and WS from one shared transform, with full content (including `blob:`-stored payloads) fetched lazily per event. The raw log remains temporarily behind a URL-persisted `?view=raw` toggle (chat is the default) and is deleted once validated.

## Context

ADR 198 delivered interactive remote chat, but the session page rendered each event as a collapsible card of raw JSON — functional, not pleasant, and structurally unbounded: payloads >10KB are stored as `blob:` file references (ADR 185 lineage), the events table has no default limit, and the **live WS channel bypassed blobbing entirely** (the push site forwarded raw payloads unbounded). Three design forks resolved by grilling: (1) visual model — a chat transcript, not prettier cards; (2) delivery — summary feed + lazy content, uniform across REST and WS; (3) API shape — new endpoints with deprecation notices rather than a mode flag on the raw route.

## Decision

1. **New endpoints, not query-param modes.** `GET /sessions/:id/chat` (summary feed) + `GET /sessions/:id/events/:eventId/content` (lazy full content, resolving `blob:` refs; 404 `content unavailable` when the blob is missing). `GET /events` + `/events/latest` gain `Deprecation`/`Sunset` headers + a one-time log warn. `/log` and `/transcript` are untouched — different contract (full-resolving, machine-readable) with live consumers (drone-swarm CLI, memory-pipeline ingest).
2. **DTO trimmed to display needs**: `{ id, type, name?, correlationId, createdAt, preview, hasFull }`. Dropped: the full payload, the metadata JSON (`kind` duplicates `type`; persona comes from the session object), and `sessionId` (route param / WS envelope).
3. **One shared transform, no drift.** `drone-coordinator/src/chat-feed.ts` is pure: `toChatFeedItem` (+ `NOISE_EVENT_KINDS` = `roundComplete`, `reasoningComplete`, `assistantMessageComplete`, `toolProgress` — excluded server-side from both REST and WS) and `summarizePayload` (per-kind display text: `.content` / `.message` / tool-batch compact lines; truncate at `PREVIEW_CHARS=1000` with `…[+N chars]`). The `/chat` route and the session-events WS push site both consume it.
4. **Blob-aware previews.** A blobbed `toolResultBatch` yields `preview: ''` + `hasFull: true` — the chip needs only the tool name — so the feed never does per-item disk I/O. Other blobbed kinds resolve server-side for the preview; the content endpoint remains the fallback resolver.
5. **Volume: latest window + keyset backward cursor + bounded history.** Initial load = latest `limit` (default 100, clamp 1–500) items, returned ascending with `{ items, hasMore, oldestCursor }`; "Load earlier" prepends via `before=<createdAt>:<id>` (composite tie-safe, robust under concurrent appends — unlike offsets). Live WS items append when at the bottom; scrolling deep into history suspends appends and **unloads the newest block(s)** beyond a 600-item cap; descending re-fetches the latest window, which self-heals anything missed while suspended.
6. **Client owns grouping.** Turns = adjacent runs of the same `correlationId`; the client also splits `toolCallBatch`/`toolResultBatch` into per-tool rows and pairs calls↔results positionally (results execute in order); page-boundary orphan results render as result-only rows.
7. **Markdown via a shared base component.** `markdown.tsx` holds the typed `Components` map + link behavior; `wiki-markdown.tsx` wraps it with its wiki-specific preprocessing (frontmatter collapse, wikilink rewriting — which would mangle chat text containing `---` or `[[...]]`).

## Implementation

- `drone-coordinator/src/chat-feed.ts` — pure transform (no I/O); `isNoiseEvent`, `toChatFeedItem`, `summarizePayload`, `PREVIEW_CHARS`.
- `drone-coordinator/src/db/swarm-sessions.ts` — `getSwarmEvent(sessionId, eventId)`; `getChatFeedEvents` keyset page (fetch `limit+1` for `hasMore`, reverse to ascending).
- `drone-coordinator/src/routes/swarm.ts` — `/chat` + `/events/:eventId/content` routes; deprecation markers; the `POST /sync/events/push` loop now publishes `ChatFeedItem` payloads for session events and skips noise (other `publishMutationEvent` sites untouched — topology/beacon-detail still receive their lifecycle events raw).
- `drone-coordinator-ui/src/components/markdown.tsx` — shared base `Markdown` (typed `Components` map, internal/external link behavior).
- `drone-coordinator-ui/src/components/chat/session-chat.tsx` — transcript with turn grouping, batch splitting/pairing, per-kind renderers, expand-to-fetch (one request per event id, cached), stick-to-bottom auto-scroll, Load-earlier, history unload + jump-to-latest.
- `drone-coordinator-ui/src/lib/chat-types.ts` — `ChatFeedItem`, `ChatFeedResponse`, `EventContent`.
- `drone-coordinator-ui/src/pages/session-detail.tsx` — `?view=raw` toggle (URL-persisted), chat default; the WS handler narrows feed-item-shaped payloads into the chat view while the raw view keeps the legacy synthesis; ADR 201 resilience logic untouched.

## Tests

- `drone-coordinator/test/routes/chat.test.ts` (12): ascending trimmed summaries, noise exclusion, tool-batch name summaries, truncation + `hasFull`, blobbed toolResultBatch preview-less, keyset pagination incl. `createdAt` ties, limit clamps, content endpoint (inline / resolved blob / missing blob 404 / session mismatch), deprecation headers, and the WS push-site transform verified through a pub/sub subscriber.
- `drone-coordinator-ui/src/components/chat/session-chat.test.tsx` (7): positional pairing, orphan rows, blobbed-result rows, per-kind rendering, expand-fetch-once (cached), live-append without refetch.
- `drone-coordinator-ui/src/components/markdown.test.tsx` (4): base component headings/GFM tables/external links/inline code.

## Key Points

- **Feed the UI what it displays, not what you stored.** The trimmed DTO (no full payloads, no redundant metadata) is what makes the feed cheap enough to serve over WS unconditionally — and forced the "blobbed tool results skip preview" rule, keeping the hot path disk-I/O-free.
- **Uniform summaries end the raw-payload-on-WS hole.** Blobbing only bounded persistence; the live channel still shipped full payloads. Applying the transform at the push site closes the asymmetry — and only at the session-event site, because topology/beacon-detail consumers need their own event shapes.
- **Keyset beats offset for append-only feeds** — offsets shift as live events arrive; the composite `(createdAt, id)` cursor doesn't.
- **Unloading history blocks makes "load earlier" free of memory growth**; the descending re-fetch doubles as the catch-up mechanism for anything suspended while browsing.
- **Base UI's `onOpenChange(open, details)` passes the boolean as the first arg** — a `detail => detail.open` callback silently no-ops (no crash); the expand test caught a would-have-shipped-invisible bug. Related: testing-library's `selector` filters the element the text matcher matched (the innermost text node's element), not ancestors — scope to a container with a custom matcher fn instead.

## Related

- [198-coordinator-ui-launch-interact](198-coordinator-ui-launch-interact.md) — the interactive chat this view renders; the raw view it supersedes
- [201-session-detail-live-chat-resilience](201-session-detail-live-chat-resilience.md) — the crash/recovery fixes under this page; the lifecycle-refetch list chat mode also relies on
- [drone-coordinator](../../drone-coordinator/) — `chat-feed.ts`, the `/chat` + content routes, db keyset query
- [drone-coordinator-ui](../../drone-coordinator-ui/) — `SessionChat`, base `Markdown`, the `?view=raw` toggle
- [205-session-chat-truncation-expansion](205-session-chat-truncation-expansion.md) — the expansion affordance for this ADR's truncation slugs; revises the placeholder rule for resolved blobbed payloads
