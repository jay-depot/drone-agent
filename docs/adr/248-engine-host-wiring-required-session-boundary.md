---
tags:
  [
    decision,
    plugin-engine,
    session,
    portable-context,
    checkpoint,
    host-wiring,
    test-infrastructure,
    adr,
  ]
related:
  [
    decisions/246-portable-context.md,
    decisions/247-checkpoint-plugin.md,
    decisions/221-reference-expansion-host-wiring.md,
    decisions/239-herdr-agent-integration.md,
    concepts/session-management.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
  ]
---

# 248: Engine host wiring — required session-boundary options, no noop fallback

**Status**: Implemented (2026-10-12) · **Branch**: `feat/portable-context` · **Plan**: project-memory `plan-fix-portable-context-host-wiring`

**Summary**: `createDronePluginEngine` now **requires** its two host-owned session-boundary collaborators — `sessionManager` and `clearConversation` — instead of accepting them as optional options with internal fallbacks. The internal `createNoopSessionManager` fallback is deleted. `index.tsx` (the only production construction site) wires the real session manager, a lazy `clearConversation` ref, and the host-seeded `sessionId`. A shared `createTestEngine(options)` helper in `test/helpers.ts` defaults the two required options so every test construction site (≈144, across 22 files) stays terse. This makes the production wiring **compiler-enforced**: a construction site that forgets a boundary collaborator now fails `pnpm run typecheck` (which includes `tsc -p tsconfig.test.json`) rather than silently degrading at runtime.

## Context

`portable-context` ([246](246-portable-context.md)) and its first consumer, the `checkpoint` plugin ([247](247-checkpoint-plugin.md)), depend on the engine holding the live session. The engine seeds the `portable-context` capability with the session manager it was constructed with:

```ts
// before this ADR
sessionManager: sessionManager ?? createNoopSessionManager(),
```

`createDronePluginEngine` accepted `sessionManager?` and `clearConversation?` as optional. `drone-agent/src/index.tsx` — the **only** production construction site — supplied neither. Every test that exercised the boundary passed one explicitly, so the omission was invisible to the suite.

The noop session manager's `getTurns()` always returned `[]`. Three production defects followed from the single omission:

1. **Checkpoint exports had empty turns.** `/checkpoint create test-checkpoint` wrote a snapshot whose `tools` and `pluginData` were correct but whose `session.turns` was `[]`, because `exportContext()` reads `deps.sessionManager.getTurns()`. `session.sourceSessionId` likewise fell back to `agent-<Date.now()>` instead of the real id.
2. **`/clear` was a no-op.** `engine.clearSession()` reads `sessionManager.getTurns()` (→ `[]`, so `hadTurns` is false) and calls `clearConversationFromHost?.()` (→ `undefined`). It cleared nothing, fired no `onSessionClear`/`onSessionRecycle`, and minted no new id.
3. **`--session-id` / `DRONE_SESSION_ID` were ignored.** The engine minted `agent-<Date.now()>`; the swarm plugin prefers `_runtime.getSessionId()`, so the CLI value never reached beacon registration.

The root cause is a design smell: **optional host-owned collaborators with internal fallbacks hide missing production wiring**. An optional option is indistinguishable, at the type level and in tests, from a wired one.

## Decision

**1. Make the two host-owned session-boundary collaborators required.** In `CreateDronePluginEngineOptions` (now exported), `sessionManager` and `clearConversation` lose their `?`. `sessionId` stays optional — its `agent-<Date.now()>` fallback is a legitimate default for a fresh session, unlike a session manager that silently discards turns.

**2. Delete `createNoopSessionManager`.** The noop existed only to satisfy the optional option. With the option required there is no legal constructor that omits a session manager, so the fallback is dead code. The capability seed becomes `sessionManager,` and `clearSession()` drops its now-unnecessary optional chaining (`sessionManager.getTurns()`, `clearConversationFromHost()`).

**3. Wire the production host.** `index.tsx` gains a `clearConversationRef: { current?: () => void }` alongside the four existing host refs, passes `sessionManager`, `clearConversation: () => clearConversationRef.current?.()`, and `sessionId: invocation.options.sessionId` to `createDronePluginEngine`, and assigns `clearConversationRef.current = conversation.clearSession` immediately after `createConversationService(...)` — the same lazy-ref pattern the other host-owned collaborators use (the conversation does not exist when the engine is constructed).

**4. Collapse the test construction sites onto `createTestEngine`.** A new exported `createTestEngine(options)` in `drone-agent/test/helpers.ts` supplies the two required options as defaults and spreads caller overrides:

```ts
export function createTestEngine(
  options: Omit<
    CreateDronePluginEngineOptions,
    'sessionManager' | 'clearConversation'
  > &
    Partial<
      Pick<
        CreateDronePluginEngineOptions,
        'sessionManager' | 'clearConversation'
      >
    >
): DronePluginEngine {
  return createDronePluginEngine({
    sessionManager: createSessionManager(),
    clearConversation: () => {},
    ...options,
  });
}
```

The parameter type omits the two fields and re-adds them as optional, so a test that needs a specific session manager or a real `clearConversation` still passes its own and wins. `portable-context-engine.test.ts` keeps its explicit overrides (it exercises the real boundary). Every other construction site (~144 calls across 22 files) migrated mechanically; the root `tsc -p tsconfig.test.json` step is the ground truth for the sweep.

## Alternatives considered

- **Keep the options optional, default `sessionManager` to a real `createSessionManager()` inside the engine.** Rejected: the engine would mint a session manager disconnected from the host's — turns appended by the conversation service would not be the turns the capability exports. A host-owned resource must be the host's.
- **Keep the noop but assert at runtime.** Rejected: a runtime throw would surface the omission at startup, but only on the code path that touches the boundary; compiler enforcement catches every site statically.
- **Wire `clearConversation` eagerly (`clearConversation: conversation.clearSession`).** Impossible without reordering construction (the conversation depends on the engine). The lazy ref is the established pattern.
- **A generic "required options have no fallback" lint.** Rejected as speculative; the type system already expresses it.

## Consequences

- **The production wiring is compiler-enforced.** A construction site that omits `sessionManager` or `clearConversation` now fails `pnpm run typecheck` (including `tsc -p tsconfig.test.json`), so the class of defect this ADR fixes cannot recur silently.
- **Three production defects are fixed together**, all from the same omission: checkpoint exports carry the real turns and `sourceSessionId`; `/clear` empties the session, mints a new id, and fires `onSessionClear` → `onSessionRecycle`; `--session-id`/`DRONE_SESSION_ID` reach `engine.getSessionId()` and beacon registration.
- `DronePluginEngine`'s `sessionManager`/`clearConversation` construction options are **required**, not optional — this amends [246](246-portable-context.md)'s Consequences.
- `createTestEngine` centralizes the two defaults, so a future required option is added in one place. Existing `createFakeEngine`/`createMockEngine` are untouched — they return engine literals, not construction options.
- New `test/engine-host-wiring.test.ts` guards the exact production path: turns survive `exportContext()`, the host-seeded id flows through, and an empty session exports empty turns. The clear/recycle order stays covered by `portable-context-engine.test.ts`.
