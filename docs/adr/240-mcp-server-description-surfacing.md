---
tags: [decision, mcp, prompt-fragments, server-descriptions, tool-loading, adr]
related:
  [
    modules/drone-agent-mcp-client.md,
    decisions/065-mcp-tool-mounting-cache-and-server-descriptions.md,
    decisions/100-list-mount-improvements.md,
    decisions/105-runtime-level-list-mount.md,
    decisions/207-merged-footer-fragments-single-message.md,
  ]
---

# ADR 240: MCP server-description surfacing

**Status**: Implemented (2026-10-08, branch `fix/mcp-descriptions-restore`)

## Context

ADR 065 introduced LLM-generated MCP server descriptions, cached at
`~/.drone-agent/cache/mcp/server-descriptions.json`. Their designed home was the
description of the **per-server `__list_tools` meta-tool**: the LLM browsed a
server's tools by calling that meta-tool, so the summary sat exactly where the
mounting decision was made.

ADR 105 deleted the per-server meta-tools in favour of the engine-owned
`runtime__list_tools`. That removal took the description's only consumer with
it, but left the generator running: `listAndMountTools` still called
`getOrCreateServerDescription(...)` and **discarded the return value**. Nothing
read the cache. For roughly two months each MCP server connect paid for an LLM
call and wrote a cache entry that no code consumed.

Nothing could catch this mechanically: an awaited call whose value is dropped is
perfectly well-typed, the module had no tests, and the only reader of the cache
(`readCachedDescription`) was private to the generator module.

## Decision

Surface the description again, as prompt fragments rather than a tool
description.

### D1 — Two fragments, split by volatility

- **`# MCP Servers`** (`phase: 'header'`) — every configured server, its
  description when known, and its **available** tool count, plus a reminder
  blurb.
- **`# MCP Servers (not connected)`** (`phase: 'footer'`) — only servers whose
  status is not `connected`, with status and `lastError`.

The split follows [207](207-merged-footer-fragments-single-message.md)'s
phase model: header fragments form the stable, cached prompt prefix, while
footer fragments are re-rendered per turn. Server descriptions and the server
roster are stable; connection status is volatile. Putting status in the header
would invalidate the cached prefix on every reconnect.

### D2 — The reminder blurb carries the discoverability the old home had for free

While the summary lived inside `__list_tools`, it could not be read without also
learning how to browse and mount tools. A fragment has no such coupling, so the
header explicitly instructs the model to call `runtime__list_tools` with
`{"plugin":"mcp"}`, and to list again if an expected tool is missing (the list
may be stale, or the tool named differently). This matters most for a server
that failed to connect — exactly the case the footer reports.

### D3 — Tool counts are _available_ counts, computed at render

The count is produced by passing the server's tool descriptors through the
persona capability's `getFilteredTools` at render time, so it equals what the
LLM actually sees in `runtime__list_tools`. With no persona capability the count
falls back to all tools minus `defaultHidden`, mirroring the engine's own
fallback. No new state field was added.

Two implementation traps this decision forced:

- **Two name spaces.** `serverToolMaps` stores definitions named
  `<serverId>__<tool>`, while persona filtering matches **canonical** names
  (`mcp__<serverId>__<tool>`). The collector uses `getCanonicalToolName` rather
  than concatenating a prefix.
- **Lazy capability resolution.** `registration.request('persona')` must be
  called inside the render path, not at register time: `mcp` registers before
  `persona`'s capability is offered, so an early request would resolve to
  `undefined` and silently disable filtering forever.

Rejected alternative: add `description?: string` to `DroneMcpServerState` and
let `server_status` carry it. `server_status` is an **unmounted** tool the LLM
must mount first, so it cannot restore the "context available before the first
browse" affordance. It would have been a secondary surface, not a replacement.

### D4 — Tuned summarizer prompt

The original prompt asked for "no more than 3 sentences", because the text was a
paragraph inside a tool description. In its new home it is a bullet beside a
server id, so the prompt now asks for **one short sentence, ≤20 words, led by
the server's purpose, with no preamble, markdown, or lists**.

### D5 — `promptVersion` cache-bust (amends ADR 065's "cache is never

invalidated")

ADR 065 stated the cache is never invalidated automatically. That is
incompatible with D4: the disk cache is keyed by server id alone, so a prompt
change would leave every existing entry in the old shape forever.

Each cache entry now carries a `promptVersion`; an entry whose version does not
match the current constant is treated as a **miss** and regenerated on the
server's next connect. Existing entries stay on disk and are rewritten in place
— no migration step, no manual cache delete.

Also folded in: the cache write is now serialized with the shared `withPathLock`
and written via temp file + rename, so concurrent connects cannot lose an
update.

The heavier invalidation options from roadmap 5.7 — **tool-list-hash comparison**
and **TTL regeneration** — remain deferred.

### D6 — Description map is seeded once, renders do no IO

The generator's return value is captured into an in-memory `serverDescriptions`
map at connect. The map is additionally seeded from the cache once in the
`onPluginsLoaded` hook, so a server that **fails** to connect still shows prose
(its connect-path generation never runs). Fragment renders read only this map,
so they perform no disk IO.

## Consequences

- The description generator has a consumer again; the per-connect LLM call is
  now paid for something the LLM reads.
- The LLM sees which servers exist, what they do, and how many tools it can
  mount, before it browses — and non-connected servers announce themselves.
- The `promptVersion` constant is now a maintenance obligation: changing the
  summarizer prompt requires bumping it, or the change reaches only servers that
  have no cached entry.
- **Discovered defect, out of scope:** the per-server `allowedTools` field in
  `mcp.servers.<id>` is not enforced. `listAndMountTools` reads it into a
  `serverAllowlists` set that no code consults, so an allowlisted-out tool
  remains visible and mountable, and `filteredToolCount` overstates filtering.
  Enforcement (documented in ADR 065 as `__mount_tool`'s job) was lost in ADR
  105 along with the meta-tools. `filteredToolCount` was therefore **not** used
  as the available count in D3. Tracked as
  `followup-mcp-server-allowlist-unenforced`.
- `docs/agents/mcp-plugin.md` was rewritten: it still documented
  `ToolMountingCache` (deleted file) and the per-server meta-tools.

## Files

| File                                                | Change                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `drone-agent/src/plugins/mcp/prompt-fragments.ts`   | New — pure `renderServerSection` / `renderStatusSection`                                               |
| `drone-agent/src/plugins/mcp/server-description.ts` | `PROMPT_VERSION`, tuned prompt, lazy paths, locked atomic write, `readCachedDescriptions`              |
| `drone-agent/src/plugins/mcp/index.ts`              | Capture the description, `serverDescriptions` map, `collectServerSummaries`, two fragments, cache seed |
| `drone-agent/test/mcp-prompt-fragments.test.ts`     | New — renderer unit tests                                                                              |
| `drone-agent/test/mcp-server-description.test.ts`   | New — prompt/cache/cache-bust unit tests                                                               |
| `drone-agent/test/mcp.test.ts`                      | Fragment integration tests + `os.homedir` isolation                                                    |
| `docs/agents/mcp-plugin.md`                         | Full accuracy pass                                                                                     |
| `AGENTS.md`                                         | Plugin index line de-staled                                                                            |
