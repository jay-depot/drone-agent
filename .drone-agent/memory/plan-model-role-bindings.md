---
key: plan-model-role-bindings
tags:
  - plan
  - llm
  - providers
  - model-roles
created: 2026-08-26T03:45:51.257Z
updated: 2026-08-26T03:45:51.257Z
---

# PLAN: Model Role Bindings (`llm.modelRoles`) + Compaction `summarizer`

Branch: `feat/model-role-bindings` (created off main, clean tree, 2026-08-25)

## Summary

Plugins that make their own LLM calls (compaction summarization, persona-creation wizard, MCP server-description generation) currently always use the session's active selection (`llm.active`). This feature adds a centralized convention — `llm.modelRoles: Record<string, string>` mapping role names to canonical `<providerId>/<modelLocalId>` selections — plus a broker capability method `resolveModelForRole(role)` that returns a ready-to-call `{ provider, providerId, model, reasoningLevel }`. First implementations: compaction uses role `summarizer`; persona wizard uses `wizard`; MCP server-descriptions use `describer` (see Interpretation Notes). Unset/misconfigured roles fall back to the active selection, so today's behavior is the default.

## Locked decisions (from planning session)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Central `llm.modelRoles` config key (not per-plugin keys)                                                                                                                                                                                                                                                                                                   |
| D2  | `Record<string,string>`, strict full-form `<providerId>/<modelLocalId>` values (schema pattern like `llm.active`); no per-role knob objects                                                                                                                                                                                                                 |
| D3  | Open role namespace; documented well-known roles `summarizer`, `wizard`, `describer` exported from drone-core                                                                                                                                                                                                                                               |
| D4  | Startup post-merge validation warns (never fatal) on unknown provider refs and on role names outside the well-known list                                                                                                                                                                                                                                    |
| D5  | `DroneLlmCapability.resolveModelForRole(role)` → `{ provider, providerId, model, reasoningLevel? }`; ALL THREE internal callers migrated                                                                                                                                                                                                                    |
| D6  | Resolution is stateless/read-only (never mutates activeProviderId/currentModel, emits no events); fallback-to-active with warn-once-per-role-per-session; info-once when a role resolves differently from active                                                                                                                                            |
| D7  | Session context window governs compaction triggering (unchanged); the resolved role pair governs summary-request sizing including its own getContextWindowInfo probe; multi-round loop drains remainder                                                                                                                                                     |
| D8  | Deferred: compaction→ContextBudgetService window-resolution consolidation (separate follow-up plan, lands on this branch after stabilization)                                                                                                                                                                                                               |
| D9  | Observability: compaction started/completed events ALWAYS name `<providerId>/<model>`; no status-bar change; no new event kinds                                                                                                                                                                                                                             |
| D10 | Scope policy: `llm.modelRoles` BANNED at project scope (extends enforceProviderScopePolicy, startup-fatal like `providers`); user scope + swarm underlays sanctioned                                                                                                                                                                                        |
| D11 | Config-file editing only for v1 (documented in docs/agents/provider-model-config.md); NO slash command; NO KNOWN_CONFIG_KEYS/config.set support (dynamic `llm.modelRoles.<role>` paths hit the same allowlist limitation as `providers.*` — future work)                                                                                                    |
| D12 | Reasoning level: shared pure helper `resolveConfiguredReasoningLevel(config, selection)` (drone-core) = selected model entry `.reasoningLevel` → `config.llm.reasoningLevel`; broker returns it for roles; conversation service adopts the helper (keeping its session-override tier ahead of it); callers thread it into `DroneChatRequest.reasoningLevel` |

## Interpretation notes (user can veto during review)

- MCP server-descriptions migrates onto `resolveModelForRole('describer')`. 'describer' defaults to unset → identical behavior today, convention-compliant, and prepares the `image_describer` follow-up. If the user intended ONLY summarizer+wizard to migrate, strike Step 4c and leave server-description.ts untouched.
- Well-known-role list therefore contains three names even though user "blessed" two — describer exists so pinning it never triggers the D4 typo warning.

## Implementation steps

### Phase 1 — drone-core: types, schema, defaults, validation, shared reasoning helper

Assignee: coder. Everything lands in `drone-core/src/`.

