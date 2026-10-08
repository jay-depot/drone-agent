---
key: plan-mcp-server-description-surfacing
tags:
  []
created: 2026-10-08T21:01:19.622Z
updated: 2026-10-08T21:01:19.622Z
---

# Plan: Restore MCP Server-Description Consumption

**Branch:** `fix/mcp-descriptions-restore` · **Status:** ready for execution · **Date:** 2026-10-08

## Summary

`getOrCreateServerDescription()` still runs on every MCP server connect and still writes `~/.drone-agent/cache/mcp/server-descriptions.json` — but its **return value is discarded**. ADR 105 (commit `ee85329`, 2026-08-03) deleted the per-server `__list_tools` meta-tools that used to carry the summary, leaving the generator with no consumer. Result: a paid LLM call per server whose output nobody reads. This plan restores the consumer by surfacing descriptions as prompt fragments, tunes the summarizer prompt to suit its new bullet-shaped home, and adds a `promptVersion` cache-bust so the tuned prompt takes effect on existing cache entries.

## Background (verified against the code)

| Fact | Location |
| --- | --- |
| Generator + cache only; returns `Promise<string \| undefined>` | `drone-agent/src/plugins/mcp/server-description.ts` |
| Called once; **return value discarded** | `drone-agent/src/plugins/mcp/index.ts:288` (in `listAndMountTools`) |
| ADR 105 replaced per-server meta-tools with engine-owned `runtime__list_tools` | `drone-agent/src/runtime/plugin-engine.ts:843` |
| `drone-core/src/tool-mounting-cache.ts` no longer exists | glob confirms absent |
| `server_status` returns `DroneMcpServerState` — no description field | `drone-core/src/mcp-types.ts` |
| mcp plugin registers **no** prompt fragments today | `index.ts` (581 lines) |
| Header fragments = stable prefix; footer fragments merged + wrapped in `<system-reminder>` | `context-budget-service.ts:189` |
| LSP precedent: `# LSP Servers` header fragment | `plugins/lsp/plugin.ts:58` |
| `serverToolMaps` already holds per-server tool defs | `index.ts:162` |
| Persona capability: `getFilteredTools` | `plugins/persona/index.ts:312` |
| `registration.request('persona')` allowed (`persona` is a declared optional dep) but must be resolved **lazily at render** | `plugin-engine.ts:769` |
| **Dead code:** `serverAllowlists` written, never read; `filteredToolCount` counts tools the LLM *can* mount | `index.ts:167,320` |

## Design Decisions (explicit)

1. **Two fragments, split by volatility.** HEADER `# MCP Servers` = stable content (server list + descriptions + reminder blurb). FOOTER = volatile connection status, so status churn cannot invalidate the cached header+conversation prefix.
2. **Header content:** every configured server, its description when known, its **available** tool count, plus a blurb telling the model to call `runtime__list_tools` with `{"plugin":"mcp"}` and to list again if an expected tool is missing (list may be stale or the tool named differently).
3. **Footer content:** **only non-connected** servers (`connecting`/`disconnected`/`error`) with status + `lastError`. No descriptions. Renders `false` when all connected.
4. **Tool counts are *available* counts** — computed at render by passing the server's descriptors through persona `getFilteredTools` (exactly what the LLM sees). **No new state field.** No persona capability → all tools minus `defaultHidden` (mirrors the engine fallback).
5. **Servers with no description are still listed** (id + count, no prose).
6. **Summarizer prompt:** one short sentence, ≤20 words, led by the server's purpose, no preamble/markdown/lists.
7. **Cache-bust via `promptVersion`:** entries gain `promptVersion`; mismatch = miss → regenerate on next connect. Existing entries stay on disk, rewritten in place. Tool-list-hash + TTL remain deferred.
8. **Out of scope, tracked as a follow-up:** the dead `serverAllowlists` (per-server `allowedTools` enforcement lost in ADR 105).

## Steps

### Step 1 — `server-description.ts`: prompt, version, lazy paths, locked writes
**Agent:** coder · **Depends on:** none
**File:** `drone-agent/src/plugins/mcp/server-description.ts`

- Move `CACHE_DIR`/`CACHE_FILE` behind lazily-evaluated functions so tests can mock `os.homedir()` (precedent: `plugins/log/index.ts:45`).
- Add `const PROMPT_VERSION = 2;` and put it in every cache entry.
- Tune the system prompt.
- Serialize read-modify-write with `withPathLock` (`../../shared/file-lock.js`) and write via tmp+rename — the cache is shared user state and reconnects from separate connections can lose updates.

