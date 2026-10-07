---
tags: [decision, mcp]
related: [modules/drone-agent-mcp-client.md, decisions/064-mcp-deferred-tool-loading.md, decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md]
---

# MCP `listTools` Walks All Pages (Gap Item 9)

**Summary**: `connection.listTools()` used `paginateList` which capped at `maxListPages` and `maxListItems`, causing the `ToolMountingCache` to only contain a subset of the server's tools. The `mcp__<server>__list_tools` meta-tool therefore only showed that subset to the LLM, making the remaining tools invisible and unmountable. The fix adds a `walkAllPages` function that fetches all pages and uses it for `listTools`.

## Problem

The MCP client's `listTools()` method used `paginateList` (the same helper used by `listResources`, `listPrompts`, and `listResourceTemplates`), which is bounded by two configurable limits:

- `maxListPages` (default: 25) — maximum number of pages to fetch
- `maxListItems` (default: 500) — maximum number of items to return

When a server had more tools than the pagination limits allowed, the returned list was truncated. This truncated list was then used to populate the `ToolMountingCache`, meaning:

1. `mcp__<server>__list_tools` only showed the truncated subset to the LLM
2. Tools beyond the pagination limit were invisible and could never be mounted
3. `discoveredToolCount` reported a misleadingly low number
4. `toolsListTruncated` was `true`, but no mechanism existed to fetch the remainder

This defeated the purpose of the deferred list/mount pattern — the whole point was to let the LLM discover all available tools and mount them on demand, but pagination limits were silently hiding tools.

## Changes

### `client.ts` — New `walkAllPages` function

Added a new function alongside `paginateList` that walks all pages without the `maxListPages`/`maxListItems` caps:

```typescript
async function walkAllPages<T>(
  method: string,
  normalize: (result: unknown) => T[]
): Promise<ListResult<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  while (true) {
    const params = cursor ? { cursor } : {};
    const result = await requestWithRetry<unknown>(method, params, true);
    const pageItems = normalize(result);
    items.push(...pageItems);

    const nextCursor = parseNextCursor(result);
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) break; // infinite-loop protection
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { items, truncated: false };
}
```

The only safety mechanism is infinite-loop protection via cursor deduplication — if the same cursor is returned twice, the loop stops. This is the same protection that `paginateList` already had.

### `client.ts` — `listTools` now uses `walkAllPages`

Changed the `listTools` method in the returned connection object to call `walkAllPages` instead of `paginateList`:

```typescript
listTools: async () => {
  const toolsResult = await walkAllPages('tools/list', normalizeTools);
  state.toolsListTruncated = false;
  state.discoveredToolCount = toolsResult.items.length;
  return toolsResult.items;
},
```

- `discoveredToolCount` now reflects the true total number of tools on the server
- `toolsListTruncated` is always `false` for tools (since all pages were walked)

### Test updates

Three tests in `mcp-client.test.ts` were updated:

- **"stops paginating once maxListPages is exhausted and flags truncation"** → **"walks all pages for tools/list (no maxListPages cap)"** — expects all 3 tools to be returned (pageSize 1, 3 pages walked), `toolsListTruncated` to be `false`
- **"sets discoveredToolCount to the (possibly truncated) returned count"** → **"sets discoveredToolCount to the full server tool count"** — expects `discoveredToolCount` to be 3 (the full server total)
- **"caps list at maxListItems and sets toolsListTruncated"** → moved to test `listResources` instead (which still uses `paginateList`), renamed to **"caps list at maxListItems and sets toolsListTruncated (resources)"**

## Design Decisions

- **`walkAllPages` is separate from `paginateList`**: Keeping them separate means the pagination limits are still available for `listResources`, `listPrompts`, and `listResourceTemplates`, where truncation is acceptable (resource counts are typically bounded, and the `truncated` flag signals incompleteness).
- **Infinite-loop protection only**: The only guard against runaway pagination is cursor deduplication. This is sufficient because:
  - MCP servers are expected to terminate pagination by returning no `nextCursor`
  - A server that returns the same cursor twice is buggy, and the loop stops
  - A truly malicious server could cause unbounded fetches, but this is a DoS vector that exists in the MCP spec itself (the client must trust the server)
- **No `maxListPages`/`maxListItems` for tools**: The deferred list/mount pattern depends on the LLM seeing all available tools. Truncating the tool list defeats the pattern.

## Files Changed

- `drone-agent/src/plugins/mcp/client.ts` — Added `walkAllPages`, changed `listTools` to use it
- `drone-agent/test/mcp-client.test.ts` — Updated 3 tests

## Validation

- 39/39 MCP client tests pass (all existing tests updated to reflect new behavior)
- `pnpm -r run build` passes
- `pnpm lint` passes
- LSP diagnostics: clean (only pre-existing unused-variable hints)