1. **Types** (`config-types.ts`): add to `DroneLlmConfig`:
   ```ts
   /** Role-name → canonical `<providerId>/<modelLocalId>`. Project scope banned. */
   modelRoles?: Record<string, string>;
   ```
   Defaults (`createDefaultAgentConfig`): seed `llm: { provider: 'ollama', modelRoles: {} }`.
2. **Well-known roles** (`model-selection.ts`):
   ```ts
   export const WELL_KNOWN_MODEL_ROLES = [
     'summarizer',
     'wizard',
     'describer',
   ] as const;
   export type DroneModelRole =
     | (typeof WELL_KNOWN_MODEL_ROLES)[number]
     | (string & {});
   ```
3. **Schema** (`config-schema.ts`): extend the llm section schema with
   `modelRoles: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: '^[^/]+/.+' })))`
   (parse-time fatal on malformed selections — mirrors `llm.active`).
4. **Shared reasoning helper** (`model-selection.ts`):
   ```ts
   export function resolveConfiguredReasoningLevel(
     config: Pick<DroneAgentConfig, 'providers' | 'llm'>,
     selection: { providerId: string; modelLocalId: string }
   ): DroneReasoningLevel | undefined {
     return (
       config.providers[selection.providerId]?.models?.[selection.modelLocalId]
         ?.reasoningLevel ?? config.llm.reasoningLevel
     );
   }
   ```
5. **Role validation** (`config-schema.ts`, near `validateProviders` at :415): new
   ```ts
   export function validateModelRoles(
     providers: Record<string, DroneProviderConfig>,
     modelRoles: Record<string, string> | undefined
   ): string[]; // warnings
   ```
   Warn per role: value references nonexistent provider id; role name not in WELL_KNOWN_MODEL_ROLES. Never fatal.
6. **Merge spec** (`config-types.ts` CONFIG_MERGE_SPEC): inspect `applyMergeSpec`/`applyAgentConfigLayer` first. Goal: per-role (per-key) merge of `modelRoles` across layers so user `{summarizer}` + beacon-underlay `{wizard}` combine; scalars (`active`, `reasoningLevel`) unchanged. Likely shape: remove `'llm'` from `merge[]`, add `deepMerge: { llm: { deepMerge: { modelRoles: {} } } }` (mirrors the `session.retry` precedent). Scalar keys merge identically either way; adapt to the real MergeSpec API.
7. **Resolve-role result type** (`capabilities.ts`, near DroneLlmCapability :146):
   ```ts
   export type DroneResolvedModelRole = {
     provider: DroneLlmProvider;
     providerId: string;
     model: string;
     reasoningLevel?: DroneReasoningLevel;
   };
   ```
   Extend `DroneLlmCapability` with:
   ```ts
   /** Resolve a named model role (e.g. 'summarizer'). Stateless; falls back to the active selection when the role is unset/unknown/broken. */
   resolveModelForRole: (role: string) => DroneResolvedModelRole;
   ```
8. Tests (drone-core/test): schema accepts valid/rejects malformed role values; defaults carry empty modelRoles; per-role cross-layer merge; validateModelRoles warning cases; resolveConfiguredReasoningLevel chain.
9. **Run `pnpm -r run build` NOW** (dependent packages resolve drone-core types from dist/) before touching drone-agent.

### Phase 2 — scope policy + config loader wiring

Assignee: coder. Files: `drone-agent/src/runtime/provider-scope-policy.ts`, `drone-agent/src/runtime/config.ts`.

10. `enforceProviderScopePolicy`: in the project-layer loop, add — if `layer.config.llm?.modelRoles` has ≥1 entry, push a startup-fatal error mirroring the `providers` wording (name the offending roles, point at user scope/swarm underlays). Update the module header comment.
11. `loadAgentConfig()` (~:190, right after `validateProviders`): call `validateModelRoles(mergedConfig.providers, mergedConfig.llm?.modelRoles)` and append returned strings to the existing `warnings` channel of the load result.
12. Tests: project-scope modelRoles → fatal error listing roles; user-scope + swarm-injected roles merge per-key and validate against combined providers; unknown-provider-ref warning surfaces through load.

### Phase 3 — broker capability

Assignee: coder. File: `drone-agent/src/plugins/llm/index.ts`.