```ts
const PROMPT_VERSION = 2;

const SYSTEM_PROMPT =
  'You are a tool catalog summarizer. Given a list of MCP tools with names and ' +
  'descriptions, write ONE short sentence (20 words or fewer) describing what ' +
  "the server does. Lead with the server's purpose. No preamble, no markdown, " +
  'no lists.';

function cacheDir(): string {
  return path.join(os.homedir(), '.drone-agent', 'cache', 'mcp');
}
function cacheFile(): string {
  return path.join(cacheDir(), 'server-descriptions.json');
}

type DescriptionCacheEntry = {
  description: string;
  generatedAt: string;
  promptVersion: number;
};
type DescriptionCache = Record<string, DescriptionCacheEntry>;

async function readCachedDescription(
  serverId: string
): Promise<string | undefined> {
  const entry = (await readCache())[serverId];
  if (!entry) return undefined;
  if (entry.promptVersion !== PROMPT_VERSION) return undefined;
  return entry.description;
}

/** Bulk cache read for seeding the header fragment without per-render IO. */
export async function readCachedDescriptions(): Promise<
  Record<string, string>
> {
  const cache = await readCache();
  const out: Record<string, string> = {};
  for (const [serverId, entry] of Object.entries(cache)) {
    if (entry.promptVersion === PROMPT_VERSION) out[serverId] = entry.description;
  }
  return out;
}

async function writeCachedDescription(
  serverId: string,
  description: string
): Promise<void> {
  await withPathLock(cacheFile(), async () => {
    const cache = await readCache();
    cache[serverId] = {
      description,
      generatedAt: new Date().toISOString(),
      promptVersion: PROMPT_VERSION,
    };
    await ensureCacheDir();
    const file = cacheFile();
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    await rename(tmp, file);
  });
}
```

In `getOrCreateServerDescription`, replace the inline prompt literal with `SYSTEM_PROMPT`; keep the existing behaviour (cache → generate → cache → return; fail-open on error; `logger.warn`). **Do not** change the function's signature or return type.

### Step 2 — New file: `mcp/prompt-fragments.ts` (pure renderers)
**Agent:** coder · **Depends on:** none
**File:** `drone-agent/src/plugins/mcp/prompt-fragments.ts` (new)

```ts
import type { DroneMcpServerState } from 'drone-core';

export type McpServerSummary = {
  id: string;
  state: DroneMcpServerState;
  description?: string;
  availableToolCount: number;
};

const LIST_TOOLS_REMINDER =
  'MCP tools must be mounted before use. Call `runtime__list_tools` with ' +
  '`{"plugin":"mcp"}` to see a server\'s tools. If a tool you expect from a ' +
  'server below is missing, list it again — the list may be stale, or the ' +
  'tool may be named differently.';

export function renderServerSection(
  summaries: McpServerSummary[]
): string | false {
  if (summaries.length === 0) return false;
  const lines = summaries.map(s => {
    const n = s.availableToolCount;
    const count = `(${n} tool${n === 1 ? '' : 's'})`;
    const prose = s.description ? `: ${s.description}` : '';
    return `- ${s.id} ${count}${prose}`;
  });
  return `# MCP Servers\n\n${LIST_TOOLS_REMINDER}\n\n${lines.join('\n')}`;
}

export function renderStatusSection(
  summaries: McpServerSummary[]
): string | false {
  const unhealthy = summaries.filter(s => s.state.status !== 'connected');
  if (unhealthy.length === 0) return false;
  const lines = unhealthy.map(s => {
    const detail = s.state.lastError ? ` — ${s.state.lastError}` : '';
    return `- ${s.id}: ${s.state.status}${detail}`;
  });
  return `# MCP Servers (not connected)\n\n${lines.join('\n')}`;
}
```

Both sync; callers wrap them in the async `render` contract.

### Step 3 — `mcp/index.ts`: capture the description, register both fragments
**Agent:** coder · **Depends on:** Steps 1, 2
**File:** `drone-agent/src/plugins/mcp/index.ts`

1. Imports: `getCanonicalToolName` and types `DronePersonaCapability`, `DroneToolDescriptor` from `drone-core`; renderers + `McpServerSummary` from `./prompt-fragments.js`; `readCachedDescriptions` from `./server-description.js`.
2. Add in-memory state: `const serverDescriptions = new Map<string, string>();`
3. **Capture** the generator's return value (replacing the discard at `index.ts:288`):

```ts
const description = await getOrCreateServerDescription(
  serverId,
  tools.map(t => ({ name: t.name, description: t.description })),
  llmCapability,
  registration.logger
);
if (description) serverDescriptions.set(serverId, description);
```

4. Summary collector. Note the **two name spaces**: `serverToolMaps` defs are named `<serverId>__<tool>`, while persona `getFilteredTools` matches **canonical** names (`mcp__<serverId>__<tool>`) — use `getCanonicalToolName`, do not concatenate.

```ts
function collectServerSummaries(): McpServerSummary[] {
  const personaCap = registration.request<DronePersonaCapability>('persona');
  const summaries: McpServerSummary[] = [];
  for (const serverId of Object.keys(mcpConfig.servers)) {
    const state = serverStates.get(serverId);
    if (!state) continue;
    const descriptors: DroneToolDescriptor[] = Array.from(
      serverToolMaps.get(serverId)?.values() ?? []
    ).map(entry => ({
      name: getCanonicalToolName('mcp', entry.definition.name),
      description: entry.definition.description,
      defaultHidden: false,
    }));
    const visible = personaCap
      ? personaCap.getFilteredTools(descriptors)
      : descriptors.filter(d => !d.defaultHidden);
    summaries.push({
      id: serverId,
      state,
      description: serverDescriptions.get(serverId),
      availableToolCount: visible.length,
    });
  }
  return summaries;
}
```

`registration.request('persona')` is called **inside** the render path, never at register time (the capability is not yet offered then).

5. Register both fragments in `register()`:

```ts
registration.registerPromptFragment({
  key: 'mcp-servers',
  phase: 'header',
  render: async () => renderServerSection(collectServerSummaries()),
});

