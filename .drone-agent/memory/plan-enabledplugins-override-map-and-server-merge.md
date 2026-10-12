---
key: plan-enabledplugins-override-map-and-server-merge
tags:
  - plan
  - config
  - config-cascade
  - enabledPlugins
  - deep-merge
  - lsp
  - mcp
  - migration
created: 2026-10-12T21:55:00.000Z
updated: 2026-10-12T21:55:00.000Z
---

# Plan: `enabledPlugins` override map + merge semantics for `lsp.servers` / `mcp.servers`

## Summary and motivation

Three agent-config keys are resolved by **replacement** when the config layers are merged, but they should be resolved by **merge**:

- `enabledPlugins` — currently a whitelist **array** that replaces the inherited list wholesale.
- `lsp.servers` — currently a whole-map replace.
- `mcp.servers` — currently a whole-map replace.

The `enabledPlugins` replace semantics are a known footgun: a project `.drone-agent/config.json` must repeat the entire home plugin list verbatim to add one plugin (documented in the wiki page `drone-agent-project-config-enabledplugins-replace` and in README config examples). The two `servers` maps cannot be extended by a more-local layer — you must restate the whole map.

This plan converts `enabledPlugins` into a **sparse override map** (`Record<string, boolean>`) merged over the built-in default set, and turns `lsp.servers`/`mcp.servers` (plus, for consistency, `providers`/`trustedPlugins`) into **1-level map merges** with `null`-delete semantics, backed by one new `deepMerge` rule kind (`mergeMaps`). A one-time migration rewrites legacy array configs in place with a `.old` backup.

**Scope:** agent config only (`drone-core` + `drone-agent`), disk-file layers. The swarm/beacon underlay allowlist is deliberately unchanged.

## Verified context (code is source of truth)

- Merge spec: `drone-core/src/config-types.ts` `CONFIG_MERGE_SPEC` (~L546), applied by `applyAgentConfigLayer` → `deepMerge` (`drone-core/src/deep-merge.ts`).
- Layer order (low → high): `defaults` → `injectors` (ascending precedence; beacon injector = 75) → `user` → `project`.
- Two merge sites: `loadAgentConfig` (`drone-agent/src/runtime/config.ts:126`) and the config plugin's `rebuild()` (`drone-agent/src/plugins/config/index.ts:~507`).
- Parse: `parseConfigWithSchema` (`drone-core/src/config-schema.ts:424`). The schema has **no** `additionalProperties: false`; unknown keys pass through unchanged.
- `${VAR}`: a **disk** layer throws on an unset var; an **underlay** row is dropped with a one-time warning.
- Default plugin set = `getDefaultEnabledPluginIds(plugins)` = every plugin with `required: true` (only `startup`) or `defaultEnabled: true` (10 total: `startup, mcp, compaction, macros, log, config, llm, subagent, exec, ollama`).
- `enabledPlugins` is **not** in `UNDERLAY_ALLOWLIST` (`drone-core/src/config-keys.ts:100`), so it cannot arrive via the beacon.
- The repo's own `.drone-agent/config.json` does **not** set `enabledPlugins` (self-dogfooding is safe). The user's home config is a 33-entry array that covers all 10 defaults except `startup` (which is `required`/force-added) → migration yields an identical effective set.

## Design decisions (locked)

