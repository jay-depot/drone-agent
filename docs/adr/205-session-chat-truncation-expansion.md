---
tags: [coordinator, coordinator-ui, chat, events, adr]
related:
  [
    drone-coordinator.md,
    drone-coordinator-ui.md,
    decisions/202-session-chat-view-blob-delivery.md,
    decisions/201-session-detail-live-chat-resilience.md,
  ]
---

# Session chat view: expandable truncation slugs + placeholder previews

**Summary**: Closes the dead-text gap in the ADR 202 chat view. The server's `…[+N chars]` truncation suffix and the `(large content — expand to load)` placeholder both become expand affordances: clicking fetches the full payload from the existing per-event content endpoint, swaps it in (markdown-aware, with a local re-truncation budget for placeholder bodies), and collapses back via "show less". A single-expansion policy (one `expandedMessageId` at the parent; expanding another message evicts the expanded one; collapse discards the fetched text) keeps at most one full body in browser memory. Server-side, the blobbed-payload branch now summarizes the resolved payload like any other item, so oversized messages arrive as normal truncated previews; the placeholder survives only for unresolvable blob refs.

## Context

ADR 202 shipped the chat view with two kinds of bounded previews:

1. **Truncation slugs** — `summarizePayload` cuts at `PREVIEW_CHARS = 1000` and appends `…[+N chars]`; `hasFull: true` marks the full content as fetchable from `GET /sessions/:id/events/:eventId/content`. The client rendered the preview verbatim, including the suffix — the slug was dead text, and the content endpoint (used by tool chips since ADR 202) was never wired for message kinds.
2. **Blobbed payloads** — payloads over 10KB are stored as `blob:` refs. The ADR 202 transform had a non-tool blob branch that emitted a `(large content — expand to load)` placeholder **even when the blob resolved fine** — the REST route resolved the payload, then the transform discarded the text. Users saw a dead placeholder for what was recoverable data, with no indication of length or kind.

Also in context: the transcript's typical bloated items are persona instructions and long user prompts, so the feature is used on exactly the messages worth reading in full.

## Decision

