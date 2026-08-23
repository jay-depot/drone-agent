---
key: plan-context-window-fixes-four-defects
tags:
  - plan
  - ready-for-execution
  - llm
  - providers
  - context-window
created: 2026-08-23T20:15:26.549Z
updated: 2026-08-23T20:55:48.162Z
---

# PLAN: Context-window detection fixes — four defects (2026-08-23, READY FOR EXECUTION)

Branch: cut `feat/context-window-detection` from `feat/provider-model-config` HEAD (c729dea). Companion memories: `context-window-detection-findings` (evidence), `llm-provider-future-work` (deferred items).

## Feature summary

Decision 156 moved context-window resolution broker-side (declared ⊕ discovered catalog > driver probe > session fallback), but three gaps remain: (1) openai-family discovery discards OpenRouter's per-model metadata so undeclared models collapse to the 32768 fallback; (2) ollama LOCAL models report GGUF training max instead of the enforced runtime window (cloud models are correct — excluded); (3) decision 156's provenance log line lands nowhere durable, making wrong denominators undiagnosable; plus (4) `/model <pick>` persistence is broken at runtime because `llm.active` is missing from config's static key allowlist. Fix approach for (2) locked as OPTION A (additive probe-contract widening; all window policy stays in the ollama driver).

## Locked design decisions