| # | Decision |
| --- | --- |
| D1 | `enabledPlugins` is `Record<string, boolean>`: `true` = force-enable, `false` = force-disable, absent = no opinion. Merges per-key; highest layer wins. It is a **sparse override over the default base** (`required \|\| defaultEnabled`). Whitelist mode is **removed**; the "`[]` means use defaults" overload is **removed**. |
| D2 | Engine-owned resolution: (1) seed `Set(getDefaultEnabledPluginIds(plugins))`; (2) apply config map (`true` add / `false` delete); (3) re-add `required` plugins; (4) re-add CLI-flag namespaces; (5) validate. `required` and `--plugin`/`--swarm` both **override** an explicit `false`. |
| D3 | Validation: `true` + unknown id → **throw** (`Config enabled unknown plugin: <id>`); `false` + unknown id → **ignore**. |
| D4 | Resolved `DroneAgentConfig.enabledPlugins` stays the **map**; `applyAgentConfigLayer` stays pure. |
| D5 | `enabledPlugins: null` clears all inherited overrides (revert to default base). Entry-level `null` is **not** part of the `enabledPlugins` contract. |
| D6 | `lsp.servers` / `mcp.servers`: shallow map merge, one level; a same-name entry **replaces** the lower layer's entry (like `providers`). |
| D7 | New uniform `deepMerge` rule `mergeMaps`, applied to `enabledPlugins`, `trustedPlugins`, `providers`, `lsp.servers`, `mcp.servers`: shallow merge; a `null` **entry** deletes that entry; a `null` **whole value** clears the map to `{}`. `providers`/`trustedPlugins` thereby gain removal (a local veto of a swarm-distributed provider entry). |
| D8 | The delete path is `lsp.servers.<id>` / `mcp.servers.<id>` (not `lsp.<id>`). |
| D9 | Resolved `lsp.servers` / `mcp.servers` are **always** a `Record` (never `null`; collection-null → `{}`). **Load-bearing**: consumers iterate with `Object.keys`/`Object.entries` (`drone-agent/src/plugins/llm/index.ts:312,429,643,664,799,808,869,891`, `lsp/server.ts:274,442,750`, `mcp/index.ts:353,476`). |
| D10 | `externalPlugins` stays **replace**. |
| D11 | `DronePluginRegistration` gains the engine's existing `listPlugins()`; `persona` switches to it; sweep every registration mock. |
| D12 | `config.set` gains a wildcard key `enabledPlugins.*` (boolean) validated by prefix match; bare `enabledPlugins` still allowed (wholesale map). |
| D13 | `UNDERLAY_ALLOWLIST` **unchanged**. Future (not this plan): swarm distribution of these keys needs a session-level, persona-tied permission (code-execution surface). |
| D14 | Legacy array: schema **tolerant-read** for a deprecation window (`array \| map \| null`); a migration translates `array → {id: true}` and rewrites the file in place with a timestamped `.old` backup + atomic tmp/rename; project scope is rewritten too (unlike `providers`, which are banned at project scope); idempotent. Removing array support later is a documented follow-up, **not** a deliverable. |
| D15 | The migration emits an advisory notice (no roster needed): "`enabledPlugins` was translated from a list to an override map; it now layers over the default plugin set, so default-enabled plugins your list omitted will also load." |

## Execution plan

Ordering: Phase 1 (drone-core) unblocks everything. After Phase 1, run `pnpm -r run build` before working in `drone-agent`, because `drone-agent` resolves `drone-core` from its built `dist/` (`package.json` `"types": "./dist/index.d.ts"`), not from source.

---

### Phase 1 — drone-core foundation

#### Step 1 — Add the `mergeMaps` rule kind to `deepMerge`  · agent: coder · deps: none
File: `drone-core/src/deep-merge.ts`.

Add to `MergeSpec`:
```ts
/**
 * Fields whose value is a named-entry map (e.g. `servers: { github: {...} }`).
 * The layer map is shallow-merged over the base map. A `null` entry deletes
 * that entry from the base; a `null` whole value clears the map to `{}`.
 */
mergeMaps?: string[];
```
Add a branch in `deepMerge` (place it after the `replace`/`replaceNullable` branches, before `mergeArrays`):
```ts
} else if (spec.mergeMaps?.includes(keyStr)) {
  if (value === null) {
    (result as Record<string, unknown>)[keyStr] = {};
  } else if (isRecord(value)) {
    const baseMap = isRecord(base[key])
      ? (base[key] as Record<string, unknown>)
      : {};
    const mergedMap: Record<string, unknown> = { ...baseMap };
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryValue === null) {
        delete mergedMap[entryKey];
      } else if (entryValue !== undefined) {
        mergedMap[entryKey] = entryValue;
      }
    }
    (result as Record<string, unknown>)[keyStr] = mergedMap;
  } else {
    (result as Record<string, unknown>)[keyStr] = value;
  }
}
```
Done when: rule exists; existing `deepMerge` tests still pass.

#### Step 2 — Rewrite `CONFIG_MERGE_SPEC` and the affected types  · agent: coder · deps: 1
File: `drone-core/src/config-types.ts`.

