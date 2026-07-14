---
key: mcp-item13-tool-name-collisions
tags:
  - mcp
  - item13
  - plan
created: 2026-07-14T04:11:17.047Z
updated: 2026-07-14T04:11:17.047Z
---

# Plan: Tool-Name Sanitization Collisions (Item 13)

## Summary

`sanitizeToolSegment` replaces any non-alphanumeric/non-underscore/non-hyphen character with `_`. This means `foo bar` and `foo-bar` both become `foo_bar`. When the second tool is added to the `ToolMountingCache`, it silently overwrites the first (via `Map.set`), and if the first was already mounted, the engine's `registerTool` throws "already registered". The fix: detect collisions and append a disambiguation suffix.

## Steps

### Step 1: Add collision detection to `sanitizeToolSegment` in `index.ts`

Change `sanitizeToolSegment` to accept a set of already-used names and append a numeric suffix on collision:

```typescript
function sanitizeToolSegment(
  name: string,
  usedNames: Set<string>
): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }
  // Collision — append a suffix until unique
  let counter = 1;
  while (usedNames.has(`${sanitized}_${counter}`)) {
    counter++;
  }
  const result = `${sanitized}_${counter}`;
  usedNames.add(result);
  return result;
}
```

### Step 2: Thread `usedNames` through the call sites

Each server's `listAndMountTools` and `handleToolsListChanged` need a per-server `usedNames` set. The set should be scoped to the server (not global), since collisions only matter within the same server's tool namespace.

In `listAndMountTools`, create a `usedNames` set before the loop and pass it to `sanitizeToolSegment`:

```typescript
const usedNames = new Set<string>();
for (const tool of tools) {
  const mountedName = `${serverId}__${sanitizeToolSegment(tool.name, usedNames)}`;
  // ...
}
```

Same pattern in `handleToolsListChanged`.

### Step 3: Add a test

In `mcp-client.test.ts` or `mcp.test.ts`:
- Add a test that configures a server with tools `"foo bar"` and `"foo-bar"` and verifies both are mountable with distinct names (e.g., `foo_bar` and `foo_bar_1`)

### Step 4: Verify build, lint, and tests pass

## Design Decisions

- **Per-server scope**: The `usedNames` set is scoped to each server's tool list, not global. This is correct because the canonical name includes the server ID (e.g., `mcp__serverA__foo_bar` vs `mcp__serverB__foo_bar`), so collisions only matter within the same server.
- **Numeric suffix**: `_1`, `_2`, etc. is simple and predictable. The LLM can easily understand `foo_bar_1` as a disambiguated version of `foo-bar`.
- **No warning needed**: The collision is handled silently — the LLM gets both tools with distinct names. No need to log a warning for something that's handled correctly.

## Validation Criteria

- [ ] `sanitizeToolSegment` accepts a `usedNames` set and appends a suffix on collision
- [ ] `listAndMountTools` and `handleToolsListChanged` use per-server `usedNames` sets
- [ ] Tools with colliding sanitized names are both mountable with distinct names
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes