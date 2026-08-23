---
key: plan-context-window-metadata-and-migration-persistence
tags:
  - plan
  - bugfix
  - llm
  - providers
  - migration
  - context-window
created: 2026-08-23T18:23:17.849Z
updated: 2026-08-23T18:23:17.849Z
---

# Plan: Context-window resolution via broker metadata + durable legacy-config migration

## Summary

Two coupled defects on branch `feat/provider-model-config`:

1. **Context usage misreported (~50%+ on 1M models at fresh start).** Phase 2's driver conversion dropped `getContextWindowInfo` from the openai/anthropic/openrouter protocol plugins (method is optional; TS silent). `ContextBudgetService.resolveContextWindow()` falls back to `session.contextWindowTokens` (default **32768**, `drone-core/src/config-types.ts:533`), collapsing the denominator. Same bogus window feeds `requiresSafetyTrim` and compaction — spurious trims/premature compaction are live risks. Correct values already exist as declared model metadata (`providers.<id>.models[id].contextWindow`) that `resolveModelMetadata()` resolves but the window path ignores.

2. **Legacy→providers migration never persists.** `migrateLegacyProviderConfig()` runs every startup in memory only (`runtime/config.ts:139`) with a "please hand-edit" warning. Declared model metadata survives only via the invisible shim. `${VAR}` interpolation happens at parse time (`parseConfigWithSchema` → `transformEnvVars`), so naive write-back would leak resolved secrets to disk.

**Fix strategy (locked decisions):**
- Broker-side interception in `getActiveProvider()` mirroring the existing `chat()` enrichment pattern. Precedence: **declared → discovered → live driver probe → session fallback**.
- `DroneContextWindowInfo.source` union extended with `'metadata'`.
- Migration persists automatically on change, file-backed scopes only; backup `config.json.<timestamp>.old`; content derived from **raw re-parsed JSON** (templates stay templates, literals stay literals); inline API keys relocated faithfully + advisory warning; **legacy sections stripped unconditionally** whenever a migration write touches a file; project scope never receives `providers` (scope policy) — in-memory + redirect warning there; swarm underlays stay memory-only.
- First-run wizard already writes new format — untouched.

---

## Phases & Steps

### Phase A — drone-core type foundation

**A1 (coder):** In `drone-core/src/session-types.ts`, extend:
```ts
export type DroneContextWindowInfo = {
  model: string;
  contextWindowTokens: number;
  source: 'provider' | 'config' | 'default' | 'metadata';
};
```
Update the doc comment: `'provider'` = live probe (ollama `client.show()`), `'metadata'` = declared/discovered catalog data, `'config'` = session fallback.

**A2 (coder):** Run `pnpm -r run build`. drone-agent resolves drone-core types from `dist/` (not source) — skipping this produces phantom LSP errors (the workspace currently shows exactly this class of stale-diagnostic noise).

### Phase B — broker interception (independent of Phase C)

**B1 (coder):** `drone-agent/src/plugins/llm/index.ts` (~line 303). Replace:
```ts
getContextWindowInfo: inner.getContextWindowInfo?.bind(inner),
```
with a wrapper that resolves at call time (currentModel can change):
```ts
getContextWindowInfo: async ({ model }) => {
  const fullId = `${instance.providerId}/${currentModel}`;
  const metadata = resolveModelMetadata(fullId);
  const wireModel = metadata.model ?? currentModel;
  if (metadata.contextWindow !== undefined) {
    return { model: fullId, contextWindowTokens: metadata.contextWindow, source: 'metadata' };
  }
  const probed = await inner.getContextWindowInfo?.({ model: wireModel });
  if (probed) {
    return { ...probed, model: fullId };
  }
  return {
    model: fullId,
    contextWindowTokens: registration.getConfig().session.contextWindowTokens,
    source: 'config',
  };
},
```
Notes: `resolveModelMetadata` already implements declared ⊕ one-level-alias-base ⊕ discovered. Never returns null (budget service keeps its own fallback as dead-code defense). File is ~689 lines; stay under the 750-line split threshold.

**B2 (coder):** Emit one `registration.logger.info` (or gate behind `--debug llm` if cheap) at first resolve per model: model, tokens, source — provenance visibility.

**B3 (tester):** Unit tests (`test/` — new `llm-context-window.test.ts` or extend existing):
1. Declared `models[id].contextWindow` wins over discovered.
2. Discovered used when undeclared.
3. Driver probe used when neither (mock inner).
4. Alias base honored (entry with `model:` pointing at sibling).
5. Session fallback when everything absent.
6. Wrapper reflects model switches without cache staleness.

### Phase C — migration persistence (independent of Phase B)