Change the spec to:
```ts
const CONFIG_MERGE_SPEC: MergeSpec = {
  replace: ['externalPlugins', 'systemPrompt'],
  replaceNullable: ['activePersona'],
  mergeMaps: ['enabledPlugins', 'trustedPlugins', 'providers'],
  merge: [
    'ollama', 'compaction', 'memory', 'wakelock', 'checkpoint',
    'herdr', 'log', 'terminal', 'search',
  ],
  deepMerge: {
    openai: { replace: ['models'] },
    anthropic: { replace: ['models'] },
    openrouter: { replace: ['models'] },
    lsp: { mergeMaps: ['servers'] },
    mcp: { mergeMaps: ['servers'] },
    promptFile: { mergeArrays: ['files'] },
    llm: { deepMerge: { modelRoles: {} } },
    session: { deepMerge: { guardrail: { deepMerge: {} }, retry: { deepMerge: {} } } },
    swarm: { deepMerge: { knowledgeSync: {}, sessionImport: {}, memory: {} } },
    tui: { deepMerge: { syntaxHighlighting: { deepMerge: { colors: {} } } } },
  },
};
```

Types:
- `DroneAgentConfig.enabledPlugins: Record<string, boolean>` (was `string[]`).
- `createDefaultAgentConfig()` default: `enabledPlugins: {}`.
- `PartialDroneAgentConfig` (the overlay type) must permit the `null` forms the rules accept. Make the map-valued overlays nullable:
```ts
enabledPlugins: Record<string, boolean> | null;
providers: Record<string, DroneProviderConfig | null> | null;
trustedPlugins: Record<string, 'trusted' | 'untrusted' | null> | null;
lsp: Partial<Omit<DroneLspConfig, 'servers'>> & {
  servers?: Record<string, DroneLspServerConfig | null> | null;
};
mcp: Partial<Omit<DroneMcpConfig, 'servers'>> & {
  servers?: Record<string, DroneMcpServerConfig | null> | null;
};
```
(Adjust the exact intersections to satisfy the TypeScript compiler; the `as DroneAgentConfig` cast in `applyAgentConfigLayer` absorbs the generic variance — see ADR 095.)

Done when: typecheck passes in `drone-core`.

#### Step 3 — Widen the parse schema  · agent: coder · deps: 2
File: `drone-core/src/config-schema.ts`.

- `enabledPlugins`: `Type.Optional(Type.Union([Type.Array(Type.String()), Type.Record(Type.String(), Type.Boolean()), Type.Null()]))`.
- `providers`: allow `null` values and whole-null: `Type.Union([Type.Record(Type.String(), Type.Union([DroneProviderSchema, Type.Null()])), Type.Null()])`.
- `trustedPlugins`: value `Type.Union([Type.Literal('trusted'), Type.Literal('untrusted'), Type.Null()])`, whole-null allowed.
- `lsp.servers`: `Type.Union([Type.Record(Type.String(), Type.Union([LspServerConfigSchema, Type.Null()])), Type.Null()])`.
- `mcp.servers`: same with `McpServerConfigSchema`.

Done when: `{ "mcp": { "servers": null } }`, `{ "lsp": { "servers": { "ts": null } } }`, `{ "enabledPlugins": null }`, `{ "enabledPlugins": ["llm"] }` and `{ "enabledPlugins": { "llm": true } }` all pass `Value.Check`.

#### Step 4 — Normalize the legacy array at parse time  · agent: coder · deps: 3
File: `drone-core/src/config-schema.ts`.

Add, and call it inside `parseConfigWithSchema` after `transformEnvVars`, so that **every layer carries the map shape before merging**:
```ts
function normalizeEnabledPlugins(decoded: Record<string, unknown>): void {
  const value = decoded.enabledPlugins;
  if (Array.isArray(value)) {
    decoded.enabledPlugins = Object.fromEntries(value.map(id => [id, true]));
  }
}
```
Change `parseConfigWithSchema`'s return type to `PartialDroneAgentConfig` (the canonical map-only overlay shape) so downstream code sees `enabledPlugins: Record<string, boolean> | null`. Keep the `PartialDroneAgentConfigDecoded` alias if it is still referenced.

Done when: a layer parsed from `["llm","echo"]` yields `{ enabledPlugins: { llm: true, echo: true } }`.

#### Step 4b — Build drone-core  · agent: coder · deps: 1–4
Run `pnpm -r run build`. Done when: zero errors.

---

### Phase 2 — engine resolution and registration surface

#### Step 5 — Rewrite `resolveEnabledPluginIds` + validation  · agent: coder · deps: 4b
File: `drone-agent/src/runtime/plugin-engine.ts`.

