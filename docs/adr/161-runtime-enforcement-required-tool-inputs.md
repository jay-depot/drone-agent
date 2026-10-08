---
tags: [decision, input-validation, tools, plugins, error-handling]
related:
  [
    flows/tool-call-loop.md,
    modules/drone-agent-plugins.md,
    decisions/071-tool-consolidation-batch-2.md,
    decisions/105-runtime-level-list-mount.md,
  ]
---

# 161: Runtime Enforcement of Required Tool Inputs

**Status**: Implemented (2026-08-25)

## Context

A user-visible crash exposed a systemic gap: calling `self-improvement__insight` with `targetType` but **no `targetId`** threw `TypeError: Cannot read properties of undefined (reading 'trim')` instead of the tool's own friendly `"targetId must be a non-empty string."` error.

Root cause is architectural: `engine.executeTool()` (`drone-agent/src/runtime/plugin-engine.ts`) dispatches **straight to `tool.execute()`** with no JSON-schema validation layer anywhere in the dispatch path. Every tool's `inputSchema.required` array — and every enum/type constraint — is purely an LLM-facing hint. The conversation service wraps execution in `executeToolSafely`, but that only converts _thrown_ errors into `{kind:'error'}` results; it never validates inputs. So any tool that casts-then-calls-methods on an unenforced field (`(input.x as string).trim()`) crashes opaquely whenever a caller omits or mistypes it.

Why tests missed it for so long: existing "rejects empty targetId" cases passed `targetId: ''` — an empty _string_, which survives `.trim()` and reaches the downstream guard. The crash comes from the **omitted** variant (`undefined`), which no test exercised. Empty-string-passes-through vs. omitted-crashes-before-guard is now a standing test-design distinction (see [145-guardrail-reliability-features](145-guardrail-reliability-features.md) for the sibling lesson about guardrail counters).

## Decision

**Tools own runtime validation of their required inputs; schemas stay advisory.** Two shapes of fix, matched to each plugin family's error convention:

### 1. Normalize-before-validate (`self-improvement`)

Added `trimOrEmpty(value: unknown): string` to `plugins/self-improvement/validation.ts` (returns `''` for non-strings). All five cast-trim sites across `insight.ts`, `principle.ts`, and `mark-examined.ts` funnel through it; `validateTarget()`'s pre-existing `if (!targetId)` guard then catches empty-string and omitted identically, with byte-identical error messages (three existing test files assert those exact strings). Deliberately rejected: tightening the JSON schemas with `if/then` conditional requirements — provider support is inconsistent across LLMs, and the runtime guard is the real safety net regardless.

### 2. Guard-first validation (`memory`, `swarm`, `notepad`, `subagent`)

A project-wide subagent sweep (~94 files under `src/plugins/` plus `runtime/builtin-commands.ts`) classified every remaining site as CRASH / LATENT (misleading downstream errors) / LATENT (defense-in-depth) / SAFE:

- `swarm/string-params.ts` gained `firstMissingString(params, fields)`; guard-first checks in all four wiki tools and four coordinator spawn/info tools return `{success:false, error:'<tool> requires a non-empty <field>.'}` **before any network call** — killing `/wiki/undefined` 404s and `/spawn/undefined/undefined` coordinator round-trips.
- `tools-message.ts` send branch: plain typeof/length check on `body` (payloads deliberately not trimmed); previously a body-less send queued silently.
- `memory/index.ts`: `typeof input.key === 'string' ? input.key.trim() : ''` before the friendly throw (the CRASH site), plus action-membership throws in manage ("must be store, recall, or delete") and browse ("must be list or search") replacing `"Unknown action: undefined"` degradation.
- `notepad.ts`: action-membership check returning `{success:false}` before any state mutation — unknown/omitted actions had fallen through both branches returning `{"success":true}` while doing nothing.
- `subagent/plugin.ts`: the `return` tool throws on missing/mistyped/blank `result`; previously the event was silently dropped by the parent's `typeof event.result === 'string'` filter and surfaced as the opaque "Subagent did not return a result", masking the real cause.

Conventions preserved per family: memory/subagent **throw** (executeToolSafely normalizes into error results); swarm/notepad return `{success:false, error}` result payloads.

**Explicitly deferred:** hardening the bootstrap workflows' elicitation-answer casts (~10 `(answers.x as string)` sites). Their provenance is contract-backed — both elicit hosts (readline + TUI) populate every requested question id unconditionally — so nothing user- or LLM-reachable can trigger a crash there. Revisit only if `ask()` semantics change.

## Key Points

- Schema `required` arrays are documentation, not enforcement. Any new tool that casts an input field must guard before first use — prefer the two established helpers over ad-hoc casts.
- Test both input variants when covering validation: `''` (exists, survives `.trim()`) and omitted (`undefined`, crashes before any guard). The empty-string-only gap let this bug class ship despite three "rejects empty" tests.
- The audit cleared several suspicious-looking sites as SAFE — e.g. bootstrap's guarded `(input.path as string).trim()` behind a leading `typeof` conjunct, git/lsp/exec/todo's validate-first helpers, persona/skills select-recall's exact `typeof x === 'string' ? trim : ''` pattern. Grep hits are leads, not verdicts; classify by reading context.
- Validation regression tests were proven to fail against pre-fix source via a stash-dance (stash only source files → run new tests → 22 failures → pop → green), keeping the new tests honest without reverting anything.
- Validation: targeted self-improvement suite 73/73; touched-spec suite 51/51; full fast suite 2227 passed / 9 skipped; build + lint + LSP clean. Commits `1183cc4`, `43276bf` on `fix/insight-logging-hints`.
- **Known residual (minor, as of 2026-08-25):** a few `(x as string) || default` sites remain — e.g. the `swarm/tools-message.ts` action and the `search` mode — where a non-string _truthy_ input is used as-is rather than defaulted, so it degrades to an `Unknown action: <junk>` message instead of an explicit membership error. **None crash; none false-succeed.** A low-priority future-sweep candidate; re-verify against source before acting, since the original line refs go stale.

## Related

- tool-call-loop — `executeToolSafely` normalizes thrown validation errors into `{kind:'error'}` results the LLM can learn from
- [drone-agent-plugins](../../drone-agent/src/plugins/) — per-plugin notes on which surfaces gained guards
- [071-tool-consolidation-batch-2](071-tool-consolidation-batch-2.md) — earlier consolidation of these same plugin surfaces
- [105-runtime-level-list-mount](105-runtime-level-list-mount.md) — the list-mount discovery layer whose descriptions carry the (advisory) schemas
