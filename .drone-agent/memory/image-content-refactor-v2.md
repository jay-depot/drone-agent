---
key: image-content-refactor-v2
tags:
  - plan
  - refactor
  - vision
  - images
created: 2026-08-26T22:21:59.226Z
updated: 2026-08-26T22:21:59.226Z
---

# ORIENTATION: Image Content Refactor — V2 (follow-up plan)

Picked up after `plan-image-describer` (V1) stabilizes. This is the "make images first-class, stop stuffing base64 in the content string" refactor. Use this as the starting orientation for planning V2.

## Motivation / the problem

`file__read_image` returns `JSON.stringify({ path, mimeType, data(base64), size })` as a plain-string tool result. The base64 blob therefore lives TWICE in the stored tool message: as text inside `content` AND as the structured `images[].data`. Consequences today:

- The blob is double-counted in token estimates (text in content + flat 256/image).
- Every model — vision-capable or not — receives the redundant base64 text on the wire, even when the image is also attached via `images[]`.
- A non-vision model next to a description (V1) still gets megabytes of base64 it can't use.
- Images are derived from content via a JSON-scan heuristic (`extractImageFromToolResult`, conversation-service.ts:1121-1160) that only recognizes TWO shapes: the file-tool shape (`{mimeType, data}` top-level) and nested `data:image/...;base64,...` URIs (`findDataUri`). Raw MCP image content blocks (separate `data`/`mimeType` fields, MCP protocol standard) are NOT recognized — they land as inert base64 text.

## V1's loosening (this is the prerequisite)

- Per-tool image-extractor registry at the append/extraction seam: `file__read_image` gets a STRUCTURED extractor producing `DroneImageContent[]` directly (knows its own return shape). The content heuristic becomes the default fallback for unregistered tools (MCP stays on it).
- Presentation-only base64 stripping on the wire, BOTH vision and non-vision targets (image carried via `images[]`). Storage/persistence/token-estimation unchanged.

## V2 scope (not yet planned)

1. `file__read_image` STOPS putting the base64 blob in `content` — return a marker + structured image (images[] becomes the source of truth). Requires a structured image channel on tool results (today tool execute returns `Promise<string>`; there is NO structured result type — plugin-system.ts:34-39).
2. MCP image blocks become first-class structured images (stop relying on the data-URI content scan; the raw `{type:'image', data, mimeType}` blocks at mcp/index.ts:311-315 are already serialized verbatim into the JSON string, so the data is present — it just needs a structured extractor).
3. Delete the now-unused content-scan heuristic (`extractImageFromToolResult`/`findDataUri`), or reduce it to a narrow fallback.
4. Fix token accounting deliberately left alone by V1 (Q5): the base64-in-content double-count. Now that content no longer carries the blob, estimation should count `images[]` (flat 256/image, or the V1 `max(256, description)` rule) without the redundant content-text charge.

## Key files/symbols to study first

- `drone-agent/src/plugins/file.ts:514-572` — file\_\_read_image execute, JSON return shape.
- `drone-agent/src/runtime/conversation-service.ts:405-423` (executeToolSafely), :563-698 (executeToolCalls + truncate + append), :1121-1160 (`extractImageFromToolResult` + `findDataUri`).
- `drone-agent/src/plugins/mcp/index.ts:311-315` (raw MCP callTool JSON.stringify) and mcp/client.ts:77-86 (`extractToolErrorText` reads only .text).
- `drone-core/src/plugin-system.ts:34-39` (`DroneToolDefinition.execute` returns `Promise<string>` — no structured result).
- `drone-core/src/session-types.ts:42-57` (`DroneImageContent`, `DroneChatMessage.images`).
- `drone-core/src/token-estimate.ts:15-33` (`estimateMessageTokens`).

## Cross-cutting notes

- The append/extraction seam is hot + concurrency-sensitive (runs every tool batch under Promise.all) — needs parallel-safety discipline and a full tool-loop test pass, same as V1.
- V1 Q5 chose per-image budget = `max(256, estimateTextTokens(description))` and explicitly deferred the base64 double-count; V2 is where that deferral resolves.
- Watch for anything downstream that greps/parses tool content for base64 beyond extraction (TUI preview currently shows the raw JSON string with the blob; after V2 it'd show a marker).