```ts
export function resolveEnabledPluginIds(
  plugins: DronePlugin[],
  config: DroneAgentConfig,
  pluginFlags: Record<string, string | true>
): Set<string> {
  const enabledPluginIds = new Set(getDefaultEnabledPluginIds(plugins));

  for (const [pluginId, on] of Object.entries(config.enabledPlugins)) {
    if (on === true) enabledPluginIds.add(pluginId);
    else if (on === false) enabledPluginIds.delete(pluginId);
  }

  for (const plugin of plugins) {
    if (plugin.metadata.required) enabledPluginIds.add(plugin.metadata.id);
  }

  for (const namespace of pluginFlagNamespaces(pluginFlags)) {
    if (pluginMapIds(plugins).has(namespace)) enabledPluginIds.add(namespace);
  }

  return enabledPluginIds;
}

function validateKnownEnabledPlugins(
  enabledOverrides: Record<string, boolean>,
  pluginMap: Map<string, DronePlugin>
): void {
  for (const [pluginId, on] of Object.entries(enabledOverrides)) {
    if (on === true && !pluginMap.has(pluginId)) {
      throw new Error(`Config enabled unknown plugin: ${pluginId}`);
    }
  }
}
```
Update the call site to pass `config.enabledPlugins` to `validateKnownEnabledPlugins`.

Done when: resolution order matches D2; `true`+unknown throws, `false`+unknown is silent.

#### Step 6 — Expose `listPlugins()` on the registration  · agent: coder · deps: 5
Files: `drone-core/src/plugin-system.ts`, `drone-agent/src/runtime/plugin-engine.ts`.

- Move the `DronePluginStatus` type (`{ id, name, enabled, required, defaultEnabled }`, currently in `plugin-engine.ts:50`) into `drone-core` (export from `plugin-system.ts`) and re-export.
- Add to `DronePluginRegistration`:
```ts
listPlugins: () => import('./plugin-system.js').DronePluginStatus[];
```
- In `createDronePluginEngine`, extract the existing `listPlugins` body (`plugins.map(...)`, `plugin-engine.ts:~1240`) into a local `listPluginStatuses` and wire it both into the engine object and into the `registration` object literal (next to `listMountedTools`).

Done when: a plugin can call `registration.listPlugins()` and read resolved `enabled`.

#### Step 7 — Switch `persona` to `listPlugins()`  · agent: coder · deps: 6
File: `drone-agent/src/plugins/persona/index.ts:389`.
```ts
const swarmEnabled = registration
  .listPlugins()
  .some(p => p.id === 'swarm' && p.enabled);
```
Done when: persona compiles and its "not found" branch still selects the swarm vs non-swarm message.

---

### Phase 3 — writers and entry points

#### Step 8 — `--plugin` / `--swarm` merge in `index.tsx`  · agent: coder · deps: 4b
File: `drone-agent/src/index.tsx` (~L166–193). Replace the two array blocks:
```ts
for (const id of invocation.options.pluginOverrides) {
  resolvedConfig.config.enabledPlugins[id] = true;
}
if (invocation.options.swarm) {
  resolvedConfig.config.enabledPlugins['swarm'] = true;
}
```
Remove now-dead `getDefaultEnabledPluginIds` usage **only if** it becomes unused (Step 9 drops the other call site); let lint/typecheck confirm. Note: CLI overrides deliberately override an explicit `false` (D2).

#### Step 9 — `first-run` wizard writes a map  · agent: coder · deps: 8
File: `drone-agent/src/first-run.tsx`.
```ts
const withProviderEnabled = (providerId: string): Record<string, boolean> => ({
  [providerId]: true,
});
```
All four call sites (`ollama`/`openrouter`/`openai`/`anthropic`) stay as-is and now write `{ "<provider>": true }`. If the `defaultEnabledPlugins` parameter is now unused, drop it and update the call site in `index.tsx` (~L475) and the first-run tests. Run lint/typecheck to confirm no dead parameter or import remains.

#### Step 10 — `bootstrap` writes per-key overrides  · agent: coder · deps: 4b
File: `drone-agent/src/plugins/bootstrap/index.ts` (~L140–205). Replace the array read-modify-write:
```ts
const configCap = ctx.requestCapability<DroneConfigCapability>('config');
if (configCap) {
  for (const pluginId of selectedPluginIds) {
    await configCap.setValue('project', `enabledPlugins.${pluginId}`, true);
  }
} else {
  const enabledPlugins = Object.fromEntries(
    selectedPluginIds.map(id => [id, true])
  );
  // fallback: write config file directly with { enabledPlugins }
}
```
Relies on Step 11's wildcard key. Keep the `ctx.enablePlugin` loop and the `toolResult`; update the summary text if it mentions the list form.

