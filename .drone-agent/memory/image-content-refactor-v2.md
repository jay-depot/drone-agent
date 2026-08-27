---
key: image-content-refactor-v2
tags:
  - plan
  - refactor
  - vision
  - images
  - complete
created: 2026-08-26T22:21:59.226Z
updated: 2026-08-27T23:37:43.791Z
---

# COMPLETE: Image Content Refactor V2 — first-class images (structured tool results)

Picked up after `plan-image-describer` (V1) stabilized. This made images first-class and stopped stuffing base64 in the content string.

## What was done (commit 9ddbe31)
- `DroneToolDefinition.execute` and `engine.executeTool` now return `Promise<string | DroneToolResult>` (backward-compatible union; string = text-only result, kept permanently).
- New `DroneToolResult = { content: string; images?: DroneImageContent[] }` in drone-core; new `toToolResultContent()` helper normalizes string-or-structured → string.
- New `session.maxImagesPerMessage` (default 20) — per-message image COUNT cap, enforced at the append/extraction seam (covers file__read_image + MCP). Over-cap: keep-first-N, drop rest, append `[N additional images omitted. Request a narrower/range selection to retrieve them.]`.
- `file__read_image` returns structured: `content` = `JSON.stringify({path,mimeType,size})`, `images` = `[{mimeType,data}]`. Deleted its extractor-registry entry.
- MCP tool execute returns `DroneToolResult` via new `splitToolResultBlocks()` in client.ts: text blocks → content, `{type:'image'}` blocks → images[], non-text/non-image blocks dropped (replaceable helper, see `mcp-resource-block-future-plan`).
- Deleted the entire content-scan heuristic: `extractImageFromToolResult`, `findDataUri`, `registerImageExtractor`, `extractImagesFromToolResult`, `imageExtractors` map.
- New TUI `FileReadImageBlock` component for `file__read_image` (path/mimeType/size, no base64).
- Cross-cutting sweep: ~17 test files + 8 source consumers normalized via `toToolResultContent`.

## Validation
- `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass (2357 tests).
- No `content` string for file__read_image or MCP image results contains base64.
- No `extractImageFromToolResult`/`findDataUri`/`registerImageExtractor`/`extractImagesFromToolResult` symbols remain.

## Design notes / follow-ups
- The union return type was the biggest blast radius (79 typecheck errors across ~17 test files). Tests that call `tool.execute(...)` / `engine.executeTool(...)` directly and treat the result as a string now need `toToolResultContent(...)`.
- The seam now "carries images alongside content" instead of "extracts from content" — bufferedResults items gained an `images?` field; `executeToolSafely` returns structured.
- Token accounting needed no code change: `estimateMessageTokens` already counts `images[]` at `max(256, desc)`; removing base64 from content automatically resolved the double-count.
- Future: MCP `resource` content blocks dropped in V2; see `mcp-resource-block-future-plan` for the future lane.