registration.registerPromptFragment({
  key: 'mcp-server-status',
  phase: 'footer',
  render: async () => renderStatusSection(collectServerSummaries()),
});
```

6. **Seed the description map from the cache** in the `onPluginsLoaded` hook, before the per-server connect loop (gives a *failed* server prose in the header — the case where the reminder matters most; one disk read, never per-render):

```ts
const cached = await readCachedDescriptions();
for (const [serverId, description] of Object.entries(cached)) {
  if (!serverDescriptions.has(serverId)) {
    serverDescriptions.set(serverId, description);
  }
}
```

Place after the `mcpConfig.enabled` / no-servers early returns.

**Constraint:** `collectServerSummaries` stays IO-free (descriptions come from the in-memory map, populated at connect and at seed time).

### Step 4 — Fast unit tests
**Agent:** tester · **Depends on:** Steps 1, 2

**`drone-agent/test/mcp-prompt-fragments.test.ts` (new):** empty list → both renderers `false`; description present → `- demo (2 tools): <prose>`; no description → `- demo (0 tools)`; singular/plural `(1 tool)`/`(2 tools)`; reminder blurb containing `runtime__list_tools` present; status all-connected → `false`; status mixed → only non-connected rows; status renders `lastError` detail.

**`drone-agent/test/mcp-server-description.test.ts` (new):** mock `os.homedir()` to a `mkdtemp` temp dir, save+restore the original (precedent `test/config.test.ts:31`, `test/prompt-file.test.ts:92`). Cases: miss→generate→cache (provider called once, entry carries current `promptVersion`); hit (provider not called); version bust (pre-seed `promptVersion: 1` → provider called, entry rewritten); no LLM capability → `undefined`, no write; provider throws → `undefined` + `logger.warn`; outbound system message contains the one-sentence instruction; `readCachedDescriptions()` omits stale-version entries.

### Step 5 — Slow integration tests
**Agent:** tester · **Depends on:** Step 3
**File:** `drone-agent/test/mcp.test.ts`

- **Required isolation:** mock `os.homedir()` to a temp dir in `beforeEach`, restore in `afterEach`. The connect path *reads* the cache even with no LLM available — without this, a developer's real `~/.drone-agent/cache/mcp/server-descriptions.json` leaks into assertions and the suite goes machine-dependent.
- Header (`engine.renderPromptFragmentsByPhase('header')`): contains `# MCP Servers`; contains `- demo (2 tools)` for a `['echo','add']` fake server; contains the `runtime__list_tools` reminder; no prose when no LLM capability.
- Description-present: pre-seed the temp cache with a current-version entry for `demo`, boot, assert prose appears.
- Footer: all connected → no MCP entry; unavailable server command → `- demo: error`.
- Persona-filtered count: fake persona capability dropping one tool → header shows `(1 tool)`.

### Step 6 — Rewrite `docs/agents/mcp-plugin.md`
**Agent:** coder · **Depends on:** Steps 1–3 settled

Full accuracy pass (not a patched section). The file currently documents `ToolMountingCache` (file no longer exists), per-server `<serverId>__list_tools`/`__mount_tool`/`__unmount_tool` (deleted by ADR 105), and "resources/prompts are still mounted eagerly" (contradicted by ADR 100 and the code). New outline: (1) deferred list/mount via the engine's runtime meta-tools, all MCP tools registered unmounted; (2) per-server `mcp__<server>__list` / `__get` helpers + `mcp__server_status`; (3) `notifications/tools/list_changed` surgical update (the one surviving section); (4) server descriptions — generation, `promptVersion` cache, cache path, `describer` role; (5) **the `# MCP Servers` header fragment and the `<system-reminder>` footer fragment**, with sample renders and the reminder rationale; (6) persona filtering at the runtime seam; (7) known gap — per-server `allowedTools` currently unenforced.