#### Step 11 — `config.set` accepts `enabledPlugins.*`  · agent: coder · deps: 4b
File: `drone-agent/src/plugins/config/index.ts`.
```ts
const ENABLED_PLUGINS_PREFIX = 'enabledPlugins.';

function validateConfigKey(key: string): void {
  if (KNOWN_CONFIG_KEYS.includes(key)) return;
  if (key.startsWith(ENABLED_PLUGINS_PREFIX) && key.length > ENABLED_PLUGINS_PREFIX.length) {
    return;
  }
  throw new Error(
    `Unknown config key "${key}". Valid keys: ${KNOWN_CONFIG_KEYS.join(', ')}`
  );
}
```
Also widen the `config.set` tool input schema's `value` to permit a boolean (currently `type: 'object'`), e.g. drop the restrictive `type` and describe it. `enabledPlugins` is already in `KNOWN_CONFIG_KEYS`. Note: `collectProvenance` only tracks dotted leaf keys, so per-id provenance is out of scope.

---

### Phase 4 — migration and fixture

#### Step 12 — Legacy-array migration  · agent: coder · deps: 4b
New file: `drone-agent/src/runtime/enabled-plugins-migration.ts` (mirror `provider-migration.ts`).

```ts
export type EnabledPluginsMigrateResult = {
  raw: Record<string, unknown>;
  changed: boolean;
};

export function migrateEnabledPluginsRaw(
  raw: Record<string, unknown>
): EnabledPluginsMigrateResult {
  const value = raw.enabledPlugins;
  if (!Array.isArray(value)) return { raw, changed: false };
  const migrated = { ...raw };
  migrated.enabledPlugins = Object.fromEntries(
    (value as string[]).map(id => [id, true])
  );
  return { raw: migrated, changed: true };
}
```
New file: `drone-agent/src/runtime/enabled-plugins-migration-persist.ts` (mirror `provider-migration-persist.ts`): for each file-backed layer with `scope` `user` or `project`, read the raw JSON; if `enabledPlugins` is an array, (a) copy the file to `<path>.<timestamp>.old`, (b) write the migrated object via tmp file + `rename`, (c) record `writtenPaths`/`backupPaths`; return an advisory notice string per D15. Unlike the providers migration, **do not** skip project scope.

Wire into `loadAgentConfig` (`drone-agent/src/runtime/config.ts`, near L174–181): call the persistence pass over `layers.map(l => ({ scope, path }))`, and append its notice to the returned `warnings` array.

Done when: an array-form config on disk is rewritten to map form exactly once, with a `.old` backup and an advisory warning; a second run is a no-op.

#### Step 13 — Update the baked integration fixture  · agent: coder · deps: 4b
File: `docker/test-runner.Dockerfile:31`. Change `"enabledPlugins":["llm","echo"]` to `"enabledPlugins":{"echo":true}` (`llm` is default-on). Update `drone-agent/test/test-runner-baked-config.test.ts` if it asserts the enabled list.

---

### Phase 5 — documentation and ADR

#### Step 14 — ADR + doc updates  · agent: coder · deps: 5–13
- Write `docs/adr/251-enabledplugins-override-map-and-server-merge.md` (next free number is 251) recording D1–D15, including the future follow-up (remove array support; swarm distribution gated behind a persona-tied permission).
- Update `AGENTS.md` (config-system section), `README.md` (all config examples that show an `enabledPlugins` array), `docs/agents/dynamic-plugin-enabling.md` (`--plugin` now writes override entries), `docs/adr/005-config-cascade.md` (its "except `enabledPlugins`, additive" line is now wrong), `docs/adr/095-config-deep-merge-refactor.md` (add the `mergeMaps` rule kind).
- Reminder: prettier formats embedded JSON in markdown fences — arrays/lines >80 chars get reflowed.

---

### Phase 6 — tests

#### Step 15 — drone-core unit tests  · agent: tester · deps: 4b
File: `drone-core/test/index.test.ts`. Add `mergeMaps` cases: shallow merge of two maps; `null` entry deletes; `null` whole value → `{}`; non-map value passthrough; immutability of base. Add `applyAgentConfigLayer` cases: `enabledPlugins` maps merge per-key; `lsp.servers`/`mcp.servers` merge and delete; `providers`/`trustedPlugins` entry delete. Add `parseConfigWithSchema` cases: array→map normalization; `null` accepted for `enabledPlugins`, `lsp.servers`, `mcp.servers`, and their entries.