13. Extract the enriched-wrapper construction (~lines 324–346) into an internal `enrichProvider(instance)` helper; `getActiveProvider()` keeps returning `enrichProvider(activeInstance)` (behavior identical).
14. Implement in the capability object (:305):
    ```ts
    resolveModelForRole(role: string): DroneResolvedModelRole {
      const cfg = registration.getConfig();
      const raw = cfg.llm?.modelRoles?.[role];
      if (!raw) return activeFallback();
      const sel = parseModelSelection(raw);
      const inst = sel && instances.get(sel.providerId);
      if (!sel || !inst) { warnOncePerRole(role, raw); return activeFallback(); }
      const providerId = sel.providerId, model = sel.modelLocalId;
      announceOnceIfDifferent(role, providerId, model); // info-once
      return { provider: enrichProvider(inst), providerId, model,
               reasoningLevel: resolveConfiguredReasoningLevel(cfg, sel) };
    }
    ```
    `activeFallback()` = `{ provider: enrichProvider(active), providerId: getActiveProviderId(), model: getModel() }` (no reasoningLevel — preserves exact current caller behavior). Warn-once/info-once via module-closure `Set<string>`s keyed by role (session-lifetime). Use the plugin's existing logger. NEVER mutate activeProviderId/currentModel; no events.
15. Tests (test/plugins/llm/\*): fallback paths (unset role, unknown role name, unknown provider ref, driver not instantiated); statelessness (active id/model unchanged after call); warn-once dedup (two calls → one warn); info-once when different from active; role-resolved provider.chat receives merged parameters/maxOutputTokens (enrichment parity); reasoningLevel returned from model entry then llm-level.
16. Belt-and-suspenders per project principles: `lsp__find_references` on `DroneLlmCapability` + grep for it across `src/` and `test/`; every full mock/implementer must gain `resolveModelForRole` (structural inline types in persona wizard / mcp do NOT break; complete test mocks DO).

### Phase 4 — consumer migrations (each independently shippable)

Assignee: coder (compaction), coder (wizard+mcp). Reviewer pass after each.

17. **Compaction** (`drone-agent/src/plugins/compaction/index.ts`): drop `getProvider`/`getModel` from `RegistrationContext` (:16–19) and from `createCompactionPlugin` deps (:546–567); in `register()`, `registration.request<DroneLlmCapability>('llm')`. In `maybeCompact` (:207ff): `const resolved = llm.resolveModelForRole('summarizer')` fresh each round; replace every `(provider, model)` use — window probe `resolveContextWindow(resolved.provider, resolved.model, …)`, slice sizing, `provider.chat({ model: resolved.model, reasoningLevel: resolved.reasoningLevel, tools: [], … })` (:363). Event messages become `` `Compacting N turn(s) with ${resolved.providerId}/${resolved.model}...` `` (started/completed/failed, always naming the model per D9). Remove now-dead deps wiring in `src/index.tsx` `createLlmGetters` FOR COMPACTION ONLY — context-budget-service keeps its active-session getters (D7). Update all compaction tests' RegistrationContext mocks; add: event names model; window probe hits the ROLE provider (mock returns distinct windows per provider); reasoningLevel threaded.
18. **Persona wizard** (`plugins/persona/wizard.ts` :328–338): request full `DroneLlmCapability`; `const r = llm.resolveModelForRole('wizard')`; `chat({ model: r.model, reasoningLevel: r.reasoningLevel, messages: […] })` using `r.provider`. Missing-capability guard unchanged. Tests: role-unset → active pair (parity snapshot); role-set → mock receives role model.
19. **MCP server-descriptions** (`plugins/mcp/server-description.ts` :85–95): same swap with role `'describer'` (see Interpretation Notes). Cache behavior untouched.
20. Reviewer: verify no caller besides conversation-service still calls `getActiveProvider().chat(` directly (grep `\.chat\(` in src/plugins + src/runtime).

### Phase 5 — conversation service adopts shared helper

Assignee: coder.

21. `runtime/conversation-service.ts` :757–776: replace the inline model-entry lookup with `resolveConfiguredReasoningLevel(config, { providerId: activeProviderId, modelLocalId: currentModel })` INSIDE the existing chain (session override `??` helper `?? undefined`). Behavior-identical refactor; existing tests must stay green.

### Phase 6 — docs

