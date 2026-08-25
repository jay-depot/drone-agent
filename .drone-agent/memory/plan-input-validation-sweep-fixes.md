---
key: plan-input-validation-sweep-fixes
tags: []
created: 2026-08-25T18:42:41.513Z
updated: 2026-08-25T18:42:41.513Z
---

# Plan: Fix remaining input-validation gaps across plugins (follow-up to plan-self-improvement-trim-before-validate)

## Summary

The project-wide sweep (see memory: audit-input-validation-sweep) found 1 CRASH + 6 latent clusters of required-but-unenforced tool inputs. Because executeTool dispatches straight to tool.execute with no schema enforcement, these produce raw TypeErrors, misleading downstream errors (/wiki/undefined 404s, "Unknown action: undefined"), or false successes. Scope approved by user: crash + all misleading-error latents (items 1-7). DEFERRED by user decision: bootstrap elicitation-answer hardening (~10 sites) — contract-backed by both elicit hosts populating every requested id; revisit only if ask() semantics change.

Conventions per plugin family (fixes MUST match local style):

- memory: throws Error with friendly messages
- swarm tools (wiki/coordinator/message): return JSON.stringify({success:false, error})
- notepad: returns {success:false, error} JSON
- subagent return tool: throw (error surfaces to subagent LLM via executeToolSafely, teaching retry)

## Implementation steps

### Step 1 — coder: shared helper for swarm param validation

New file `drone-agent/src/plugins/swarm/string-params.ts`:

```ts
/**
 * Return the first field name whose value is not a non-empty string,
 * or undefined when all listed fields are present.
 */
export function firstMissingString(
  params: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = params[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return field;
    }
  }
  return undefined;
}
```

Validates only; never transforms the value used downstream.

### Step 2 — coder: tools-wiki.ts (depends 1)

In wiki_read (:31), wiki_search (:141), wiki_delete (:208): first line of execute:

```ts
const missing = firstMissingString(params, ['pageId']); // or ['query']
if (missing) {
  return JSON.stringify({
    success: false,
    error: `${toolName} requires a non-empty ${missing}.`,
  });
}
```

(toolName = literal 'wiki_read' etc.) In wiki_write (:95): `firstMissingString(params, ['pageId', 'title', 'content'])` with same shape. Keep existing casts below the guards unchanged.

### Step 3 — coder: tools-coordinator.ts (depends 1)

Same guard-first pattern:

- swarm_spawn (~:160): fields ['targetBeaconId'] before building POST body
- swarm_get_spawn: ['beaconId', 'spawnId']
- swarm_list_spawns: ['beaconId']
- swarm_terminate_spawn: ['beaconId', 'spawnId']
  Error prefix uses literal tool name. Leave already-SAFE list_beacons/list_agents/status paths alone.

### Step 4 — coder: tools-message.ts (depends nothing)

Send branch (~:55), alongside the existing toAgentId/toChannel guard:

```ts
if (typeof body !== 'string' || body.length === 0) {
  return JSON.stringify({
    success: false,
    error: 'send requires a non-empty body.',
  });
}
```

Do NOT trim body (message payloads may be significant); plain emptiness check.

### Step 5 — coder: memory/index.ts

manage execute (~:165):

```ts
const key = typeof input.key === 'string' ? input.key.trim() : '';
if (!key) throw new Error('memory.manage requires a non-empty key.');
if (action !== 'store' && action !== 'recall' && action !== 'delete') {
  throw new Error('memory.manage action must be store, recall, or delete.');
}
```

(mirrors the existing `value` typeof-guard 4 lines below; fixes CRASH item). Same action-membership guard in browse execute (~:239) with 'list'/'search'.

### Step 6 — coder: notepad.ts

After `const action = input.action as string;` (~:57) and BEFORE the clear branch/state mutation:

```ts
if (action !== 'set' && action !== 'clear' && action !== 'append') {
  return JSON.stringify({
    success: false,
    error: 'notepad action must be set, clear, or append.',
  });
}
```

Kills the silent false-success path.

### Step 7 — coder: subagent/plugin.ts

First lines of the `return` tool execute (~:63):

```ts
if (typeof input.result !== 'string' || input.result.trim().length === 0) {
  throw new Error('return requires a non-empty result string.');
}
```

### Step 8 — tester: memory tests (depends 5)

Extend `test/memory-index.test.ts` using its existing mock-registration capture pattern (find tool by captured name, call execute):

- manage `{action:'recall'}` (no key) → rejects /requires a non-empty key/ (NOT TypeError)
- manage `{action:'recall', key: 42}` (mistyped) → same friendly rejection
- manage `{key:'k', action:'bogus'}` → rejects /action must be store, recall, or delete/
- browse `{action:'list', ...}` unaffected (regression guard existing behavior stays green)

### Step 9 — tester: swarm validation tests (depends 2,3,4)

NEW file `test/swarm-tool-input-validation.test.ts`. Import createWikiTools(ctx) and createCoordinatorTools(url) directly (both exported); stub global fetch with vi.fn(). For each: invoke execute with the required field(s) omitted → parse JSON result, expect success===false, error matches /requires a non-empty/, AND expect fetch mock NOT called (proves short-circuit before network). Cases: wiki_read no pageId; wiki_search no query; wiki_delete no pageId; wiki_write no title (and one case with all three missing); swarm_get_spawn no spawnId; swarm_list_spawns no beaconId; swarm_terminate_spawn neither; swarm_spawn no targetBeaconId. For tools-message: locate the message-tools factory export in tools-message.ts (document-symbols lookup; exact name to confirm), construct minimal ctx, call send with toAgentId but no body → success:false /non-empty body/. Also happy-path spot-check ONE wiki_read with valid pageId against a mocked fetch response to prove no over-blocking.

### Step 10 — tester: subagent test (depends 7)

Extend `test/subagent-plugin.test.ts`: find how existing tests invoke the registered `return` tool (see also fixtures/subagent.ts), add case executing it with {} → rejects /non-empty result/.

### Step 11 — tester: notepad tests (depends 6)

NEW file `test/notepad.test.ts` (none exists today). Instantiate notepadPlugin, register with mock registration capturing the manage tool:

- `{action:'bogus'}` → success:false, /must be set, clear, or append/
- `{}` → same (this was the silent true before)
- after a failed action, rendered prompt fragment is still '' (state untouched)
- happy paths: set then fragment renders content; append concatenates; clear empties

### Step 12 — reviewer: verify against validation criteria below

Execution order: 1 → (2,3 parallel; 4,5,6,7 independent) → (8,9,10,11 parallel after their deps) → 12.

## Validation criteria

1. New regression cases fail on pre-fix source, pass post-fix (run targeted specs before/after if executing sequentially).
2. Targeted: pnpm vitest run test/memory-index.test.ts test/swarm-tool-input-validation.test.ts test/swarm-spawn.test.ts test/subagent-plugin.test.ts test/notepad.test.ts — green.
3. LSP diagnostics: zero errors/warnings workspace-wide.
4. pnpm -r run build passes; pnpm lint passes (re-read files after prettier reformats).
5. Full fast suite pnpm test passes (incl. existing swarm/e2e suites proving no behavior change for well-formed calls).
6. Grep confirms: no `(input.key as string).trim()` in memory/index.ts; no bare required-field casts ahead of guards in the five touched files; bootstrap/index.ts UNTOUCHED (deferred).
7. Error-message conventions preserved per plugin family (throws in memory/subagent, {success:false,error} in swarm/notepad).

Explicitly out of scope (recorded, deferred): bootstrap elicitation answers (audit-input-validation-sweep item 8); schema if/then tightening (rejected — provider support inconsistent).