#### Step 16 — drone-agent tests + registration-mock sweep  · agent: tester · deps: 5–12
- Rewrite the pinned array-semantics tests in `drone-agent/test/plugin-engine.test.ts` (~L63–163) to the map model, including: default base when the map is `{}`; `true` enables an opt-in plugin; `false` disables a default-enabled plugin; `required` and CLI flags override `false`; `true`+unknown throws; `false`+unknown is ignored.
- Sweep **every** test that sets `enabledPlugins: [...]` as config (≈20 files: `beancounter`, `bootstrap`, `config-allowlist-regression`, `first-run`, `log-plugin`, `macros`, `mcp`, `owned-skill-writers`, `persona-cli-flag`, `persona-owned-skills`, `persona-premount`, `persona-select`, `pretty-tool-output-phase-2`, `prompt-file`, `self-improvement/*`, `session-param-events`, `skills-plugin`, `skills-render-body`, `terminal`, `todo-sidebar`, `wakelock-plugin`) → `enabledPlugins: { <id>: true, ... }`. Use LSP find-references on `enabledPlugins` plus a grep cross-check.
- Add every new `DronePluginRegistration` mock method `listPlugins` (mechanical sweep; a missed mock breaks typecheck).
- Add tests for `config.set` `enabledPlugins.<id>` writes and for the migration module (in-place rewrite, `.old` backup, idempotency, advisory notice, project-scope rewrite).

#### Step 17 — fixture/regression tests  · agent: tester · deps: 13
- Confirm `test-runner-baked-config.test.ts` parses the new `{"echo":true}` fixture.
- Add a regression test asserting the user's home-config migration yields an unchanged effective plugin set (no gained plugins).

---

### Phase 7 — verification

#### Step 18 — Review  · agent: reviewer · deps: 1–17
Independent review of the diff against D1–D15; specifically check: no surviving `null` in resolved `lsp.servers`/`mcp.servers`; validation throws only for `true`+unknown; every `Object.entries(...servers)` consumer is safe; no stale array-form write path remains.

#### Step 19 — Final validation against the criteria below  · agent: coder · deps: 18
Run the full validation checklist and fix anything red. This is the last step.

---

## Validation criteria

All of the following must pass. **The final step is to check the work against this list.**

1. **LSP clean** — `lsp.get_diagnostics` reports no errors or warnings, workspace-wide and for every touched file.
2. **Build** — `pnpm -r run build` completes with zero errors.
3. **Lint** — `pnpm run lint` (ESLint + Prettier) completes with zero errors. Re-read all files after linting, since Prettier rewrites them.
4. **Fast tests** — `pnpm run test` is green.
5. **Integration tests** — `pnpm test:integration` is green, including `test-runner-baked-config.test.ts` against the updated fixture.
6. **New behavior is covered** — tests exist and pass for: the `mergeMaps` rule (merge / entry-delete / collection-null / passthrough / immutability); `enabledPlugins` resolution (default base, `true`, `false`, `required` override, CLI override, `true`+unknown throws, `false`+unknown ignored); schema tolerance (array, map, `null`, null entries); array→map parse normalization; migration (in-place rewrite, `.old` backup, idempotency, advisory notice, project-scope rewrite); `config.set` `enabledPlugins.<id>`.
7. **No dead code** — no unused imports, parameters, or helpers remain (e.g. `getDefaultEnabledPluginIds` import in `index.tsx` if both call sites are gone; the `defaultEnabledPlugins` parameter if dropped from `runFirstRunSetup`).
8. **Migration verified end-to-end** — starting the agent against the user's home config rewrites it to map form once, leaves a timestamped `.old` backup, prints the advisory notice, and produces an identical effective plugin set.
9. **Docs** — ADR 251 exists and matches the implementation; `AGENTS.md`, `README.md`, `docs/adr/005-config-cascade.md`, `docs/adr/095-config-deep-merge-refactor.md`, and `docs/agents/dynamic-plugin-enabling.md` are updated and lint-clean.
10. **Memory/insights committed** — per `AGENTS.md`, any uncommitted memories, skills, insights, or principles are checked in on the feature branch (never on `main`).

## Explicitly out of scope

- Removing legacy array support (documented follow-up; the schema stays tolerant for a deprecation window).
- Adding `enabledPlugins.*` / `lsp.servers.*` / `mcp.servers.*` to `UNDERLAY_ALLOWLIST` (future; needs a session-level, persona-tied permission).
- Per-id provenance in `config.get`.
- Deep (field-level) merge of individual `servers` entries (merge is 1-level by design).
