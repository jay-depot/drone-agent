---
tags: [decision, tool-loading, architecture, git, swarm, utils]
related:
  [
    modules/drone-agent-plugins.md,
    decisions/064-mcp-deferred-tool-loading.md,
    decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md,
  ]
---

# 068 — Tool Reduction Follow-up: Utils Consolidation, Git/Swarm List/Mount

**Date**: 2026-07-14

## Context

After the MCP plugin was converted to the deferred list/mount pattern ([064-mcp-deferred-tool-loading](064-mcp-deferred-tool-loading.md)), the session still exposed ~89 tools to the LLM. The git plugin (11 tools) and swarm plugin (13 tools) were eagerly registered, and the utils plugin had 7 separate tools. This consumed significant context window space and made tool selection harder for the LLM.

The `ToolMountingCache` class ([065-mcp-tool-mounting-cache-and-server-descriptions](065-mcp-tool-mounting-cache-and-server-descriptions.md)) was already available in `drone-core` and proven by the MCP plugin. The persona filtering pattern for `__list_tools` was also established.

## Decision

Three changes were made:

### 1. Utils Consolidation (7→2 tools)

The 7 individual utility tools (`evaluate_arithmetic`, `count_words`, `count_letters`, `count_characters`, `count_lines`, `count_unique_words`, `count_sentences_paragraphs`, `spell`) were merged into 2 consolidated tools:

- **`calculator`** — arithmetic expression evaluation (replaces `evaluate_arithmetic`)
- **`string`** — text analysis with an `operation` enum supporting all 7 string operations

This is **not** a list/mount pattern — 2 tools is small enough to always mount. The existing helper functions (`tokenizeWords`, `extractLetters`, `countNonWhitespaceCharacters`, `countLines`, `countSentences`, `countParagraphs`, `evaluateArithmeticExpression`) remain unchanged.

### 2. Git Plugin → List/Mount (11→3 meta-tools)

The git plugin was converted from 11 eagerly-registered tools to 3 meta-tools backed by `ToolMountingCache`:

- **`git__list_tools`** — Returns all 11 tool names and descriptions (no schemas). Hardcoded description (no LLM call needed). Filtered through persona capability when available.
- **`git__mount_tool`** — Dynamically registers a specific git tool with its full JSON schema as a native tool definition.
- **`git__unmount_tool`** — Removes a previously mounted git tool.

Added `persona` as an optional dependency for persona filtering on `__list_tools`.

### 3. Swarm Plugin → List/Mount (13→3 meta-tools)

The swarm plugin was converted from 13 eagerly-registered tools to 3 meta-tools backed by `ToolMountingCache`:

- **`swarm__list_tools`** — Returns all 13 tool names and descriptions. Hardcoded description. Filtered through persona capability.
- **`swarm__mount_tool`** — Dynamically registers a specific swarm tool.
- **`swarm__unmount_tool`** — Removes a previously mounted swarm tool.

**`defaultHidden` removed** from `wiki_write` and `wiki_delete` — the persona filter on `__list_tools` handles visibility before mounting. After mounting, the persona filter in `getLlmTools()` controls native tool visibility. `defaultHidden` on cached-but-unmounted tools is meaningless.

## Design Decisions

1. **Utils uses simple consolidation**, not list/mount — 2 tools is small enough to always mount.
2. **Git and swarm use list/mount with `ToolMountingCache`** — consistent with the MCP pattern.
3. **None pre-mounted** — the LLM discovers and mounts what it needs. Roadmap item to revisit after seeing it live.
4. **Hardcoded `__list_tools` descriptions** — plugin authors know what their tools do; no LLM call needed.
5. **`__list_tools` filtered through persona capability** — only show tools the persona would allow.
6. **`__list_tools` always includes descriptions by convention** — flat list of name + description.
7. **Drop `defaultHidden` from cached tools** — the persona filter on `__list_tools` handles visibility before mounting.

## Impact

- **Native tool surface reduced by ~18 tools**: 7 utils → 2, 11 git → 3, 13 swarm → 3 = 8 tools vs 31 today.
- **Consistent pattern**: MCP, git, and swarm all use the same list/mount pattern with `ToolMountingCache`.
- **Persona filtering works uniformly**: `__list_tools` for all three plugins filters through the active persona's `allowedTools` patterns.
- **All 1437 tests pass**, build and lint clean.

## Related

- [064-mcp-deferred-tool-loading](064-mcp-deferred-tool-loading.md) — Original MCP list/mount pattern
- [065-mcp-tool-mounting-cache-and-server-descriptions](065-mcp-tool-mounting-cache-and-server-descriptions.md) — ToolMountingCache class
- [drone-agent-plugins](../../drone-agent/src/plugins/) — Updated plugin descriptions
