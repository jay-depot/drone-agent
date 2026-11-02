---
key: plan-gateway-outbound-message-splitting
tags:
  - plan
  - drone-gateway
  - message-splitting
  - adapters
  - truncation
  - outbound
created: 2026-11-02T18:44:33.368Z
updated: 2026-11-02T19:47:46.899Z
---

# Plan: Gateway outbound message splitting (per-adapter, with truncation cap)

**Status:** Ready for execution. Planned 2026-11-02 (session `plan` persona, beacon ambicatus).
**Origin:** User request — "the gateway drops messages that exceed a service's size limit with an error. Automatically split these across multiple messages instead. Implement at the service adapter level, with a maximum total message size after which we truncate and mark it as such."
**Related:** swarm wiki `drone-gateway-reactions-design-and-two-histories` (future reactions feature shares the send path but is NOT part of this plan; no reactions plan exists in project memory — the user declined one). ADR 249 (outbound ledger). ADR 234 (injection).

## Summary

The drone-gateway has no outbound size limit of its own. When a reply exceeds the Matrix homeserver's event size cap, the homeserver rejects the send, the adapter throws, and the engine's fire-and-forget dispatch (`void this.handleMessage(msg)`, engine.ts) turns the throw into an unhandled rejection — the reply silently vanishes. Fix: each service adapter splits oversized outbound text into multiple sends before any platform call. A hard total-size ceiling bounds the split; beyond it the tail is truncated and visibly marked.

## Locked decisions (user-approved 2026-11-02)

- **D1 — Limit source.** Per-service default constant inside each adapter, overridable per adapter instance via `adapter.json`. Matrix default: **20,000 characters** per chunk (headroom under the typical Synapse 64 KB `max_event_size`, covering JSON escaping + HTML formatting overhead).
- **D2 — Split points.** Prefer the last paragraph break (`\n\n`) before the budget; then the last line break (`\n`); then a hard character cut. Each preferred split consumes exactly one character (the dropped `\n`); a hard cut consumes nothing.
- **D3 — Markers.** Continuation chunks get a `(n/m)` suffix — ` (2/3)`. When the total exceeds the hard ceiling, the final chunk is cut and ends with `[message truncated — NNNN characters were dropped]`. Markers count toward the chunk budget.
- **D4 — Hard ceiling.** Gateway-wide constants in the splitter module: `DEFAULT_MAX_TOTAL_CHARS = 100_000`. Beyond it, truncate + mark. Marker wording lives in the splitter (overridable via options for tests).
- **D5 — Return value / ledger.** `sendMessage` keeps its `Promise<string | undefined>` signature (returns the LAST chunk's platform ref). The outbound ledger records one row PER CHUNK, each with its own ref. New optional adapter method `splitOutbound(text): string[]` lets the engine pre-split injection text so it can pair refs with chunk texts.
- **D6 — Typing/receipt.** One typing notification + one read receipt per `sendMessage` call (as today), not per chunk.
- **D7 — Naming.** Config key is `maxMessageChars` (NOT `maxMessageBytes` as first sketched): the splitter counts UTF-16 code units (`string.length`), not bytes. A byte-named key that counts chars would be a config lie.
- **D8 — Mid-split failure.** A chunk send that throws propagates (engine swallows it, same as today's single-send failure). No partial-send retry logic in this change.

## Verified code facts (planning session, line numbers snapshot)

- `drone-gateway/src/types.ts` — `DroneServiceAdapter.sendMessage(conversationId, text): Promise<string | undefined>`; only outbound primitive.
- `drone-gateway/src/engine.ts` — reply post at :250 (handleMessage) and :283 (dispatchBatch), both inside `runOnTail` and guarded by `if (result.response)`; injection at :367 (`injectMessage`) followed by `adapter.outboundLedger?.append(conversationId, { platformRef, text })`. Dispatch entered via `void this.handleMessage(msg)` — throws become silent unhandled rejections.
- `drone-gateway/src/adapters/matrix.ts` — `sendMessage` (:300): `resolveTarget` → `sendTyping(true)` → `sendReadReceipt` → render → `sendHtmlMessage`/`sendMessage` → return `eventId` → `finally sendTyping(false)`. Config is cast raw from adapter.json (`config as unknown as MatrixAdapterConfig`), so a new optional config field needs no loader schema change.
- `drone-gateway/src/markdown.ts` — `BasicMarkdownRenderer.render(md) → { body, formattedBody }`. Chunks MUST be cut before rendering or HTML tags break mid-chunk.
- `drone-gateway/src/store/gateway-state-store.ts` — `OutboundLedgerHandle.append(conversationId, { platformRef?, text })`; one INSERT per call; already fits per-chunk rows.
- Only adapter implemented: matrix (roadmap 4.6 telegram / 4.7 slack not started). Future adapters implement `splitOutbound` + per-service default.
- Tests today: `test/matrix-adapter.test.ts`, `test/engine.test.ts`, `test/markdown.test.ts` (mock-client + engine-fixture patterns to copy).

## Steps

### Step 1 — Pure splitter module [coder]
NEW `drone-gateway/src/split-message.ts`:

```ts
export const DEFAULT_MAX_CHUNK_CHARS = 20_000;
export const DEFAULT_MAX_TOTAL_CHARS = 100_000;

export interface SplitOptions {
  maxChunkChars: number;   // source-text budget per chunk, marker included
  maxTotalChars: number;   // hard ceiling on total chars sent
  continuationMarker?: (n: number, total: number) => string; // default ` (${n}/${total})`
  truncationMarker?: (droppedChars: number) => string;       // default `[message truncated — ${dropped} characters were dropped]`
}

export function splitMessage(text: string, options: SplitOptions): string[];
```

Rules:
- `text.length <= maxChunkChars` and total under ceiling → `[text]`, no markers.
- Greedy pack: take the largest prefix ≤ budget ending at a `\n\n`; else a `\n`; else hard cut at exactly the budget. The `\n\n`/`\n` split drops the break character (budget +1 effective).
- Repeat until exhausted. If `sum(chunk + marker) > maxTotalChars`: stop, append a final chunk cut to the remaining budget minus the truncation marker, and append the truncation marker with the dropped-char count.
- Edge cases: empty string → `['']` (one send, never zero); `maxTotalChars < maxChunkChars` → clamp to truncation after the first chunk; text exactly at budget → no marker.

### Step 2 — Splitter unit tests [tester, with Step 1]
NEW `drone-gateway/test/split-message.test.ts`. Cover: no-split-under-limit; paragraph-preferred split; line fallback; hard cut; `(n/m)` marker text; truncation marker + dropped count; total-ceiling exhaustion; empty string; clamps; marker overhead pushing the last chunk over budget.

### Step 3 — Matrix adapter wiring [coder, after Step 1]
`drone-gateway/src/adapters/matrix.ts`:
- `MatrixAdapterConfig` gains `maxMessageChars?: number` (jsdoc: default 20000; `0` disables splitting).
- `sendMessage`: resolve budget (`this.config.maxMessageChars ?? DEFAULT_MAX_CHUNK_CHARS`); when > 0, `const chunks = splitMessage(text, { maxChunkChars, maxTotalChars: DEFAULT_MAX_TOTAL_CHARS })`; hoist `sendTyping(true)` + read receipt above the loop; loop chunks — render THEN send each (`rendered.formattedBody ? sendHtmlMessage : sendMessage`), keep the `finally sendTyping(false)`; return the last `eventId`.

```ts
// inside sendMessage, after resolveTarget + read receipt
const maxChars = this.config.maxMessageChars ?? DEFAULT_MAX_CHUNK_CHARS;
const chunks = maxChars > 0
  ? splitMessage(text, { maxChunkChars: maxChars, maxTotalChars: DEFAULT_MAX_TOTAL_CHARS })
  : [text];
let eventId: string | undefined;
try {
  for (const chunk of chunks) {
    const rendered = this.markdownRenderer.render(chunk);
    const res = rendered.formattedBody
      ? await this.client.sendHtmlMessage(roomId, rendered.body, rendered.formattedBody)
      : await this.client.sendMessage(roomId, { body: rendered.body, msgtype: 'm.text' as never });
    eventId = res?.event_id;
  }
} finally {
  try { await this.client.sendTyping(roomId, false, 0); } catch { /* best-effort */ }
}
return eventId;
```
- Add `splitOutbound(text: string): string[]` to the class (same budget resolution, calls `splitMessage`).

### Step 4 — Adapter interface + engine injection [coder, parallel with Step 3 after Step 1]
- `drone-gateway/src/types.ts` — `DroneServiceAdapter` gains optional method (mirror the `handleBatch?`/`dispose?` idiom):
```ts
/** Split outbound text the way this adapter sends it. Absent = no splitting. */
splitOutbound?(text: string): string[];
```
- `drone-gateway/src/engine.ts` `injectMessage` (:367): replace the single call + single append with:
```ts
const chunks = adapter.splitOutbound?.(text) ?? [text];
for (const chunk of chunks) {
  const platformRef = await adapter.sendMessage(conversationId, chunk);
  adapter.outboundLedger?.append(conversationId, { platformRef, text: chunk });
}
```
Reply paths (:250, :283) stay untouched — they call `sendMessage` and ignore the return, so splitting benefits them with zero changes.

### Step 5 — Adapter + engine tests [tester, with Steps 3–4]
- EXTEND `test/matrix-adapter.test.ts` (mock client records sends): oversized message → multiple sends, every send under budget, `(n/m)` markers present, exactly one typing start/stop + one read receipt, return = last eventId; `maxMessageChars: 0` → single unsplit send; small budget (e.g. 50) → expected chunk sequence.
- EXTEND `test/engine.test.ts`: inject oversized text with a mock adapter implementing `splitOutbound` → one ledger row per chunk, per-chunk refs; adapter WITHOUT `splitOutbound` → single row (current behavior preserved).

### Step 6 — Docs [coder, after Steps 3–4]
- NEW `docs/adr/267-gateway-outbound-message-splitting.md`: the silent-drop failure mode (unhandled rejection via `void handleMessage`), adapter-level seam rationale, char-vs-byte decision (D7), defaults, split-point precedence, marker + truncation semantics, ledger per-chunk rows, mid-split failure semantics (D8).
- `drone-gateway/README.md`: add `"maxMessageChars": 20000, // optional; 0 disables splitting` to the Matrix adapter.json example + one line under the option list.

### Step 7 — Final validation [coder/reviewer]
Run and confirm the validation criteria below. Sweep: LSP diagnostics clean; build/lint/tests green; grep `sendMessage(` in `drone-gateway/src` to confirm no call site assumes a single unsplitted send.

## Validation criteria

1. `lsp__get_diagnostics` — zero errors/warnings across `drone-gateway/src` and new/changed test files.
2. `pnpm -r run build` — zero errors (no drone-core changes; gateway-only ripple).
3. `pnpm run lint` — zero errors (eslint + prettier; re-read files after prettier reformats before any further edit).
4. `pnpm run test` (fast suite) — all pass, including new `split-message.test.ts` and the extended matrix-adapter + engine tests.
5. Behavioral spot-checks encoded in tests: oversized reply → N sends each under budget with `(n/m)`; total over 100k → truncated final chunk with dropped-count marker; injection → one ledger row per chunk; `maxMessageChars: 0` → old single-send behavior.
6. Manual (deployment-side, NOT a gate): inject a >20k-char message into the operator DM on ambiorix; confirm multiple messages arrive with continuation markers.

## Non-goals

- No reactions work (separate future feature; shares the send path only).
- No byte-exact platform limit computation (char budget with headroom instead).
- No retry/resume of partially-sent split messages (D8: mid-split failure behaves like today's single-send failure).
- No changes to telegram/slack (not implemented).

## Execution summary (2026-11-02, code persona) — EXECUTED TO COMPLETION

Executed all steps on branch `fix/gateway-message-splitting`. All validation criteria 1–5 pass; criterion 6 (manual >20k live inject into the operator DM) remains deployment-side.

- NEW `drone-gateway/src/split-message.ts`: pure splitter (`DEFAULT_MAX_CHUNK_CHARS=20000`, `DEFAULT_MAX_TOTAL_CHARS=100000`). Greedy `\n\n` → `\n` → hard-cut packing with budget+1 scan and exactly one break char consumed per preferred split. Continuation ` (n/m)` marker width is reserved from the continuation budget and re-packed to the smallest self-consistent chunk count. Truncation marker `[message truncated — N characters were dropped]`; truncated tail is bounded by BOTH the ceiling remainder and `maxChunkChars`; the marker is emitted even when it alone exceeds the remaining ceiling; all-breaks-only chunks are skipped as noise.
- NEW `test/split-message.test.ts` (28 tests). EXTENDED `test/matrix-adapter.test.ts` (+7: chunk sequence/under-budget, paragraph split, one typing pair + one receipt, `maxMessageChars: 0` legacy path, mid-split failure propagates, `splitOutbound` parity) and `test/engine.test.ts` (+3: per-chunk sends + one ledger row per chunk, no-`splitOutbound` fallback, no ledger rows on mid-split failure).
- Matrix adapter: `maxMessageChars` config (0 disables), split BEFORE markdown render, one typing/receipt pair per `sendMessage` call, returns last eventId, new `splitOutbound()`. `types.ts`: optional `DroneServiceAdapter.splitOutbound?`. Engine `injectMessage`: per-chunk sends + per-chunk ledger rows; reply paths untouched.
- NEW `docs/adr/267-gateway-outbound-message-splitting.md`; README documents `maxMessageChars`.
- Deviations from plan text (both plan gaps, user decisions honored): (a) all-breaks-only chunks are skipped rather than sent; (b) the truncated tail is additionally bounded by `maxChunkChars` — with the 20k/100k defaults an unbounded tail could otherwise emit a ~40k-char final message, defeating the feature.
- Gates at completion: LSP clean, `pnpm -r run build` green, `pnpm run lint` green, fast suite 4566 passed / 345 files, `sendMessage` call-site sweep clean.

### Post-PR refinement (2026-11-02, user nit)

Splitter now never ends a message on a markdown ATX heading line (`#`–`######`, up to 3 leading spaces): break candidates that would end on a heading are rejected while a later break fits; the hard cut only runs when no valid break exists (mid-heading cut documented best-effort). Implemented as validity checks inside the packer scans (`endsWithHeadingLine` helper; line start searched backwards past chunk boundaries so hard-cut-split lines are judged whole). 4 new tests in `test/split-message.test.ts` (32 total); ADR 267 §3 + README amended. Opened PR #151 (base main) before this nit; push updates it.

### ADR renumber 267 → 268 (2026-11-02)

The user merged `origin/main` (commit `ca681faa`) which took ADR **267** for `267-malformed-tool-call-arguments-degenerate` — the plan brief's "ADR 267" was stale at execution time (same trap as swarm wiki `adr-numbering-verify-before-creating`). Renumbered per user instruction (ours is newer): file `docs/adr/268-gateway-outbound-message-splitting.md`, title now "ADR 268", README link → 268, and the missing `docs/adr/index.md` row added as 268. Plan/commit-history references to "ADR 267" in older text are historical record, left as-is.