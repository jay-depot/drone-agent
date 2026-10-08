---
tags: [decision, wakelock, lint, debug-flag, engineering-tooling]
related:
  [
    decisions/169-wakelock-plugin.md,
    modules/drone-agent.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
  ]
---

# 170: Wakelock debug-flag fix + project-wide lint re-enablement

**Status**: Implemented (2026-08-28)

## Context

Two issues were addressed together in the branch implementing the completed plan `plan-wakelock-fix-and-lint-cleanup`.

### A. `--debug wakelock` could never work

ADR 169 (`decisions/169-wakelock-plugin.md`) documented that the wakelock plugin's optional `--debug wakelock` subsystem logs acquire/release transitions "via the existing `_runtime.flags` `DebugFlagRegistry`". That mechanism was **broken at runtime**:

- The wakelock plugin declared its own local `RuntimeInfo.flags: { isEnabled(name): boolean }` and called `runtime.flags.isEnabled('wakelock')`.
- The engine injects `_runtime.flags` as a `RuntimeFlagRegistry` (drone-core `runtime-flags.ts`) — a **key/value system-prompt registry** (`has`/`get`/`set`/`append`/`entries`/`render`) with **no `isEnabled` method**.
- `registration.request<RuntimeInfo>('runtime')` is an **unchecked `as T` cast**, so typecheck passed but every acquire/release threw a swallowed `TypeError` inside the `onConversationEvent` hook (which the conversation service invokes fire-and-forget with `.catch` swallow). `--debug wakelock` silently did nothing.
- The plugin's unit test fabricated its own `flags.isEnabled` mock, hiding the contract violation.

The fix is to expose the **real** `DebugFlagRegistry` (which the engine already receives at construction, line 313 of `plugin-engine.ts`) as a new `debugFlags` field on the `_runtime` capability, and point the wakelock plugin at `runtime.debugFlags.isEnabled('wakelock')` — referencing the real exported `DebugFlagRegistry` type instead of a fabricated local interface. The test mock now mirrors the real shape, and a regression test wires a **real engine** with the debug subsystem enabled to prove the `TypeError` is gone.

### B. ESLint silently excluded the core packages

`eslint.config.mjs` ignored `drone-agent/src/**`, `drone-beacon/**`, `drone-coordinator/**`, and **all test files** (`**/test/**/*.ts`, `**/test/**/*.tsx`). As a result `pnpm lint` "passed" trivially while 228 lint errors accumulated across the codebase — dead code, unused imports, `any` types, control-character regexes, useless assignments, and an unreachable `let`/`const` trap.

## Decision

1. **Expose the shared `DebugFlagRegistry` to plugins via `_runtime.debugFlags`.** The plugin engine already receives the registry at construction; adding it to the `_runtime` capability (an **additive** field) makes it available to any plugin that wants runtime debug-subsystem checks. This is the correct mechanism for the wakelock `--debug wakelock` subsystem — distinct from the `RuntimeFlagRegistry` (system-prompt key/value state).

2. **Correct ADR 169's documented mechanism.** The wakelock plugin reads `runtime.debugFlags.isEnabled('wakelock')`, not `_runtime.flags` (`RuntimeFlagRegistry`).

3. **Re-enable project-wide linting.** `eslint.config.mjs` now ignores only `node_modules/` and `dist/`. The resulting 228 errors (82 files) were fixed with a stated policy: **real types where feasible, `unknown` where a precise shape can't be expressed; zero `any` and zero `eslint-disable` comments remaining** (approach C from planning).

### The origin: commit `91fac79e` silently disabled linting on most of the project

The project-wide exclusion this ADR reverses was introduced on **2026-06-25 by commit `91fac79e`** ("Fix linting errors and update eslint config", on `main`, an ancestor of the `feat/wake-lock-plugin` branch). That commit changed `eslint.config.mjs` from:

```js
ignores: ['**/dist/'],
```

to:

```js
ignores: [
  '**/dist/',
  '**/test/**/*.ts',
  '**/test/**/*.tsx',
  'drone-beacon/**',
  'drone-coordinator/**',
  'drone-agent/src/**',
],
```

The stated rationale in the commit message was "update eslint config to exclude test files and other packages with deep issues." In practice it stripped ESLint coverage from **every test file** (`**/test/**/*.ts`/`.tsx`), the **entire beacon**, the **entire coordinator**, and **all of drone-agent's source** (`drone-agent/src/**`). The bulk of that commit's diff was Prettier reformatting plus Docker dependency/`package-lock.json` additions; the lint-disablement was a small but consequential `eslint.config.mjs` hunk. Because `pnpm lint` continued to "pass" under the narrowed config, roughly **228 latent errors accumulated over the subsequent ~two months** (125 `no-explicit-any`, 65 `no-unused-vars`, 15 `no-unsafe-function-type`, 12 `no-useless-assignment`, 5 `preserve-caught-error`, 4 `no-control-regex`, 2 `prefer-const`) without any signal — the exact conditions that made the `--debug wakelock` `TypeError` (section A of this ADR) sail through undetected.

