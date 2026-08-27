---
key: image-content-refactor-v2-plan
tags:
  - plan
  - refactor
  - vision
  - images
created: 2026-08-27T22:20:20.502Z
updated: 2026-08-27T22:20:20.502Z
---

# PLAN: Image Content Refactor V2 — first-class images (structured tool results)

## Feature summary
Today `file__read_image` returns `JSON.stringify({path, mimeType, data(base64), size})` as a plain-string tool result — the base64 blob lives TWICE (in `content` AND `images[]`), is double-counted in token estimates, and is sent on the wire to every model even when redundant. MCP raw `{type:'image'}` content blocks are NOT recognized by the content-scan heuristic, so they land as inert base64 text. V2 makes images first-class: tool results gain a structured channel, `images[]` becomes the source of truth, base64 stops riding in `content`, MCP image blocks become structured, the content-scan heuristic is deleted, and a per-message image-count cap bounds the flow.

## Decisions (confirmed)
1. `DroneToolDefinition.execute` returns `Promise<string | DroneToolResult>` (union, backward compatible). String = first-class "text-only" result (no images), kept PERMANENTLY (external/3rd-party plugins out of our control; string normalizes trivially at seam; no forced structured-only).
2. `DroneToolResult = { content: string; images?: DroneImageContent[] }` (new type in drone-core session-types).
3. Image caps:
   - Per-image byte cap `session.maxImageSizeBytes` (20MB) — UNCHANGED, enforced in file__read_image (throws).
   - NEW per-message image COUNT cap `session.maxImagesPerMessage` (default 20), enforced at the append/extraction seam (covers file__read_image + MCP convergence). file__read_image emits 1 image, trivially unaffected.
   - Over-cap: keep-first-N, DROP the rest entirely (no description retained). Append marker to content: `[N additional images omitted. Request a narrower/range selection to retrieve them.]`. Non-vision targets lose dropped images' descriptions too — accepted.
4. `file__read_image` result shape: `content` = `JSON.stringify({path, mimeType, size}, null, 2)` (structured metadata for logs/memory pipelines; `data` DROPPED); `images` = `[{mimeType, data}]`. Delete its extractor-registry entry (dead code).
5. MCP tool `execute` returns `DroneToolResult`: `content` = joined text blocks (mirrors `extractToolErrorText`), `images` = mapped `{type:'image', data, mimeType}` blocks. `isError` stays in `callTool` (throws), so execute only returns successes. Extraction in a NEW helper in client.ts (parallel to `extractToolErrorText`), called from index.ts. Non-text/non-image blocks DROPPED via a minimal, replaceable helper (future `resource` lane noted in memory `mcp-resource-block-future-plan`).
6. DELETE the content-scan heuristic entirely: `extractImageFromToolResult`, `findDataUri`, `registerImageExtractor`, `extractImagesFromToolResult`, `imageExtractors` map, and the file__read_image extractor registration. Images flow ONLY via structured `images[]`; string-returning tools are text-only by construction. The seam becomes "carry images alongside content" (bufferedResults items gain `images?`; `executeToolSafely` returns structured), not "extract from content".
7. TUI: add a small one-line `FileReadImageBlock` render component for file__read_image (existing `renderComponent` seam, pattern used by file__read/list/write/applyDiff/glob), rendering path/mimeType/size from the metadata content — no base64.
8. Token accounting: NO code change needed — `estimateMessageTokens` already counts `images[]` at `max(256, desc)`; removing base64 from content automatically resolves the double-count. Verify tests still pass.