- **Option A**: `DroneLlmProvider.getContextWindowInfo` input gains optional `parameters` + `extra`; broker forwards merged effective parameters. Rejected B (driver re-reads config: duplicates broker resolution, blind to future session knobs) and E (schema-hint short-circuit: fragments policy, mutes warnings).
- **Ollama local precedence**: /api/ps.context_length (when resident — enforcement truth, catches VRAM clamping; NEVER triggers a load) > effective request numCtx (via existing buildOllamaOptions so parameters.numCtx AND extra.num_ctx both work) > Modelfile num_ctx (parse show.parameters string) > DRIVER PIN **16384** (plain constant, no config surface). Advertised GGUF length excluded for locals; exceeding it WARNS, never clamps (rope scaling legitimate). Fallback when /api/show itself fails: 32768/'default' (unchanged).
- **Cloud detection**: cloud := !show.modelfile && !show.parameters (verified signal: locals carry both, clouds neither) OR name ends ':cloud'/'-cloud'.
- **Source union NOT widened**; add OPTIONAL `detail?: string` field to DroneContextWindowInfo instead (driver sets human-readable slot provenance: 'ps-resident' | 'request num_ctx' | 'modelfile num_ctx' | 'driver pin 16384' | 'advertised (cloud)'). Broker spreads probed results through unchanged; metadata/config paths never set it (keeps exact-shape toEqual tests valid).
- **Discovery stops poisoning the catalog**: discoverOllamaModels sets contextWindow ONLY for cloud models (A5 trap: catalog beats probe, so publishing locals' GGUF max would dead-code the entire fix). Blank-in-listings for locals accepted by user.
- **OpenRouter enrichment is take-if-present** in shared openai-driver.ts — vanilla OpenAI (/models bare ids) unaffected; gateways (LM Studio/vLLM/LiteLLM) benefit.
- **autoImport punted** to llm-provider-future-work Soon #5; docs corrected to inert-status factual.
- **Provenance surfaces via /context command** (option a); status-bar warn-tint deferred until proven needed.
- User facts baked in: ollama REJECTS over-context requests with errors (over-reporting is the dangerous direction); ollama default num_ctx is VRAM-probed, not fixed 4096 (hence pin + ps slots).

## Implementation steps

### Phase 1 — Contract widening (drone-core)

File: `drone-core/src/provider-types.ts`

1. Widen probe input: `getContextWindowInfo?: (input: { model: string; parameters?: Record<string, unknown>; extra?: Record<string, unknown> }) => Promise<DroneContextWindowInfo | null>` — JSDoc: additive broker-forwarded fields, drivers may ignore.
2. Add optional `detail?: string` to `DroneContextWindowInfo` (JSDoc: driver-resolved slot provenance for /context; consumers must not switch on it).
3. `pnpm -r run build` IMMEDIATELY (dependents resolve types from dist/, not source — known trap).
4. Sweep: LSP find_references on getContextWindowInfo + grep belt-and-suspenders. Known exact-args assertions needing updates: `drone-agent/test/llm-context-window.test.ts` (`toHaveBeenCalledWith({ model: 'llama3.1' })` → expect.objectContaining or add forwarded fields), `makeDriverWithProbe` fixture signature. Optional fields mean implementations compile untouched.
   Tests: typecheck-only phase; assertion updates land with their files.

### Phase 2 — Broker forwarding

File: `drone-agent/src/plugins/llm/index.ts` (resolveActiveContextWindow, ~line 190)
In the no-metadata branch, replace bare probe call:

```ts
const effective = mergeEffectiveParameters(instance.providerId, fullId);
const probed = await instance.provider.getContextWindowInfo?.({
  model: metadata.model ?? localModel,
  parameters: effective,
  extra: registration.getConfig().providers[instance.providerId]?.extra ?? {},
});
```

(mirrors exactly what the next chat() will send — single source of truth). Provenance log line unchanged.
Tests: extend `test/llm-context-window.test.ts` — probe receives forwarded parameters when model declares `parameters.numCtx`; probe receives provider-level `extra`.

### Phase 3 — Ollama driver rework

Files: `drone-agent/src/plugins/ollama/driver.ts`, `plugins/ollama/index.ts`

1. Exported pure helpers (unit-test targets):
   - `parseModelfileNumCtx(parameters?: string): number | null` — whitespace-separated `num_ctx <n>` line parse.
   - `isCloudModel(show, modelName): boolean` — per locked rule above.
   - `OLLAMA_LOCAL_NUM_CTX_PIN = 16384` (exported const).
2. PS probe: `fetchPsContextLength(host, apiKey, model): Promise<number | null>` — GET {host}/api/ps (prefer client.ps() if the installed ollama lib exposes it; else minimal fetch with same auth header), match resident entry by name, read context_length. Catch-all → null. MUST NOT trigger a load.
3. Probe rewrite (createOllamaProvider gains optional logger arg; ollama/index.ts passes registration.logger; warn-once Set per model in closure):
   - try show → cloud? return advertised (detail: 'advertised (cloud)') : local chain → ps slot (detail 'ps-resident') > effective numCtx via `buildOllamaOptions({ parameters, extra }).num_ctx` (detail 'request num_ctx') > Modelfile (detail 'modelfile num_ctx') > PIN (detail 'driver pin 16384'). All source:'provider'.
   - Warn once when advertised exists and resolved > advertised (rope-scaling note in message).
4. Discovery fix: in `discoverOllamaModels`, set `discovered.contextWindow` only when `isCloudModel(...)`; capability flags unchanged for all models.
   Tests (`test/ollama.test.ts` + new): parseModelfileNumCtx cases incl. multi-line/absent; isCloudModel truth table (local w/ modelfile, w/ params only, cloud w/ neither, suffix variants); local precedence chain unit tests incl. ps-slot win over request param; discovery emits NO contextWindow for locals (the A5-trap regression test — THE critical one); probe warns once on exceed.

### Phase 4 — OpenAI-family discovery enrichment

File: `drone-agent/src/plugins/openai/openai-driver.ts`
Export pure mapper + use in discoverModels:

```ts
export function mapDiscoveredModel(entry: {
  id: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  architecture?: { input_modalities?: string[] };
}): DiscoveredModel;
```

context_length→contextWindow; positive-numeric max_completion_tokens→maxOutputTokens (nullable in real payload); input_modalities includes 'image'→hasVision:true. Everything else omitted (take-if-present).
Tests: fixture built from captured live OpenRouter payload shape (meta/muse-spark-like entry + bare-id OpenAI-style entry asserting omission).

### Phase 5 — /context command

New file: `drone-agent/src/plugins/llm/context-command.ts` (keeps index.ts under 750-line discipline); registered alongside /model, /reasoning.
Output: active `<providerId>/<model>`; resolved window + source + detail (via getActiveProvider().getContextWindowInfo); estimated usage % via ctx.conversation.getEstimatedContextUsagePercent(); responseReserveTokens; graceful error when no active provider. Help snippet registered.
Tests: mocked slash ctx asserting source+detail rendered; no-provider error path.

### Phase 6 — Allowlist fix

File: `drone-agent/src/plugins/config/index.ts` (KNOWN_CONFIG_KEYS ~line 91)
Add `'llm.active'`, `'llm.reasoningLevel'`.
Regression test through the REAL write path: vi.mock os.homedir → tmp dir; capability.setValue('user','llm.active','openrouter/x/y'); assert file written, JSON parses, value present; second write idempotent. (This pins the bug the user hit twice.)
Note: dynamic `providers.<id>.models.<key>` paths remain unsupported (static allowlist) — intentional, blocker recorded in backlog item #5.

### Phase 7 — Docs corrections (inert-status factual per AGENTS.md rules)

- `docs/agents/provider-model-config.md`: autoImport section → "accepted in schema and parsed into provider entries; no behavioral wiring yet — discovered-stub persistence is planned."
- Wiki sync (same correction): `entities/DroneAgentConfig.md`, `concepts/provider-model-selection.md`.
- Mention /context in provider-model-config.md metadata paragraph (provenance now inspectable).

### Phase 8 — Validation gate (final step)

1. `pnpm -r run build` → 0 errors (run BEFORE dependent typechecks after any drone-core edit).
2. `pnpm typecheck` workspace-wide → 0.
3. LSP diagnostics clean on every touched file.
4. `pnpm -r run lint` → clean (prettier will reformat: RE-READ all edited files before further modification).
5. `pnpm -r run test` fast suite → 0 failures.
6. Cross-cutting sweep proof: find_references + grep for getContextWindowInfo — no stale exact-args mocks anywhere (implementers/consumers/test mocks, per shared-interface principle).
7. Manual acceptance (user-assisted): fresh TUI session → /context on (i) declared openrouter model → source metadata; (ii) UNDECLARED discovered openrouter model → source metadata with enriched window (not 32768); (iii) ollama cloud → source provider, detail 'advertised (cloud)'; (iv) ollama local unconstrained → detail 'driver pin 16384'; (v) /model <pick> persists WITHOUT the swallowed-warning (verify ~/.drone-agent/config.json gained llm.active). Status bar % sane on fresh sessions.

## Commit strategy

Phases 1+2 (contract+forwarding), 3, 4, 5, 6, 7 as separate commits; .drone-agent memory/wiki changes checked in per AGENTS.md self-dogfooding rule (never to main directly).

## Out of scope (recorded, deliberately deferred)

- Secrets storage/rotation — waits for user's OS credential-store work.
- autoImport wiring — backlog Soon #5 (allowlist blocker noted).
- Status-bar warn-tint for distrustable sources — revisit only if wrong-sourced windows recur.
- /api/ps as validation telemetry beyond the resident-truth slot.
