---
key: plan-fix-portable-context-host-wiring
tags:
  []
created: 2026-10-12T00:20:55.058Z
updated: 2026-10-12T00:28:52.622Z
---

# Plan: Fix checkpoint `session.turns = []` — wire the engine's host session-boundary collaborators

Status: READY FOR EXECUTION. All decisions finalized in a grilling session (2026-10-11, branch `feat/portable-context`). Do not re-litigate.

## 1. Summary — what and why

`/checkpoint create test-checkpoint` writes a portable-context export whose `session.turns` is empty (everything else — `tools`, `pluginData` — is correct).

**Root cause.** The engine seeds the `portable-context` capability with the session manager it was constructed with, falling back to an internal noop:

```ts
// drone-agent/src/runtime/plugin-engine.ts (~L1144)
sessionManager: sessionManager ?? createNoopSessionManager(),
```

`drone-agent/src/index.tsx` (~L210) is the ONLY production construction site of `createDronePluginEngine`, and it omits `sessionManager`. The noop's `getTurns()` always returns `[]`, so `exportContext()` serializes zero turns; `sourceSessionId` is likewise the fallback `agent-<Date.now()>` instead of the real id.

**Two sibling regressions from the same omission (both confirmed in code):**

1. **`/clear` is a no-op.** `drone-agent/src/runtime/builtin-commands.ts` calls `ctx.engine.clearSession()`. The engine's `clearSession()` reads `sessionManager?.getTurns()` (→ `[]`, so `hadTurns` is false) and `clearConversationFromHost?.()` (→ `undefined`). It clears nothing, fires no `onSessionClear`/`onSessionRecycle`, and mints no new id.
2. **`--session-id` / `DRONE_SESSION_ID` are ignored.** The engine mints `agent-<Date.now()>`; the swarm plugin prefers `_runtime.getSessionId()` (`drone-agent/src/plugins/swarm/index.ts` ~L138), so the CLI value never reaches beacon registration.

**Fix strategy.** Wire the three missing options in `index.tsx`, and make the two host-owned session-boundary collaborators **required** engine options so `pnpm run typecheck` (which includes `tsconfig.test.json`) forces every construction site — including `index.tsx` — to supply them. Migrate the ~143 test construction sites to a new shared `createTestEngine` helper.

## 2. Decisions (locked)