1. **The truncation suffix is an affordance, not decoration.** `MessageBody` (new client component replacing the five message-kind render branches in `SessionChat`) parses the `…[+N chars]` suffix (`parseTruncatedPreview`), renders the slug as a small dotted-underline `<button>` (`title="Load N more characters"`), and on click fetches `${contentUrlBase}/${item.id}/content` — the same endpoint tool chips already use. Display text is extracted from the payload (`content` → `message` → raw fallback, mirroring the server's summarize precedence). Assistant messages render expanded bodies through the shared base `Markdown`; other kinds stay plain text.

2. **Single-expansion policy for memory.** `SessionChat` holds one `expandedMessageId: string | null`; expanding another message evicts the previous expansion. The expanded child discards its fetched text on collapse (`useEffect` on `expanded`), so at most one full message body lives in memory at a time. Re-expanding refetches. This is a deliberate contrast with tool chips, which keep their per-row content cache across expansions (chips are bounded by tool-result size; message bodies are not, and several persona-instruction messages can be 40KB+).

3. **Fix the blobbed branch at the source (server), not with a client workaround.** `toChatFeedItem`'s non-tool blob branch now falls through to `summarizePayload` when the caller resolved the blob (payload non-null) — the `/chat` route already retrieves blobbed non-tool payloads before calling the transform, so the resolved text finally reaches the preview. `null` payload (dangling ref) keeps the placeholder. This keeps full payloads out of feed responses and the WS push path (cheap), and keeps the preview shape uniform (every item is summarizable text + `hasFull`).

4. **The remaining placeholder is still expandable.** When a blob cannot be resolved (`preview === UNRESOLVED_PLACEHOLDER`, `hasFull: true`), the client renders the placeholder itself as the expand button. After expansion, the resolved body is re-truncated **locally** at `PLACEHOLDER_CUT_CHARS = 8192` with a `…[+N chars]` marker (an unresolvable-ref body is unbounded — up to blob-store scale — and 8192 stays comfortably under every transport limit while giving a genuinely useful truncated view), plus "show less" collapse back to the placeholder.

5. **Branch order in `MessageBody` is load-bearing**: `!expandable` (plain preview) → `fullyExpanded` (fetched content rendered, re-truncated if placeholder) → `truncated === null` (placeholder button + loading/error state) → slug path (preview + slug button + loading/error state). The `truncated === null` check doubles as the TypeScript narrowing for the slug path; reordering breaks both the runtime (placeholder stays stuck on "loading…" — caught by the re-truncation test) and the typecheck.

6. **Endpoint reuse over new API.** No new routes, no new query params, no feed-shape changes: the expand flow is `hasFull` + the existing content endpoint. Failure of that fetch renders an inline `Full content unavailable` next to the preview — never a blocked UI.

## Implementation

- `drone-coordinator/src/chat-feed.ts` — non-tool blobbed branch: `payload === null` → placeholder; otherwise falls through to `summarizePayload` (comment documents the caller-resolves contract).
- `drone-coordinator/src/routes/swarm.ts` — unchanged; the `/chat` route's existing retrieve-then-discard of blobbed non-tool payloads is now load-bearing for previews.
- `drone-coordinator-ui/src/components/chat/session-chat.tsx` — `parseTruncatedPreview`, `extractMessageText`, `UNRESOLVED_PLACEHOLDER`/`PLACEHOLDER_CUT_CHARS` constants, `MessageBody` (expand/fetch/evict/collapse + inline error + loading state), `SessionChat.expandedMessageId` + `toggleExpandedMessage`; all five message-kind branches route through `renderBody(item, markdown)`.
- `drone-coordinator-ui/src/lib/chat-types.ts` — unchanged; `EventContent` already fits.

## Tests

- `drone-coordinator/test/routes/chat.test.ts` (14 total, 2 new): blobbed user message (20KB) → truncated preview + `hasFull` + no placeholder; dangling blob ref → placeholder preserved.
- `drone-coordinator-ui/src/components/chat/session-chat.test.tsx` (13 total, 6 new): slug click loads full content + "show less" restores preview; expanding a second message evicts the first (content gone, slug back); re-expanding an evicted message refetches (3 content calls); inline error on endpoint failure; placeholder renders as a `<button>`, expands with 8192-char re-truncation (`…[+808 chars]` for a 9000-char body) + collapse back to placeholder; placeholder and slug share the one-expanded-at-a-time policy (expanding a slug evicts an expanded placeholder and vice versa); re-expansion refetches (3 total content calls).

## Key Points

- **Reuse the seam before building a new one.** The whole feature needed no API change because ADR 202's content endpoint and `hasFull` flag were already the contract; the "new" work was wiring them to message kinds.
- **Server summarization of resolved blobs keeps the feed DTO uniform** — every item is "bounded text + hasFull" and clients need one expansion mechanism, not per-item-type special cases. Fixing this at the transform (where ADR 202 put all preview policy) beats a client-side special case that would have to be replicated by any future feed consumer.
- **One-expansion-at-a-time is a memory policy, not a UX preference** — message bodies are unbounded (persona instructions routinely 10–40KB); the eviction + discard policy caps client memory at one body regardless of transcript size.
- **Local re-truncation exists because the placeholder path's contract is "unbounded on the other side"** — the server cannot promise a size for a payload it could not resolve, so the client budget (8192) is the only guaranteed bound.
- **Branch order in a multi-state component is a correctness property, not style** — the placeholder branch must sit after `fullyExpanded`; the re-truncation test pins this because the failure mode (eternal "loading…") is invisible in types.

## Related

- [202-session-chat-view-blob-delivery](202-session-chat-view-blob-delivery.md) — the feed DTO, content endpoint, and PREVIEW_CHARS this extends; the placeholder this revises
- [201-session-detail-live-chat-resilience](201-session-detail-live-chat-resilience.md) — the session-detail page hosting the chat view
- [drone-coordinator](../../drone-coordinator/) — `chat-feed.ts` transform changes
- [drone-coordinator-ui](../../drone-coordinator-ui/) — `MessageBody`/`SessionChat` expansion state
