---
key: review-state
tags:
  - review
  - code-quality
  - bugs
created: 2026-06-26T01:58:17.133Z
updated: 2026-08-11T01:35:21.852Z
---

# Code Review Report — drone-agent monorepo (2026-08-10)

## Critical Bugs

### 1. Subagent mode is never activated — `_runtime` capability set too late

**Fix Merged**

**File:** `drone-agent/src/runtime/plugin-engine.ts` (`initialize()`)

The `_runtime` capability (carrying `isSubagent`, `subagentId`, `persona`) is set via `capabilities.set('_runtime', {...})` **after** the plugin registration loop completes. But the subagent plugin calls `ctx.request<RuntimeInfo>('runtime')` **synchronously at the top of its `register()`**. Since `_runtime` isn't set yet, `request('runtime')` returns `undefined` during registration, so `runtime?.isSubagent` is always falsy. **The subagent plugin always registers in main-agent mode** — the `subagent.return` tool and the subagent instruction prompt fragment are never registered. Subagents can never explicitly return; they rely entirely on the implicit-return fallback.

**Fix:** Set `capabilities.set('_runtime', ...)` before the plugin registration loop in `initialize()`, or resolve `_runtime` lazily in the `request()` handler.

### 2. `hasExplicitReturn` detection is dead code — tool name mismatch + dot/pokemon naming

**Fix Merged**

**File:** `drone-agent/src/interactive.ts` (line 121)

```ts
if (event.kind === 'toolCall' && event.name === 'subagent.return') {
  hasExplicitReturn = true;
}
```