- **D1 — Scope:** fix all three symptoms (checkpoint empty turns, `/clear` no-op, ignored `--session-id`).
- **D2 — `clearConversation` wiring:** add a `clearConversationRef` mutable ref alongside the four existing host refs (`resetStuckDetectorsRef`/`submitUserMessageRef`/`cancelCurrentRequestRef`/`shutdownSignalRef`); pass `clearConversation: () => clearConversationRef.current?.()`; assign `clearConversationRef.current = conversation.clearSession` after `createConversationService(...)`. (Matches the established lazy-host-ref pattern.)
- **D3 — Regression guard:** make `sessionManager` **and** `clearConversation` **required** in `CreateDronePluginEngineOptions`; delete `createNoopSessionManager`. `sessionId` stays optional (its `agent-<Date.now()>` fallback is legitimate).
- **D4 — Test sweep:** add a shared `createTestEngine(options)` to `drone-agent/test/helpers.ts` that supplies the two required options as defaults and spreads caller overrides; migrate all test construction sites to it. (Satisfies the project's anti-duplication standard and centralizes future required-option defaults.)

## 3. Implementation steps (ordered; deps noted)

### Step 1 — `drone-agent/src/runtime/plugin-engine.ts` (agent: `code`; no deps)

1. **Export the options type.** Change `type CreateDronePluginEngineOptions = {` (~L259) to `export type CreateDronePluginEngineOptions = {`.
2. **Make the two options required.** In that type, change:
   - `sessionManager?: import('./session-manager.js').DroneSessionManager;` → `sessionManager: import('./session-manager.js').DroneSessionManager;`
   - `clearConversation?: () => void;` → `clearConversation: () => void;`
3. **Destructure without a default.** In `createDronePluginEngine({...})` (~L471) keep `sessionManager,` and `clearConversation: clearConversationFromHost,` as-is (they now bind the required values).
4. **Delete `createNoopSessionManager`** (~L335-345) entirely, including its jsdoc block.
5. **Seed the capability with the real manager.** At ~L1144 change `sessionManager: sessionManager ?? createNoopSessionManager(),` → `sessionManager,`.
6. **Tighten `clearSession()`** (~L589-608): drop the now-unnecessary optional chaining — `const turns = sessionManager.getTurns();` and call `clearConversationFromHost();` directly (was `clearConversationFromHost?.()`).

### Step 2 — `drone-agent/src/index.tsx` (agent: `code`; depends on Step 1)

1. **Add the ref** beside the other four (~L200-207):
   ```ts
   const clearConversationRef: { current?: () => void } = {};
   ```
2. **Pass the three options** in the `createDronePluginEngine({...})` call (~L210):
   ```ts
   sessionManager,
   clearConversation: () => clearConversationRef.current?.(),
   sessionId: invocation.options.sessionId,
   ```
   (`sessionManager` is the `createSessionManager()` already created at ~L90.)
3. **Assign the ref** immediately after the other three ref assignments (~L349-351, just after `createConversationService`):
   ```ts
   clearConversationRef.current = conversation.clearSession;
   ```

### Step 3 — `drone-agent/test/helpers.ts` (agent: `code`; depends on Step 1)

Add imports and the helper:
```ts
import { createSessionManager } from '../src/runtime/session-manager.js';
import {
  createDronePluginEngine,
  type CreateDronePluginEngineOptions,
  type DronePluginEngine,
} from '../src/runtime/plugin-engine.js';

/**
 * Build the plugin engine the way the CLI does, defaulting the two required
 * host-owned session-boundary collaborators so tests never hand-roll them.
 * Caller overrides win — a test needing a specific session manager or a real
 * clearConversation passes its own.
 */
export function createTestEngine(
  options: CreateDronePluginEngineOptions
): DronePluginEngine {
  return createDronePluginEngine({
    sessionManager: createSessionManager(),
    clearConversation: () => {},
    ...options,
  });
}
```
(Keep the existing `createFakeEngine`/`createMockEngine` unchanged — they return engine literals, not construction options.)

### Step 4 — Migrate test construction sites (agent: `worker`; depends on Step 3)

Ground truth for the site list: `rg -n 'createDronePluginEngine\(' drone-agent/test` and `pnpm run typecheck` (the root `tsc -p tsconfig.test.json` step is the only typechecker covering test files). For each site (≈22 files, ≈143 calls; e.g. `plugin-engine.test.ts`, `config-plugin.test.ts`, `macros.test.ts`, `session-param-events.test.ts`, `skills-plugin.test.ts`, `persona-cli-flag.test.ts`, `portable-context-engine.test.ts`, `self-improvement/setup.ts`, `owned-skill-writers.test.ts`, …):

- Replace the `createDronePluginEngine(` call with `createTestEngine(`.
- Replace the `createDronePluginEngine` import with `createTestEngine`.
- Any `ReturnType<typeof createDronePluginEngine>` / `Parameters<typeof createDronePluginEngine>[0]` (e.g. `owned-skill-writers.test.ts`) becomes `... typeof createTestEngine ...`.
- **Do not** touch `portable-context-engine.test.ts`'s explicit `sessionManager`/`clearConversation` args — they intentionally exercise the real boundary; leave them as passed overrides (or route through `createTestEngine` keeping the overrides).
- `sessionManager: undefined` in `macros.test.ts`/`session-param-events.test.ts` is a **slash-context** field (`ctx.sessionManager`), NOT an engine option — leave it.

### Step 5 — New regression tests (agent: `tester`; depends on Steps 1-3)

Add a file (e.g. `drone-agent/test/engine-host-wiring.test.ts`) that guards the exact production path:

1. **Turns survive the engine's export.** Build with `createTestEngine`; `appendUserMessage('hello')` on the *same* manager passed in; get `engine.getCapability('portable-context')`; assert `(await cap.exportContext()).session.turns.length === 1` and `session.sourceSessionId` equals the seeded id.
2. **Host-seeded session id flows through.** Seed `sessionId: 'host-id'`; assert `engine.getSessionId() === 'host-id'` and the export's `sourceSessionId === 'host-id'`.
3. **`engine.clearSession()` clears + mints.** With a real `clearConversation: () => sessionManager.clearSession()` and a non-empty session, assert turns empty, id changed, and `onSessionClear` saw the intact session (order `clear-hook → mechanical-clear → recycle-hook`). (This duplicates the intent of `portable-context-engine.test.ts`; if that file already covers it, consolidate rather than duplicate.)

### Step 6 — Docs (agent: `code`; depends on Steps 1-5)

- **New ADR** `docs/adr/248-engine-host-wiring-required-session-boundary.md`: record that `sessionManager` + `clearConversation` are required engine options (the noop fallback was removed), the `createTestEngine` consolidation, and that this makes the production wiring compiler-enforced. Note the two sibling regressions (`/clear`, `--session-id`) the same omission caused.
- **Amend** `docs/adr/246-portable-context.md` Consequences: the `sessionManager`/`clearConversation` construction options are **required**, not optional.
- **Update** the project wiki pointer stubs if 246/247 text is mirrored (the canonical ADR text lives in `docs/adr/`). Add `248` to `docs/adr/index.md`.
- Update `AGENTS.md`'s plugin/hook docs only if they mention the engine options as optional.

### Step 7 — Final validation (agent: `review`)

Run every gate in §4.

## 4. Validation criteria (all MUST pass)

1. **LSP clean** for all touched files (drone-agent src + tests) — zero errors.
2. `pnpm -r run build` — zero errors.
3. `pnpm run lint` — zero errors (prettier reformats; re-read files before further edits).
4. `pnpm run typecheck` — zero errors, INCLUDING `tsc -p tsconfig.test.json` (this is the gate that proves every construction site supplies the now-required options).
5. `pnpm run test` (fast suite) — passes.
6. **Feature verification:**
   - A newly created checkpoint (or `exportContext()`) on a session with turns has a **non-empty** `session.turns`.
   - `session.sourceSessionId` equals `_runtime.getSessionId()` (and the host-seeded `--session-id` when given).
   - `/clear` on a non-empty session empties turns, mints a new id, and fires `onSessionClear` → `onSessionRecycle`.
   - `--session-id <x>` makes `engine.getSessionId()` return `<x>`.
   - `createNoopSessionManager` no longer exists (grep clean).
7. **No dead code / unused vars / fluff comments.** `sessionId` remaining optional is intentional (documented).
8. Commit any unstaged `.drone-agent` memory/insight/ADR files with the change (project memory is checked in on feature branches; do not commit to `main`).

---

## ✅ COMPLETED (2026-10-12) — executed by persona `code`

All 7 steps executed. Commit `f65777f5` on `feat/portable-context` (31 files, +435/−227).

**Step 1 — `plugin-engine.ts`.** Exported `CreateDronePluginEngineOptions`; made `sessionManager` + `clearConversation` required; deleted `createNoopSessionManager`; capability seed now `sessionManager,`; `clearSession()` uses `sessionManager.getTurns()` and calls `clearConversationFromHost()` unconditionally.

**Step 2 — `index.tsx`.** Added `clearConversationRef`; passed `sessionManager`, `clearConversation: () => clearConversationRef.current?.()`, `sessionId: invocation.options.sessionId`; assigned `clearConversationRef.current = conversation.clearSession` after `createConversationService`.

**Step 3 — `test/helpers.ts`.** Added `createTestEngine(options)`. Deviation from the plan's literal snippet: the parameter type is `Omit<CreateDronePluginEngineOptions, 'sessionManager' | 'clearConversation'> & Partial<Pick<...>>` (the plan's `options: CreateDronePluginEngineOptions` would have required every caller to still pass the two fields, defeating the defaults).

