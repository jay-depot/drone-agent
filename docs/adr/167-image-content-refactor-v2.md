---
tags: [decision, vision, images, tool-results, plugin-system, mcp]
related:
  [
    decisions/165-image-describer-role.md,
    concepts/vision-support.md,
    modules/drone-core.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
    modules/drone-agent-mcp-client.md,
    flows/tool-call-loop.md,
    decisions/050-mcp-client-session-id-iserror.md,
  ]
---

# 167: Image content refactor V2 — first-class images via structured tool results

**Status**: Implemented (2026-08-27, branch `feat/model-role-bindings`, commit `9ddbe31`)

## Context

Before V2, `file__read_image` returned `JSON.stringify({ path, mimeType, data(base64), size })` as a plain-string tool result. The base64 blob therefore lived **twice** in the stored tool message: as text inside `content` AND as the structured `images[].data`. Consequences:

- The blob was double-counted in token estimates (text in content + flat `256`/image).
- Every model — vision-capable or not — received the redundant base64 text on the wire, even when the image was also attached via `images[]`.
- A non-vision model next to a description (V1, [165-image-describer-role](165-image-describer-role.md)) still got megabytes of base64 it can't use.
- Images were derived from content via a **JSON-scan heuristic** (`extractImageFromToolResult`/`findDataUri`) that only recognized two shapes: the file-tool shape (`{mimeType, data}` top-level) and nested `data:image/...;base64,...` URIs. Raw MCP image content blocks (separate `data`/`mimeType` fields, MCP protocol standard) were **not** recognized — they landed as inert base64 text.

V1 (ADR 165) had loosened this with a per-tool image-extractor registry at the append seam (`file__read_image` got a structured extractor; the content heuristic became the default fallback for unregistered tools, MCP stayed on it) plus presentation-only base64 stripping on the wire. V2 resolves the underlying problem: **make the structured `images[]` channel the source of truth** so base64 stops riding in content at all.

## Decision

### 1. Structured tool-result type: `Promise<string | DroneToolResult>`

`DroneToolDefinition.execute` (and `DroneSlashCommandContext.engine.executeTool`) now return `Promise<string | DroneToolResult>` — a backward-compatible union. New type in drone-core `session-types.ts`:

```ts
type DroneToolResult = {
  /** Human-readable text for the LLM. Must NOT contain base64 image data. */
  content: string;
  /** Structured images carried out-of-band from the content string. */
  images?: DroneImageContent[];
};
```

The **string form stays a first-class, permanent "text-only" result** (no images). It is deliberately NOT deprecated:

- External/third-party plugins are out of our control; forcing them to adopt a structured return would break ecosystem compatibility.
- A string normalizes trivially at the seam.
- The union costs nothing at runtime — there is no benefit to a forced structured-only result.

A `toToolResultContent(result)` helper (drone-core `utils.ts`) normalizes string-or-structured → string.

### 2. Per-message image COUNT cap

Two-part cap model:

- **Per-image byte cap** `session.maxImageSizeBytes` (default 20MB) — unchanged, enforced in `file__read_image` (throws on over-limit).
- **New per-message image COUNT cap** `session.maxImagesPerMessage` (default **20**), enforced at the append/extraction seam (where `file__read_image` + MCP converge). `file__read_image` emits 1 image, so it's trivially unaffected.

A count cap was chosen over an aggregate byte/token budget because it's enforceable at the seam all producers share and bounds the worst case (an MCP server dumping a huge array). Over-cap behavior: **keep-first-N, drop the rest entirely** (no description retained), and append a marker to content telling the model how to retrieve the rest:

```
[N additional images omitted. Request a narrower/range selection to retrieve them.]
```

The cap is enforced **before** description generation, so over-cap images are never described (no wasted LLM calls). Accepted consequence: a non-vision target sees only the kept images (dropped images lose their description too).

### 3. `file__read_image` returns structured

```ts
return {
  content: JSON.stringify({ path, mimeType, size }, null, 2), // metadata, NO base64
  images: [{ mimeType, data }],
};
```