22. `docs/agents/provider-model-config.md`: new "Model roles" section — key path, strict value form, per-key layer merge, project-scope ban, fallback semantics (warn-once), well-known roles table (`summarizer` → compaction summaries; `wizard` → persona creation; `describer` → MCP server descriptions), example:
    ```json
    {
      "llm": {
        "modelRoles": {
          "summarizer": "ollama/llama3.1",
          "wizard": "anthropic/claude-haiku-4-5"
        }
      }
    }
    ```
    Cross-link from the Reasoning section (role-bound models honor their model-entry `reasoningLevel`).

### Phase 7 — final verification (assignee: tester/reviewer)

See Validation criteria below; execute in order.

## Dependencies / order

Strictly sequential: P1 → P2 → P3 → P4a(compaction) → P4b(wizard,mcp) → P5 → P6 → P7. P1 must end with `pnpm -r run build`. P4 items depend only on P3; P4a/b could parallelize across agents after P3. P5 independent of P4 (can run any time after P1).

## Validation criteria

1. `pnpm -r run build` — zero errors.
2. LSP diagnostics — zero errors across all packages (tsc server; pre-existing css warnings in drone-coordinator-ui are out of scope).
3. `pnpm lint` (root) — zero errors (prettier reformats are fine; re-read files after running).
4. `pnpm test` (fast suite) — fully green, including: new drone-core schema/merge/validation/helper tests; scope-policy fatal test; loader warning test; broker fallback/statelessness/dedup/enrichment tests; compaction event-names-model + role-window-probe tests; wizard & mcp role tests.
5. Grep sweeps (project principle): `grep -rn "resolveModelForRole"` shows broker impl + 3 consumers; `grep -rn "\.chat(" src/plugins src/runtime` shows NO direct `getActiveProvider().chat` outside conversation-service/broker/drivers; `grep -rn "getProvider\b" src/plugins/compaction` empty; no leftover `getModel` in compaction context type.
6. Manual smoke (optional, host-permitting): user config with `"llm": {"modelRoles": {"summarizer": "<some-other-pair>"}}`, force `/compact`, observe event naming the role model and transcript summary produced by it.

---

## ✅ COMPLETED 2026-08-25 (commits 4f3ff83..46dc20b on feat/model-role-bindings)

All phases implemented and verified. Full fast suite green (`pnpm test`: 2321 passed), `pnpm -r run build` zero errors, `pnpm lint` zero errors, LSP clean (only pre-existing hint-severity diagnostics in llm/index.ts).

**What shipped:**
- **P1 drone-core**: `DroneLlmConfig.modelRoles`, `WELL_KNOWN_MODEL_ROLES` + `DroneModelRole`, schema (`llm.modelRoles` record with strict `^[^/]+/.+` values), `validateModelRoles` (warn on unknown provider refs + unknown role names), per-key cross-layer merge via `deepMerge.llm.deepMerge.modelRoles`, `resolveConfiguredReasoningLevel` helper, `DroneResolvedModelRole` + `DroneLlmCapability.resolveModelForRole`.
- **P2 scope policy + loader**: project-scope `llm.modelRoles` banned (startup-fatal, mirrors `providers`); `loadAgentConfig` runs `validateModelRoles` and surfaces warnings.
- **P3 broker**: extracted `enrichProvider(instance)` wrapper (shared by active + role providers); `resolveModelForRole` stateless resolution with warn-once-per-role fallback + info-once divergence, `reasoningLevel` from the shared helper. Updated every `DroneLlmCapability` test mock.
- **P4a compaction**: dropped startup-wired `getModel`/`getProvider` deps; resolves `summarizer` per round; summary chat + context-window probe use resolved pair; reasoningLevel threaded; started/completed events name `<providerId>/<model>`; `getStatus` keeps probing session active model (D7). index.tsx no longer passes LLM getters to createBuiltInPlugins.
- **P4b wizard/mcp**: persona wizard uses `resolveModelForRole('wizard')`, mcp server-descriptions use `resolveModelForRole('describer')`, both thread reasoningLevel.
- **P5 conversation service**: adopted shared `resolveConfiguredReasoningLevel` (behavior-identical refactor).
- **P6 docs**: "Model roles" section + scopes update in provider-model-config.md.

**Note**: The two `image_describer`/V2-related memory files (`plan-image-describer`, `image-content-refactor-v2`) live on this branch from the earlier planning session; `plan-image-describer` is the follow-up plan to execute next (prereq = this plan, now complete).