The tool is registered with name `'subagent.return'`, but the engine canonicalizes it to `subagent__subagent.return` via `getCanonicalToolName()`. The conversation service emits tool calls with the **canonical** name, so `event.name === 'subagent.return'` never matches. `hasExplicitReturn` stays `false` forever, and the implicit return is always emitted. (Compounded by bug #1 — the tool isn't even registered in subagent mode.)

**This is a bigger issue than just the dead check.** The tool name `subagent.return` has **two** problems that must be fixed together:

1. **Dot in the tool name** — `subagent.return` contains a dot, which breaks some Kimi models. Tool names must be dot-free.
2. **Pokemon naming (doubled plugin prefix)** — because the tool is registered as `name: 'subagent.return'` inside the `subagent` plugin, the canonical name becomes `subagent__subagent.return` — the plugin id appears twice. This is the same "pokemon" pattern that was fixed in decision 071 (`subagent__subagent__dispatch` → `subagent__dispatch`), but it has regressed here.

**Fix (all together):**

- Rename the tool to a dot-free, non-prefixed name, e.g. `name: 'return'` → canonical `subagent__return` (this fixes both the dot AND the doubled prefix in one move).
- Update the `hasExplicitReturn` check in `interactive.ts` to compare against the new canonical name `'subagent__return'`.
- Update the subagent instruction prompt fragment text (currently says "call the subagent.return tool") to reference the new name.
- Update any other references to `subagent.return` (e.g. `output-handlers.ts` comment, `interactive.ts` comments).

### 3. Skill insights never route to swarm engines — `scope` vs `source` mismatch

**File:** `drone-agent/src/plugins/self-improvement/validation.ts` (`resolveTargetScope`)

```ts
} else if (targetType === 'skill') {
  const skill = skillsCap.getSkill(targetId);
  return (skill as any)?.scope;   // ← DroneSkillDefinition has `source`, not `scope`
}
```

`DroneSkillDefinition` (in `drone-core/src/skill-types.ts`) has a `source` field (`'user' | 'project' | 'beacon' | 'coordinator'`), **not** `scope`. So `resolveTargetScope` always returns `undefined` for skills, and skill-scoped insights/principles are never routed to beacon/coordinator storage engines. Note `resolveBaseDir` in the same file correctly uses `skill?.source === 'user'` — the two functions are inconsistent.

**Fix:** Use `skill?.source` in `resolveTargetScope`.

### 4. `resolveInsightEngine`/`resolvePrincipleEngine` always return the first registered engine

**File:** `drone-agent/src/plugins/self-improvement/capability.ts`

```ts
if (scope === 'beacon' || scope === 'coordinator') {
  for (const engine of insightEngines.values()) {
    return engine; // ← always the first, regardless of scope
  }
}
```

If both a beacon and a coordinator engine are registered, this always picks whichever was registered first, ignoring the actual target scope. Should select the engine matching the resolved scope.

### 5. `config.set` rejects scalar/array values — schema too restrictive

**File:** `drone-agent/src/plugins/config/index.ts` (`configSetSchema`)

```ts
value: { type: 'object', description: 'Can be a primitive, object, or array...' }
```

The description claims primitives and arrays are allowed, but `Type.Object` rejects them. Setting `ollama.model` to a string (the most common config operation) fails schema validation. The `value` field should be `Type.Unknown()` or a union.

### 6. `maxImageSizeBytes` missing from config schema and known-keys list

**Files:** `drone-core/src/config-schema.ts`, `drone-agent/src/plugins/config/index.ts`

`session.maxImageSizeBytes` exists in `config-types.ts` and is read by `file__read_image`, but it's absent from:

- `PartialDroneAgentConfigSchema`'s `session` object → setting it via config fails validation
- `KNOWN_CONFIG_KEYS` in the config plugin → `config.set` rejects it

Same gap applies to `session.maxToolResultTokensPercent`, `mcp.spawnTimeoutMs`, `mcp.maxResponseSizeBytes`, `mcp.roots`, and the entire `openai.*`, `anthropic.*`, `openrouter.*`, `swarm.*`, `tui.*`, `terminal.*` namespaces in `KNOWN_CONFIG_KEYS`.

---

## Logic Errors

### 7. Ollama debug log references `response` before assignment

**File:** `drone-agent/src/plugins/ollama.ts` (line 204)

```ts
let response;
if (debug) { console.error(`[llm:request] ...`); }
if (debug) { console.error(`[llm:response] ${JSON.stringify(response)}`); }  // ← undefined
try { response = await client.chat(...) } ...
```

The `[llm:response]` debug log runs before `response` is assigned, so it always prints `undefined`. The actual response is only logged inside the `try` block's success path (which is correct). The pre-try log is dead/misleading.

### 8. Safety-trim estimate vs. actual drop mismatch (potential non-convergence)

**Fix Merged (2026-08-11)** — see plan `plan-review-state-8-safety-trim`.

**Files:** `drone-core/src/context-budget-service.ts` + `drone-agent/src/runtime/session-manager.ts`

`evaluateSafetyTrim` computes `requiredDropTurnCount` by slicing `input.turns.slice(dropCount)` — which drops **any** turns from the front, including summary turns. But `dropOldestNonSummaryTurns` in the session manager **stops at the first summary turn** and refuses to drop it. So the estimate can say "drop 3 turns" while the actual drop only removes fewer (or zero) non-summary turns. In a session where the oldest turns are summaries, this can loop without converging and eventually throw "no turns could be dropped" even though the estimate said dropping would work.

**Fix:** Make `evaluateSafetyTrim` skip summary turns when computing the drop count, mirroring `dropOldestNonSummaryTurns` semantics.

**Implemented:** Extracted the drop logic into a shared pure helper `getDroppableTurnPrefix` (`drone-agent/src/runtime/turn-utils.ts`) used by BOTH `dropOldestNonSummaryTurns` and `evaluateSafetyTrim`, so the estimate and the actual drop can never diverge again. `evaluateSafetyTrim` now breaks at the first summary turn and reports `requiredDropTurnCount` as the count of actually-droppable non-summary turns.

### 9. `runJsonMode` / `runJsonListenMode` emit the final assistant message twice

**File:** `drone-agent/src/interactive.ts`

The NDJSON handler emits `assistantMessage` for every such event during the conversation, and then after `sendUserMessage` returns, the code emits `ndjsonHandler({ kind: 'assistantMessage', content: response })` **again**. The final reply is duplicated in the NDJSON stream. (The plain-output handler suppresses this correctly; the NDJSON handler does not.)

### 10. `listPlugins()` omits externally-added plugins

**File:** `drone-agent/src/runtime/plugin-engine.ts`

`listPlugins` maps over the original `plugins` array, not `registeredPlugins`/`pluginMap`. Plugins added via `addExternalPlugin` (e.g. trusted project plugins) won't appear in `/plugins` or the status bar count.

### 11. Beacon `isLocalConnection` misses part of the private range

**File:** `drone-beacon/src/ws-server.ts`

`ip.startsWith('172.16.')` only matches `172.16.x.x`, but the RFC1918 private range is `172.16.0.0/12` (172.16–172.31). A beacon on `172.20.x.x` would be rejected as non-local.

### 12. Coordinator spawn proxy hardcodes `http://`

**File:** `drone-coordinator/src/routes/spawn.ts`

All beacon forwarding uses `http://${beacon.host}:${beacon.port}`. If the beacon runs HTTPS, spawn/list/terminate requests fail. Should respect the beacon's configured protocol.

### 13. Gateway coordinator backend returns an object as a string

**File:** `drone-gateway/src/coordinator-spawn-backend.ts`

```ts
const response = await this.coordinatorClient.sendMessage(
  session.processId,
  message
);
return response as string; // ← response is a JSON object, not a string
```

`CoordinatorClient.sendMessage` returns `unknown` (a parsed JSON object). Casting it to `string` yields `"[object Object]"` when the caller uses it as a message. This is a real type lie.

---

## Code Quality / Maintainability

### 14. `KNOWN_CONFIG_KEYS` is a hand-maintained list that has drifted

The config plugin's `KNOWN_CONFIG_KEYS` is a hardcoded array that's already out of sync with the actual schema (see #6). This is a maintenance trap — every new config key must be added in three places (types, schema, known-keys). Consider deriving the known keys from the TypeBox schema instead.

### 15. `AGENTS.md` claims `enabledPlugins` is "additive at the project level" — code replaces it

`CONFIG_MERGE_SPEC` has `enabledPlugins` in `replace`, not `mergeArrays`. The doc's claim of additive behavior is stale. Either the doc or the code is wrong; the code is the source of truth, so the doc should be updated.

### 16. `subagent/plugin.ts` hardcodes the binary path

```ts
const execPath = resolve(process.cwd(), 'drone-agent', 'bin', 'drone-agent');
```

This assumes the binary lives at `<cwd>/drone-agent/bin/drone-agent`. The gateway's `LocalSpawnBackend` correctly uses `which()` to resolve from PATH. The subagent dispatch should do the same, or it will fail in any non-monorepo layout.

### 17. `search.ts` `truncated` flag is misleading

`--max-count=${maxResults}` limits matches **per file**, but `truncated: results.length >= maxResults` reports total-result truncation. With many files, `truncated` is almost always `true` even when nothing was cut. Also, `--max-count` is a GNU grep option not supported by BSD grep (macOS).

### 18. `app.tsx` error detection is a fragile string heuristic

```ts
const isError = result.content.startsWith(result.name + ' failed');
```

This misclassifies any tool output that legitimately begins with `<name> failed`. The conversation service already knows whether a result was an error (`toolResult.kind === 'error'`) — that signal should be propagated to the TUI instead of re-derived from string matching.

### 19. `doEnablePlugin`/`doAddExternalPlugin` re-run all lifecycle hooks

Both re-invoke `onPluginsLoaded` and `onSessionStart` for **every** registered plugin, not just the newly added one. This can cause duplicate side effects (e.g. the swarm plugin re-registering sessions, compaction re-evaluating). Should only run catch-up hooks for the new plugin.

### 20. `resolveInsightEngine`/`resolvePrincipleEngine` "first engine" pattern (see #4) is also a code smell

The `for...return` over a `Map` to grab the first value is obscure. Use `insightEngines.values().next().value` or an explicit lookup.

### 21. `memory/index.ts` cache keyed inconsistently

`capability.store` does `cache.get(key)` with the raw key but `cache.set(entry.key, entry)` with the sanitized key. For keys containing `/` or other sanitized characters, the cache lookup misses and re-reads from disk every time. Minor, but the cache is effectively broken for non-trivial keys.

### 22. `config-schema.ts` `Percent` type prevents disabling truncation

`Type.Number({ exclusiveMinimum: 0, maximum: 100 })` rejects `0`, but the conversation service treats `maxToolResultTokensPercent: 0` as "disable truncation". You can't express "off" through config.

### 23. `plugin-engine.ts` `renderPromptFragments` has no error isolation

`Promise.all(promptFragments.map(f => f.render()))` — a single throwing fragment rejects the whole batch, breaking the system prompt. Each render should be wrapped in try/catch (the conversation service already does this pattern for hooks).

---

## What's Done Well

- **The list/mount tool framework** (`ToolRegistry`, runtime meta-tools) is clean and well-documented.
- **The `deepMerge` + `MergeSpec` refactor** is a good replacement for the old hand-rolled config merging.
- **The `withFileLock` + atomic tmp+rename write** in self-improvement is a correct fix for the concurrent read-modify-write race.
- **The patch-applier cascade** (exact → fuzz → context → heading) is well-structured and the failure reporting (cheat sheets, Levenshtein suggestions) is genuinely useful.
- **The porcelain parser** correctly preserves leading whitespace and documents why.
- **Error handling in `executeToolSafely`** and the stuck-detector are thoughtful.
- **The TUI tail-region commit pattern** (live components → atomic commit to `<Static>`) is a solid design.

---

## Suggested Priority Order

1. **#1 + #2** — subagent mode is fundamentally broken (registration ordering + name mismatch). This is the highest-impact bug. **#2's fix must also remove the dot from the tool name (Kimi compatibility) and fix the doubled-prefix "pokemon" naming** — rename `subagent.return` → `return` (canonical `subagent__return`), update the `hasExplicitReturn` check, the prompt fragment, and all references.
2. **#3 + #4** — swarm insight/principle routing is broken for skills and ambiguous for multiple engines.
3. **#5 + #6** — config schema/known-keys drift breaks common operations.
4. **#8** — safety-trim non-convergence can hard-fail sessions.
5. **#9** — duplicate NDJSON output breaks gateway/subagent consumers.
6. **#13** — gateway coordinator backend returns garbage strings.
7. The rest are correctness/robustness improvements.

Recommend fixing the critical bugs (#1–#6) first, then the logic errors (#7–#13), then the quality items. The `KNOWN_CONFIG_KEYS` drift (#14) should be addressed structurally (derive from schema) rather than patched, or it will keep rotting.