## Files to touch
- `drone-core/src/session-types.ts` — add `DroneToolResult` type.
- `drone-core/src/plugin-system.ts` — `DroneToolDefinition.execute` and `DroneSlashCommandContext.engine.executeTool` return `Promise<string | DroneToolResult>`.
- `drone-core/src/config-types.ts` — add `maxImagesPerMessage?: number` to `DroneSessionConfig` (near maxImageSizeBytes) + default 20.
- `drone-core/src/index.ts` — export `DroneToolResult` (+ optional helper `toToolResultContent`).
- `drone-agent/src/runtime/conversation-service.ts` — normalize structured at seam, carry images in bufferedResults, apply count cap, delete heuristic.
- `drone-agent/src/runtime/plugin-engine.ts` — `executeTool` passthrough return type (type flows from tool.execute; no logic change).
- `drone-agent/src/plugins/file.ts` — read_image returns structured; register renderComponent.
- `drone-agent/src/plugins/mcp/client.ts` — add block-splitting helper.
- `drone-agent/src/plugins/mcp/index.ts` — MCP tool execute returns structured.
- `drone-agent/src/tui/components/FileReadImageBlock.tsx` — NEW small component.
- Cross-cutting `executeTool` consumers treating result as string (union breaks typecheck): `builtin-commands.ts:249,273`, `interactive.ts:370`, `index.tsx:508`, `plugins/search/index.ts:122`, `plugins/skills/index.ts:276,288,301`, `plugins/persona/index.ts:533,539,553`. Use a `toToolResultContent` helper to extract `.content` (string→as-is, structured→`.content`).
- Tests: `test/helpers.ts` (MockEngineOptions.executeToolImpl → union), `test/conversation-service-image-describer.test.ts` (executeToolImpl returns structured, not JSON string), `test/vision.test.ts` (DELETE the `extractImageFromToolResult` describe block), `test/search.test.ts:340` (executeTool type → union), `test/file.test.ts` (read_image structured result), `test/mcp*.test.ts` (block split + structured execute), `test/*.tsx` (FileReadImageBlock render).

## Implementation steps (order matters)
1. **drone-core types**: add `DroneToolResult` to session-types.ts; update `DroneToolDefinition.execute` + `DroneSlashCommandContext.engine.executeTool` to union; export from index.ts; add `maxImagesPerMessage` to DroneSessionConfig + defaults. Run `pnpm -r run build` in drone-core first (dependent packages resolve from dist/).
2. **conversation-service seam** (conversation-service.ts):
   - `executeToolSafely`: normalize `engine.executeTool` union → `{kind:'ok', content, images?}` / `{kind:'error',...}`. content = `toToolResultContent(result)`; images = structured `.images` (undefined for string).
   - `bufferedResults` items gain `images?: DroneImageContent[]`.
   - Apply count cap: keep-first-N of `result.images`, append over-cap marker to `content` when images dropped. Apply BEFORE describe (don't describe dropped images).
   - Describe work uses `result.images ?? []` (not `extractImagesFromToolResult`).
   - Append: `sessionManager.appendToolResult(name, content, toolCallId, images)` (4th arg already exists); non-inline providers keep the separate `[Image from ...]` user message path, fed from `result.images`.
   - DELETE: `imageExtractors` map, `registerImageExtractor`, `extractImagesFromToolResult`, the file__read_image extractor registration, `extractImageFromToolResult`, `findDataUri`.
3. **file.ts read_image**: return `{ content: JSON.stringify({path, mimeType, size}, null, 2), images: [{mimeType, data}] }`; add `renderComponent: state => FileReadImageBlock({ state })`; keep byte-cap throw.
4. **MCP**: add `splitToolResultBlocks(result): {content, images}` helper in client.ts (text→content, image→images, others ignored); index.ts tool execute returns `{...splitToolResultBlocks(result)}`.
5. **TUI FileReadImageBlock**: new component parsing path/mimeType/size from `state.result` JSON, one-line render.
6. **Cross-cutting consumer sweep**: update the 8 executeTool consumers to use `toToolResultContent` (they only need text; `logger.info`/`JSON.parse` require string).
7. **Tests**: update mocks (helpers.ts, image-describer, search), delete heuristic test block, add new tests (file read_image structured, mcp block split + structured execute, count-cap over-limit marker, FileReadImageBlock render, union normalization).
8. **Validation**: `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. Update `LOCAL.md`/AGENTS.md only if a stated behavior changed (verify `maxImageSizeBytes` doc note still accurate).

## Validation criteria
- LSP: zero errors across the workspace (typescript LSP connected).
- `pnpm -r run build` and `pnpm typecheck` pass with zero errors (build drone-core FIRST; dependent packages resolve from dist/).
- `pnpm lint` passes (eslint + prettier) with zero errors.
- `pnpm test` (fast suite) passes.
- No `content` string for file__read_image or MCP image results contains base64; base64 lives only in `images[].data`.
- No `extractImageFromToolResult`/`findDataUri`/`registerImageExtractor`/`extractImagesFromToolResult` symbols remain.
- A tool result with >20 images keeps first 20 + appends the omission marker; <20 unaffected.
- String-returning tools (e.g. file__read, exec__run) still work end-to-end (union normalization).