**C1 (coder):** Refactor `runtime/provider-migration.ts`: extract the structural transform into shared helpers operable on BOTH the decoded `DroneAgentConfig` (existing runtime path, unchanged behavior) and a raw `Record<string, unknown>` JSON shape (persist path). Export e.g. `migrateLegacyProviderConfigRaw(raw)` returning `{ raw, changed, migratedSections, seededActive }`.

**C2 (coder):** New module `runtime/provider-migration-persist.ts`:
- Input: resolved layer list + paths. For each **file-backed layer** (user, project) whose RAW file contains ≥1 legacy section:
  - Copy file → sibling `config.json.<ISO-timestamp-sanitized>.old` (e.g. `config.json.2026-08-23T13-40-00-000Z.old`)
  - Apply `migrateLegacyProviderConfigRaw` to freshly parsed raw JSON
  - Seed `llm.active` into raw only if that file lacks `llm.active` entirely (cross-layer pins elsewhere remain authoritative; redundant seed is harmless)
  - **Strip all four legacy sections unconditionally** (even when shadowed by pre-existing `providers` — covers mixed-format files per locked Q7 policy)
  - Atomic write: tmp file same dir + `rename`
- Inline-key detection: any relocated `apiKey` that is NOT a `${VAR}` template → collect advisory string ("consider ${VAR} template") into returned warnings. No rewriting of literals (locked Q6).
- Project scope: NEVER write `providers` (violates `provider-scope-policy`); instead return a redirect-warning ("define providers in user config"). Swarm underlays: skipped (memory-only, server-owned).
- Persist trigger = raw-file analysis (legacy sections present), NOT the in-memory `changed` flag — avoids spurious writes when only swarm underlays contributed legacy data, and makes idempotence structural.

**C3 (coder):** Wire into `loadAgentConfig` (`runtime/config.ts`): after `migrateLegacyProviderConfig(mergedConfig)`, call the persist module; merge its warnings into `warnings`; adjust `formatMigrationNotice` output to reflect saved state ("migrated and saved to <path>; backup at <bak>"). Keep `provider-migration.ts` self-contained/deletable per its header comment.

**C4 (tester):** Tests (`test/provider-migration-persist.test.ts`):
1. User-scope file with legacy anthropic section → providers block appears, legacy stripped, `.old` backup exists with original bytes, `${ANTHROPIC_API_KEY}` template preserved verbatim.
2. Literal apiKey relocated unchanged + advisory warning emitted.
3. Mixed-format file (providers + shadowed legacy) → legacy stripped, providers untouched.
4. Already-canonical file → no write, no backup, no notice.
5. Project scope with legacy sections → NO providers written; warning returned.
6. Second run → no-op (idempotent).
7. Crash-safety shape: assert tmp+rename pattern (e.g., spy that writeFile targets temp path then rename called).

### Phase D — consumer sanity

**D1 (tester):** Regression test: fresh-session `getEstimatedContextUsagePercent` with declared 1M window and realistic system prompt + tool schemas ≈ low single digits (<10%), and `requiresSafetyTrim === false`. Repro-of-bug test: with probe removed and no declared metadata, percent against default 32768 exceeds 50% (documents the failure mode this fix eliminates).

**D2 (reviewer):** Confirm no other `DroneContextWindowInfo.source` consumers break under the widened union (grep `.source ===` / switch statements; expect none — searches showed only unrelated `source` fields).

### Phase E — validation criteria (final gate)

1. `pnpm -r run build` exits 0 (run FIRST — clears stale-dist phantom diagnostics).
2. LSP diagnostics: zero errors workspace-wide.
3. Root `pnpm lint` passes (NOTE: `pnpm -r run lint` does not exist; lint lives at repo root only).
4. Root `pnpm test` fast suite green (NOTE: `pnpm -r run test` is structurally broken per known insight — always use root).
5. Manual smoke: launch TUI against a 1M-token model → status bar shows single-digit %; `~/.drone-agent/config.json` rewritten with `providers` + `llm.active`, `*.old` backup present, `${VAR}` templates intact; second launch performs no rewrite.
6. Docs: update `docs/agents/provider-model-config.md` (migration now persists; describe backup + strip semantics) and AGENTS.md config-section sentence ("auto-migrated into providers on load" → "migrated and persisted on first load").

## Dependencies / Order

A → (B, C in parallel) → D → E. Phase B fixes the denominator immediately; Phase C guarantees the declared metadata exists for B to find (they compound — B alone works only for users whose metadata survived the shim).

## Out of scope / deferred

- `env`-style config section (recorded in `llm-provider-future-work` backlog as possible later ergonomics layer; plaintext-env-block security value judged mostly theater unless keyring-backed).
- Keyring-backed secrets, bundled model registry (existing backlog items).