**Step 4 — test sweep.** Migrated 144 `createTestEngine(` call sites across 22 files (scripted). Deviations/additions found while typechecking:
- `persona-premount.test.ts` had a *pre-existing local* `createTestEngine` helper that collided with the import → renamed the local helper to `createPersonaEngine`.
- `portable-context-engine.test.ts` kept its explicit `sessionManager`/`clearConversation` overrides (as instructed).
- `sessionManager: undefined` in macros/session-param-events left untouched (slash-context field).
- `tsc -p tsconfig.test.json` (the authoritative gate) is clean; LSP diagnostics that appeared to flag errors were stale (pre-fix line numbers).

**Step 5 — `test/engine-host-wiring.test.ts`.** New: (a) turns survive `exportContext()` with the real host manager; (b) host-seeded id flows through `getSessionId()` and the export's `sourceSessionId`; (c) empty session exports empty turns. Skipped the plan's #3 (clear+recycle order) per its own consolidation note — `portable-context-engine.test.ts` already covers order, mint, seeded/fallback ids, and capability seeding.

**Step 6 — docs.** New `docs/adr/248-engine-host-wiring-required-session-boundary.md`; amended ADR 246 Consequences; added 248 to `docs/adr/index.md`; created wiki stub `decisions/248-...md` + added it to the wiki decisions index. `AGENTS.md`/`docs/agents/portable-context.md` did not claim the options were optional, so left unchanged.

**Step 7 — validation (all green):** LSP clean; `pnpm -r run build` clean; `pnpm run lint` clean; `pnpm run typecheck` clean incl. `tsc -p tsconfig.test.json`; `pnpm run test` → 293 files / 3879 tests passed (3 files / 14 tests skipped — integration-gated); feature checks: `createNoopSessionManager` absent from code, options required, index wiring present, plus the 10 new/existing boundary tests pass.

**Follow-up note:** `createTestEngine`'s parameter type duplicates the omit/pick shape; if a third required option is ever added it is added in `plugin-engine.ts` only and `createTestEngine`'s `Omit`/`Pick` must be updated in lockstep (a single edit site).