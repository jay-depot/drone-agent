# ADR 267: Gateway Outbound Message Splitting — per-adapter char budget, break-preferring splitter, truncation ceiling

**Status**: Accepted (2026-11-02, branch `fix/gateway-message-splitting`)

## Context

The gateway had no outbound size limit of its own. When a reply exceeded the
Matrix homeserver's event size cap, the homeserver rejected the send, the
adapter threw, and the engine's fire-and-forget dispatch
(`void this.handleMessage(msg)`) turned the throw into an unhandled
rejection — the reply silently vanished. The user's request: automatically
split oversized outbound messages across multiple sends, implemented at the
service adapter level, with a maximum total message size after which the
tail is truncated and visibly marked.

## Decision

### 1. The seam is the adapter

Each service adapter owns its platform's size reality, so splitting lives in
the adapter — not the engine and not the markdown renderer. `sendMessage`'s
signature is unchanged: `Promise<string | undefined>`, returning the **last**
chunk's platform ref.

### 2. `maxMessageChars` counts characters, not bytes

The config key is `maxMessageChars` (UTF-16 code units, `string.length`). A
byte-named key that counted characters would be a config lie, and byte-exact
platform accounting (JSON escaping, event framing) is deliberately out of
scope — the budget carries headroom instead. The Matrix adapter defaults to
**20,000** characters per chunk (headroom under the typical Synapse 64 KB
`max_event_size`, covering JSON escaping plus HTML formatting overhead).
`0` disables splitting entirely (legacy single-send behavior).

### 3. Pure splitter: `drone-gateway/src/split-message.ts`

`splitMessage(text, options)` is a pure function with gateway-wide defaults
`DEFAULT_MAX_CHUNK_CHARS = 20_000` and `DEFAULT_MAX_TOTAL_CHARS = 100_000`.
Split-point precedence per chunk:

1. The largest prefix ending at a paragraph break (`\n\n`) — the split keeps
   one `\n` and consumes the other (scan window is budget + 1).
2. Else the largest prefix ending at a line break (`\n`) — consumed.
3. Else a hard cut at exactly the budget.

A break candidate that would end the message on a markdown ATX heading line
(`#`–`######`) is rejected while any later break fits — a heading belongs to
the paragraph it introduces, so the heading is glued to the following text.
Only when no valid break exists does the hard cut split, possibly
mid-heading (documented best-effort; the alternative is a message ending on
a bare heading).

A chunk that would hold only line breaks is skipped as noise. Text at or
under both budgets returns as a single unmarked chunk; an empty string
returns `['']` (one send, never zero).

### 4. Markers count toward the budget

Continuation messages get a ` (n/m)` suffix; the first message is unmarked.
Marker width is reserved from the continuation budget before packing, and
the reservation is re-packed to the smallest self-consistent chunk count, so
a marker can never push its message over budget. When the total exceeds the
hard ceiling, the final message ends with
`[message truncated — N characters were dropped]` and carries no
continuation marker (the truncation marker already says it is the end). The
cut can reach 0 — an all-truncation message is possible — and the marker is
emitted even when it alone exceeds the remaining ceiling: the reader must
always see that content was dropped. The truncated tail is bounded by **both**
the ceiling remainder and `maxChunkChars` (with the defaults, a 20k/100k
split must not be able to emit a ~40k tail message).

### 5. Per-chunk ledger rows via `splitOutbound`

`DroneServiceAdapter` gains an optional method, mirroring the
`handleBatch?`/`dispose?` idiom:

```ts
splitOutbound?(text: string): string[];
```

`injectMessage` pre-splits through it and records **one outbound-ledger row
per chunk**, each paired with that chunk's own platform ref. Adapters
without the method keep the current single-send, single-row behavior. The
reply paths (`handleMessage`/`dispatchBatch`) need no changes — they call
`sendMessage` and splitting benefits them transparently.

### 6. One typing pair and one read receipt per call

A split message still produces one typing start/stop pair and at most one
read receipt per `sendMessage` call — the chat-protocol metadata is per
message, not per chunk.

### 7. Split before render, fail like today

Chunks are cut **before** markdown rendering so an HTML tag never breaks
mid-chunk. A mid-split send failure propagates exactly like today's
single-send failure (the engine swallows it); no partial-send retry or
resume logic.

## Consequences

- Oversized replies now arrive in full instead of vanishing; continuation
  messages are visibly numbered, and genuine over-ceiling cases are visibly
  truncated with a dropped-character count.
- The outbound ledger grows one row per chunk for injected oversized text
  (ADR 249 consumers see finer-grained rows; the per-row `text` is the chunk).
- Future adapters (telegram, slack) implement `splitOutbound` with their own
  per-service default constant.
- Non-goals: reactions work, byte-exact platform limits, retry/resume of
  partially-sent splits, telegram/slack changes.
- Tests: `test/split-message.test.ts` (pure splitter), extended
  `test/matrix-adapter.test.ts` (chunk sequence, single typing pair, `0`
  disables, mid-split failure, `splitOutbound` parity) and
  `test/engine.test.ts` (per-chunk injection sends + ledger rows, no-method
  fallback, mid-split ledger silence).
