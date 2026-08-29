---
key: mcp-resource-block-future-plan
tags:
  - plan
  - mcp
  - vision
  - future-work
created: 2026-08-27T22:12:35.866Z
updated: 2026-08-27T22:12:35.866Z
---

# MCP `resource` content blocks — future handling note

During planning of `image-content-refactor-v2`, we decided V2 will DROP MCP non-text/non-image content blocks (e.g. `{type:'resource', resource:{uri,mimeType,text?|blob?}}`) in the structured result helper. We deliberately kept the helper minimal so it can be replaced when ready to handle them.

## How to use resource blocks effectively (future plan, NOT in V2)

An MCP `resource` block is a _reference_, not a payload — it may embed data (`text`/`blob`) or be a bare URI pointer.

- **Embedded data** → dereference into the same structured lanes we built for images: `text` → content, `blob` → images. Falls out almost for free once the image/text helper exists.
- **Bare URI** → do NOT inline blindly (could be huge / loop). Idiomatic patterns:
  1. **Lazy fetch via `resources/read`** — surface `[Resource: <uri> (mimeType)]` as a handle in content; give the model a `resources__read`-style tool (client.ts already exposes `readResource` at :66). Mirrors `__mount_tool` wrapping `tools/list`.
  2. **Auto-dereference with depth limit** — follow URI, substitute result, cap depth to prevent runaway chains (common MCP host default).

## Design recommendation

Add a first-class `resource` field on `DroneToolResult` (analogous to `images`), carrying `{uri, mimeType}` handles the agent can pass through as text or lazily fetch. This gives a third lane ("structured reference the model can act on") alongside the base64-vs-text split built for images.

## V2 constraint

V2's MCP helper should map image/text blocks and IGNORE others (not hard-reject the whole result), keeping the parser easy to extend with a `resource` lane later.