Content keeps structured metadata (path/mimeType/size) for logs and memory pipelines; the `data` field (base64) is dropped from content. The `file__read_image` extractor-registry entry is **deleted** (dead code — the tool returns structured images directly).

### 4. MCP image blocks become first-class

MCP tool `execute` returns a `DroneToolResult` via a new `splitToolResultBlocks(result)` helper in `client.ts` (parallel to `extractToolErrorText`):

- `text` content blocks → joined into `content`
- `{ type:'image', data, mimeType }` blocks → structured `DroneImageContent[]`
- Non-text/non-image blocks (e.g. `resource`) are **dropped** via this minimal, replaceable helper — a future `resource` lane can be added without touching callers.

`isError` handling stays in `callTool` (it already throws), so `execute` only returns successful results.

### 5. Delete the content-scan heuristic entirely

The following were deleted: `imageExtractors` map, `registerImageExtractor`, `extractImagesFromToolResult`, the `file__read_image` extractor registration, `extractImageFromToolResult`, and `findDataUri`. Images flow **only** via the structured `images[]` channel; string-returning tools are text-only by construction. Accepted: external/3rd-party tools returning data-URIs no longer yield images (the user is the sole user).

The seam stops "extracting images from content strings" and instead "carries images alongside content": `bufferedResults` items gain an `images?` field, `executeToolSafely` returns structured, and `appendToolResult`/`updateLastToolResultImages` are fed images directly. This is a simplification, not just a deletion.

### 6. TUI `FileReadImageBlock`

A small one-line `FileReadImageBlock` render component for `file__read_image`, registered via the existing `renderComponent` seam (the same pattern used by `file__read`/`file__list`/etc). It renders path/mimeType/size from the metadata content — no base64.

### 7. Token accounting

No code change needed: `estimateMessageTokens` already counts `images[]` at `max(256, desc)`. Removing base64 from content automatically resolved the V1-deferred double-count.

## Cross-cutting blast radius

The union return type broke every consumer that treated a tool result as a plain string: ~79 typecheck errors across ~17 test files plus 8 source consumers (`builtin-commands`, `index.tsx`, `search`, `skills`, `persona`). All were normalized via `toToolResultContent`. The cleanest DRY fix in test harnesses is to normalize at the capture point (wrap `tool.execute` in the test's `registerTool` handler to return a string), so individual call sites stay unchanged.

## Implementation notes

- `bufferedResults` items gained `images?: DroneImageContent[]`; the count cap is applied in the collection loop (keep-first-N + omission marker).
- The describe/append path now reads `result.images ?? []` directly instead of calling `extractImagesFromToolResult`.
- `file__read_image` kept its byte-cap throw; `renderComponent: state => FileReadImageBlock({ state })` was added.
- MCP tool `execute` changed from `JSON.stringify({ serverId, tool, result })` to `splitToolResultBlocks(result)`.
- The MCP `resource`-block future lane is recorded in project memory `mcp-resource-block-future-plan`.

## Validation

Full fast suite green (2357 passed, 9 skipped), `pnpm -r run build` + `pnpm typecheck` clean, `pnpm lint` clean, LSP clean in touched files. No `content` string for `file__read_image` or MCP image results contains base64 (base64 lives only in `images[].data`). No heuristic symbols remain. A >20-image result keeps first 20 + appends the omission marker; ≤20 unaffected. String-returning tools (e.g. `file__read`, `exec__run`) still work end-to-end.

## Related

- [165-image-describer-role](165-image-describer-role.md) — V1: the `image_describer` role + per-tool extractor registry that V2 supersedes the extraction-half of
- vision-support — image input handling across providers
- [drone-core](../../drone-core/) — `DroneToolResult`, `toToolResultContent`, `session.maxImagesPerMessage`
- [drone-agent](../../drone-agent/) — conversation-service seam changes
- [drone-agent-plugins](../../drone-agent/src/plugins/) — `file__read_image` + MCP structured results
- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — `splitToolResultBlocks` + image blocks
- tool-call-loop — the tool-result append/cap/describe flow
- [050-mcp-client-session-id-iserror](050-mcp-client-session-id-iserror.md) — MCP `callTool` throws on `isError`
