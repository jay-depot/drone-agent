---
tags: [decision, adr, llm, providers, config, context-window]
related: [155-provider-model-config.md, ../concepts/provider-model-selection.md, ../concepts/session-management.md]
---

# 156 — Broker metadata context windows + durable legacy migration

**Date**: 2026-08-23
**Status**: Accepted (implemented on `feat/provider-model-config`)

## Context

Two defects shared one root: the provider/protocol/model refactor's data
([155-provider-model-config](155-provider-model-config.md)) was only half-wired at its two
consumption ends.

1. **Every context-window calculation used the wrong denominator.** Phase 2's
   driver conversion made `getContextWindowInfo` an *optional* method and the
   rewritten openai/anthropic/openrouter `createProvider` factories returned
   providers containing **only `chat`** — the old probes were silently
   dropped. TypeScript never complained; tests stayed green; the bug surfaced
   purely as a wrong number: a fresh session on a 1M-token model showed >50%
   context used, because `ContextBudgetService.resolveContextWindow()` fell
   back to `session.contextWindowTokens` (default **32768**) while the real
   numerator (~15–20k of system prompt + tool schemas) was unchanged. The same
   bogus window fed `requiresSafetyTrim` and compaction, so spurious safety
   trims and premature compaction were live risks, not just cosmetics. The
   insult: correct values already existed as declared model metadata that the
   broker's `resolveModelMetadata()` resolved for every *other* purpose — the
   window path simply bound straight through (`inner.getContextWindowInfo?.bind(inner)`)
   instead of using it.

2. **Legacy→providers migration ran in memory forever and never persisted.**
   Every startup re-derived synthetic `providers` from legacy sections with
   only a "please hand-edit your config" warning. Declared model metadata
   (including those 1M `contextWindow`s) survived solely inside this invisible
   per-run shim; any consumer not routed through the migrated object lost it.
   Compounding hazard: `${VAR}` interpolation happens **at parse time**, so a
   naive write-back of the merged config would have leaked *resolved* API keys
   to disk.

The two bugs compound: fixing (1) alone only helps users whose declared
metadata survived the non-persisted shim.

## Decision

### Context-window resolution moves broker-side (mirrors the chat() enrichment pattern)

`getActiveProvider()`'s view of the provider now wraps `getContextWindowInfo`
the same way it wraps `chat()`, via a new `resolveActiveContextWindow(instance, requestedModel?)`:

```
declared models[id].contextWindow
  > alias-base entry (one level)
  > discovered metadata          → { source: 'metadata' }
  > driver live probe            → driver's own source ('provider'/'default')
  > session.contextWindowTokens  → { source: 'config' }
```

- Precedence matches every other model attribute (declared ⊕ discovered,
  declared wins) rather than inventing a second ordering. A user can always
  pin a window from config; a chatty probe can never override it. No network
  on the hot path — ollama's `client.show()` probe only fires when no catalog
  data exists.
- The wrapper resolves at call time against the *current* selection and keys
  everything on canonical full-form ids (`<providerId>/<modelLocalId>`),
  since `getModel()` returns bare local ids.
- Wire contract: the inner probe receives the wire model name
  (`declared.model ?? localId`); results are normalized back to full form.
- **`DroneContextWindowInfo.source` union widened with `'metadata'`**
  ('provider' = live probe, 'metadata' = catalog data, 'config' = session
  fallback, 'default' = hardcoded). Provenance is logged once per model per
  session (`Context window for <id>: <n> tokens (source: <s>)`) so any future
  wrong-denominator report is diagnosable from the log alone.

Rejected alternative: re-implementing `getContextWindowInfo` inside each of
the three drivers — duplicates the resolution chain the broker already owns,
and guarantees the next protocol plugin forgets it again (exactly the failure
mode being fixed).

### Migration persists automatically, safely

On load, after the in-memory migration, a new module
(`runtime/provider-migration-persist.ts`) rewrites file-backed layers whose
RAW JSON still carries legacy sections:

- **Trigger is raw-file analysis** (legacy sections present in the parsed
  file), not the in-memory `changed` flag — makes idempotence structural and
  avoids spurious writes when only swarm underlays contributed legacy data.
- **Content derived from raw re-parsed JSON**, never the merged/interpolated
  config: `${VAR}` templates stay templates on disk; pre-existing literals
  stay literal (no new exposure). Inline keys are relocated unchanged with an
  advisory `${VAR}` suggestion — never auto-rewritten (a migration that
  bricks auth by inventing unset env vars is worse than status quo).
- **Backup first**: `<path>.<sanitized-ISO>.old` holds the original bytes;
  rollback story for the strip policy below.
- **Atomic write**: tmp file + rename in the same directory.
- **Strip unconditionally**: all four legacy sections are removed whenever a
  migration write touches a file — including sections already shadowed by an
  existing `providers` block (mixed-format files), eliminating the dual-source
  ambiguity that produced bug (1).
- **Scope rules**: user scope rewrites; project scope never receives
  `providers` (banned by scope policy there) and
  only produces a redirect warning; swarm underlays stay memory-only
  (server-owned).
- `llm.active` seeding during persist only fills a file that lacks it entirely;
  cross-layer pins elsewhere remain authoritative.

One structural transform backs both entry shapes (decoded config → runtime
behavior unchanged; raw JSON → persistence). The migration module remains
self-contained/deletable when the deprecation window closes.

## Consequences

- Status-bar percentages, `requiresSafetyTrim`, and compaction thresholds are
  correct per-model without user action; users with stale declared windows can
  see (and fix) them because provenance is visible.
- Upgrading configs converge to canonical form on first launch, exactly once,
  with backups.
- Optional-interface methods are now a known regression vector: when an
  interface method becomes optional mid-refactor, enumerate implementers
  before/after and treat any drop as a regression candidate (logged as project
  insight).
- Vitest passing ≠ type-clean: esbuild strips types without checking; only
  `tsc` caught test files violating the `{model}` wire contract.

## Validation

Build/typecheck/lint clean workspace-wide; fast suite **2151 passed / 0
failed** (+17 new units: 7 window-resolution precedence incl. alias + model-
switch freshness, 7 persistence scenarios incl. template preservation and
byte-exact backup verification, 3 regression/repro-of-bug); fresh
`tsc -p tsconfig.test.json --noEmit` exit 0. Manual TUI smoke deferred to the
user (rewrites their real user config; spends tokens).

## Related

- [155-provider-model-config](155-provider-model-config.md) — parent refactor whose half-wired consumption ends caused both bugs
- provider-model-selection — the metadata chain this decision extends to context windows
- session-management — consumers of the corrected denominator