### Step 7 — New ADR + index row
**Agent:** coder · **Depends on:** Step 6
**File:** `docs/adr/240-mcp-server-description-surfacing.md` (new; 240 is next sequential)

Record: the orphaned-consumer history (ADR 065 created it inside `__list_tools`; ADR 105 deleted that home and left the generator running); the header/footer split and why (volatility vs prompt-cache stability); the available-count decision (persona-filter-derived, no new field); the `promptVersion` cache-bust amending ADR 065's "cache is never invalidated"; the explicit rejection of the `server_status`-field alternative; deferred tool-list-hash/TTL; the discovered unenforced per-server `allowedTools` routed to a follow-up.
**File:** `docs/adr/index.md` — append a 240 row in the existing table format.

### Step 8 — Fix `AGENTS.md` + roadmap 5.7
**Agent:** coder · **Depends on:** none

- **`AGENTS.md:180`** — plugin index line still says "Deferred list/mount pattern for tool loading, `ToolMountingCache`, server descriptions, persona filtering". Replace `ToolMountingCache` with the current mechanism (runtime-level `ToolRegistry` + engine meta-tools).
- **Roadmap `5.7 MCP Server Description Cache Invalidation`** — "Not started" → **PARTIAL**: prompt-version invalidation lands; tool-list-hash and TTL remain open. Update via `memory__manage` `store` on key `roadmap`, preserving the rest verbatim.

### Step 9 — Review pass
**Agent:** reviewer · **Depends on:** Steps 1–8

Verify: no disk IO in any fragment `render`; `registration.request('persona')` resolved inside render, never at register time; canonical vs non-canonical names not conflated in `collectServerSummaries`; every test that boots the plugin mocks `os.homedir()`; footer renders only non-connected servers and `false` otherwise; docs match code; no dead code/fluff comments; no unused exports left in `server-description.ts`.

### Step 10 — Log the discovered defect
**Agent:** coder · **Depends on:** none

- `self-improvement__insight` (project target): per-server `allowedTools` is written to `serverAllowlists` and never read; the ADR 065 enforcement died with `__mount_tool` in ADR 105, so `filteredToolCount` overstates filtering and the allowlist is decorative.
- New project memory `followup-mcp-server-allowlist-unenforced`: restore enforcement at the `runtime__list_tools`/persona seam (or at mount), and decide `filteredToolCount`'s fate.

### Step 11 — Validate
**Agent:** tester · **Depends on:** all. Run the validation criteria below.

## Dependencies / Order

```
Step 1 ─┬─► Step 3 ─┬─► Step 5 ─┐
Step 2 ─┘           │           │
   │                ├─► Step 6 ─┼─► Step 9 ─► Step 11
   └─► Step 4       └─► Step 7 ─┘
Step 8 (independent) ────────────┘
Step 10 (independent) ───────────┘
```

Steps 1 and 2 are independent (parallelizable); Step 4 may run alongside Step 3.

## Validation Criteria

1. **LSP diagnostics clean** — `lsp__get_diagnostics` reports no errors or warnings.
2. **`pnpm run lint` passes with zero errors** (prettier will reformat; re-read files before further edits).
3. **`pnpm -r run build` passes with zero errors.**
4. **`pnpm run test` (fast suite) passes**, including the two new test files.
5. **The slow suite passes** — `pnpm run test:integration`, or at minimum `test/mcp.test.ts`.
6. **Behavioural checks:** with `mcp` enabled and a connected server the assembled system prompt contains a `# MCP Servers` header listing it with its available tool count; the reminder blurb names `runtime__list_tools`; a deliberately broken server command produces a footer `<system-reminder>` entry for that server only; no server configured → neither fragment renders; after changing `PROMPT_VERSION` the next connect regenerates and rewrites the cache entry.
7. **The existing on-disk cache is left untouched until first use** — no migration, no manual delete; entries rewritten in place on next connect.

## Included hardening (flagged, not explicitly requested)
Step 1 adds `withPathLock` + tmp+rename to the cache write; this matches the standing project principle that plugin cache read-modify-write must be serialized and atomic, and reconnects from separate connections can lose an update.

## Deliberately out of scope
- Restoring per-server `allowedTools` enforcement (Step 10 tracks it).
- Tool-list-hash comparison and TTL cache invalidation.
- The Obsidian wiki pages (`modules/drone-agent-mcp-client.md`) that are likewise stale on `ToolMountingCache` — left to the wiki maintainer, since those pages are derived.