This is the inverse companion to the current fix: commit `91fac79e` is _where_ linting silently stopped guarding the codebase, and the re-enablement in the `plan-wakelock-fix-and-lint-cleanup` branch (commit `b34dd397`) + this ADR is _where_ it was restored and the backlog cleared. The process lesson: an ESLint `ignores` block is a hidden config consumer with no compiler — sweep it whenever the lint surface changes, and be alert to a green `pnpm lint` that is green because large swaths of code are excluded rather than because they are clean.

## The 228-error cleanup

| Rule                      | Count | Notes                                                                             |
| ------------------------- | ----- | --------------------------------------------------------------------------------- |
| `no-explicit-any`         | 125   | 33 prod / 92 test                                                                 |
| `no-unused-vars`          | 65    | dead imports/locals/params across src + test                                      |
| `no-unsafe-function-type` | 15    | `Function` → `DroneToolDefinition['execute']` / `(...args: unknown[]) => unknown` |
| `no-useless-assignment`   | 12    | dead initializers + `body = retry.body` etc.                                      |
| `preserve-caught-error`   | 5     | attach `{ cause }`                                                                |
| `no-control-regex`        | 4     | build control-char regexes via `String.fromCharCode`                              |
| `prefer-const`            | 2     | `captured` (safe); `resetStuckDetectorsRef` (trap)                                |

Notable decisions within the sweep:

- **Production `any` sites** typed with real types where possible: `Markdown.tsx` uses marked's own `Token`/`Tokens` types; `swarm/hooks.ts` defines local `BeaconInsightRecord`/`BeaconPrincipleRecord` interfaces; `coordinator-client.ts` uses `unknown` for opaque coordinator session payloads; compaction/ollama `(error as any)?.status_code` replaced with `DroneLlmError.status` / a typed structural guard; `self-improvement/validation.ts` `(skill as any)?.scope` → `skill.source` (the field that actually carries scope semantics on `DroneSkillDefinition`); `swarm/providers.ts` types the `/skills` wire shape as `BeaconSkill` (extends `DroneSkillDefinition` with `scope`).
- **`syntax-highlight.ts`** — the last `any`/`eslint-disable` pair removed. The token functions now use **local structural `HighlightNode`/`HighlightRoot` types** (a minimal hast-AST shape) rather than importing the transitive `hast` dependency (which isn't directly resolvable from drone-agent). `HighlightNode` includes a catch-all for non-element/text hast node kinds so a real lowlight tree is assignable.
- **`prefer-const` trap** — `resetStuckDetectorsRef` in `index.tsx` IS reassigned at line 316, so a blind `let`→`const` breaks the build (TS2588). eslint's `prefer-const` was a false positive. Fixed by restructuring to a **const holder object** `{ current?: () => void }` whose property is mutated — satisfies the rule without suppressing it and preserves the mutable-ref semantics the engine closure needs.
- **`no-unused-vars` stale flags** — several "unused" symbols (wiki-storage `readPage`, config-plugin `homeDir`, log-plugin `homeDir`) were actually referenced; the lint flag was stale, and removing them broke tests. They were reverted.
- **`no-control-regex`** — `\u` escapes are still flagged; the fix is `new RegExp(String.fromCharCode(27) + '...')` so no control char appears literally in source.

Dead code removal of note: the `llm` plugin's dead `activatedExplicitly` flag and unused `resolveProviderConfig` function; the LSP installer's unread `crc32`/`uncompressedSize` ZIP reads; unused imports across `file.ts`, `ollama/index.ts`, `mcp/client.ts`, `mcp/index.ts`, `provider-migration.ts`, `git/components/list.tsx`, and the drone-beacon db/routes.

Stray `// NEW:` scaffold comments (5 across `cli.ts`, `plugins/index.ts`, `plugin-engine.ts`) were removed as part of the same cleanup.

## Validation

- `npx eslint . --ext .ts,.tsx` → **0 errors, 0 warnings** (was 228 errors across 82 files)
- `grep` confirms **zero** `: any` / `as any` / `<any>` and **zero** `eslint-disable` comments in `src/` and `test/`
- `pnpm -r run typecheck` + `pnpm -r run build` + `pnpm lint` all pass
- `pnpm test` → **2325 passed / 9 skipped** (was 2324; +1 wakelock regression test)

## Key Points

- The wakelock plugin now reads the **real** shared `DebugFlagRegistry` via `_runtime.debugFlags` (additive capability field) — `--debug wakelock` actually works. ADR 169's documented `_runtime.flags` mechanism was incorrect and corrected.
- Linting is now genuinely project-wide; the core agent, both swarm servers, and all tests are linted.
- The 228-error cleanup used approach C: real types where feasible, `unknown` elsewhere, **zero `any` and zero `eslint-disable`**.
- `resetStuckDetectorsRef` is a case where eslint's `prefer-const` is a false positive (the symbol IS reassigned); the const-holder-object pattern resolves it without suppression.

## Related

- [169-wakelock-plugin](169-wakelock-plugin.md) — The ADR whose `--debug wakelock` mechanism this fix corrects
- [drone-agent](../../drone-agent/) — `_runtime` capability now carries `debugFlags`; conversation service
- [drone-core](../../drone-core/) — `DebugFlagRegistry` / `RuntimeFlagRegistry` distinction
- [drone-agent-plugins](../../drone-agent/src/plugins/) — wakelock row
- [110-debug-tools-flag](110-debug-tools-flag.md) — the shared `DebugFlagRegistry` origin
