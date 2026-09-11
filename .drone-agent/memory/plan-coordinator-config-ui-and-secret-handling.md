---
key: plan-coordinator-config-ui-and-secret-handling
tags:
  - plan
  - config
  - coordinator
  - ui
  - secret-handling
  - underlay
  - ready
created: 2026-09-11T01:41:33.900Z
updated: 2026-09-11T01:41:33.900Z
---

# PLAN B — Coordinator Config Pipeline + UI + Secret Handling

Status: READY FOR EXECUTION. Branch: feat/coordinator-config-ui-and-secure-storage. DEPENDS ON Plan A (plan-coordinator-trust-hardening): Plan A's server-side status enforcement is what makes distributing secrets safe.

## Feature summary
A dedicated coordinator UI page (/config) to manage a GLOBAL, ALLOWLISTED set of config entries (e.g. LLM provider entries w/ API keys, llm.active, compaction settings) distributed coordinator→beacon→agent and applied as a config underlay at agent session start. API keys: plaintext at rest (explicitly DEFERRED: encryption-at-rest is a documented follow-up, user-approved), masked on read, write-only on edit, ${VAR} templates preserved (receiver-side interpolation). Locked decisions Q5–Q10: (Q5) global allowlisted KV store, not per-beacon/raw-JSON; (Q6) plaintext+masked+write-only; (Q7) canonical allowlist moved into drone-core, narrow MVP; (Q8) coordinator = source of truth, beacon PULLS on existing 5-min sync, direction strictly coordinator→beacon→agent; (Q9) applies at agent session start via rebuild(); (Q10) dedicated /config page modeled on personas.tsx.

## Critical verified context
The "existing infrastructure" is DEAD plumbing: DroneConfigCapability.rebuild() declared (drone-core/src/capabilities.ts:113-117) but NEVER implemented (config plugin type omits it); nothing calls inject()/getInjectors()/rebuild() anywhere (grep-verified); runtime loader (runtime/config.ts loadAgentConfig:126-222) merges default→user→project ONLY. Only injector = BeaconConfigInjector (swarm/config.ts:20-56, precedence 75) — registered (swarm/index.ts:254), unregistered (heartbeat.ts:44-45), NEVER invoked (hooks.ts:270-273 underscore params). Beacon has beacon_config table + CRUD (beacon/db/config.ts, routes/config.ts), scope 'swarm' column DEAD; triggerCoordinatorSync (beacon/routes/context.ts:99-167) syncs personas/skills/knowledge/fragments only. Coordinator: NO config table, NO /config route. CONFIG_MERGE_SPEC + applyAgentConfigLayer at drone-core/config-types.ts:518,778. Provider apiKey = literal OR ${VAR} (drone-core/provider-config-types.ts:39-47). KNOWN_CONFIG_KEYS allowlist currently in drone-agent/src/plugins/config/index.ts:117-216.

## Steps (executor: code persona; atomic + testable)

### B1 — drone-core: canonical config-key allowlist
- NEW drone-core/src/config-keys.ts: export `KNOWN_CONFIG_KEYS` (moved verbatim from drone-agent/src/plugins/config/index.ts:117-216) + `UNDERLAY_ALLOWLIST` (narrow MVP): any `providers.<id>` (whole-entry unit), `llm.active`, `llm.reasoningLevel`, `compaction.enabled`, `compaction.strategy`, `session.guardrail.*`. Re-export from drone-core/src/index.ts.
- drone-agent/src/plugins/config/index.ts: import KNOWN_CONFIG_KEYS from drone-core (delete local copy).
- **RUN `pnpm -r run build` immediately after the drone-core edit** (dependent packages resolve from dist/, per project principle) before LSP/typecheck.

### B2 — Coordinator storage: coordinator_config table
- drone-coordinator/src/db/init.ts:
```sql
CREATE TABLE IF NOT EXISTS coordinator_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- JSON string
  secret INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
- NEW drone-coordinator/src/db/config.ts: listCoordinatorConfig(), getCoordinatorConfig(key), upsertCoordinatorConfig({key,value,secret,description}), deleteCoordinatorConfig(key). Export via db/index.ts.

### B3 — Coordinator API routes
- NEW drone-coordinator/src/routes/config.ts; register in routes/index.ts (inside /api prefix).
  - GET /api/config — list; secret=1 → mask value (mask apiKey inside provider JSON: `••••` + last 4; scalar → `••••` + last 4). Return {key, value(masked), secret, description, updatedAt}.
  - GET /api/config/:key — single (masked if secret).
  - PUT /api/config/:key — body {value, secret?, description?}; validate key against UNDERLAY_ALLOWLIST (400 + valid patterns list on rejection); store JSON string; return masked entry.
  - DELETE /api/config/:key — 404 if absent.
- All /api → web-port web-auth protected; primary-port mTLS approved-only (Plan A).

### B4 — Beacon pulls coordinator config (source of truth = coordinator)
- drone-beacon/coordinator-client.ts: `getCoordinatorConfig(): Promise<CoordinatorConfigEntry[]>` via cfetch GET `${baseUrl}/api/config` (trust-gated like fetchPersonas).
- drone-beacon/src/db/init.ts: migrate beacon_config PK `key` → composite PRIMARY KEY (scope, key): recreate-table migration (create beacon_config_new w/ composite PK, copy local rows, drop old, rename). Low risk (scope column currently unused in prod); existing db tests updated. NOTE: use file__write/mkdir carefully; run `pnpm build` for drone-swarm-common if types move.
- drone-beacon/src/db/config.ts: `replaceSwarmConfig(entries)`: DELETE WHERE scope='swarm', INSERT coordinator entries as scope='swarm'. Keep local rows + existing accessors.
- drone-beacon/routes/context.ts triggerCoordinatorSync: after fragments, pull + replaceSwarmConfig (mirrors persona/skill/fragment sync).
- drone-beacon/routes/config.ts GET /config: return MERGED view — one row per key, LOCAL wins over swarm (query all, dedupe by key keeping local). CRITICAL: the agent injector loops `cachedConfig[entry.key] = JSON.parse(entry.value)` — two rows per key would silently last-write-wins; must pre-merge.

### B5 — Agent: implement rebuild() + apply underlays at session start
- drone-agent/src/plugins/config/index.ts: add `rebuild` to offered capability AND to the local DroneConfigCapability type: `let cfg = createDefaultAgentConfig(); for (const inj of getInjectors()) cfg = applyAgentConfigLayer(cfg, await inj.inject()); return cfg;` (injectors already sorted ascending = lower precedence first = underlay = most-local-wins).
- drone-agent/src/plugins/swarm/hooks.ts: `_configCap`/`_beaconConfigInjector` currently unused (lines ~270-273). Wire onSessionStart: call configCap.rebuild() and make the ENGINE's resolved config for the session reflect the underlay (providers / llm.active must be visible to budget service + llm broker before first turn). **HIGHEST-RISK SEAM**: locate the engine config getter (search getConfig() consumers; runtime/plugin-engine.ts) and either add an engine refresh path or thread rebuild()'s result where budget/llm read config. Add LSP-find-references sweep. Fallback (documented, NOT acceptable for MVP): underlay never applies — so engine-refresh is required.
- drone-agent/src/plugins/swarm/config.ts: BeaconConfigInjector unchanged (precedence 75, GET {beacon}/config) — it now carries coordinator-merged values. NO separate CoordinatorConfigInjector (merged view rides beacon underlay per locked Q8). Update docstrings; adjust precedence note in capabilities.ts comment + AGENTS.md (B7).
- onSessionStart timing: fires before first user message → broker activateProvider reads refreshed config → OK if refresh done in the hook.

### B6 — Coordinator UI: /config page
- drone-coordinator-ui/src/App.tsx: nav item `{ to: '/config', label: 'Config', icon: '▤' }` (check icon collisions) + route `<Route path="/config" element={<ConfigPage />} />`.
- NEW drone-coordinator-ui/src/pages/config.tsx (model on personas.tsx): table (Key mono / Value preview masked `••••`+last4 for secret else ~60 chars / Secret badge / Updated / Edit / Delete); Add/Edit dialog (Key disabled on edit; Secret checkbox on create; Value textarea — provider entries are JSON; on edit-of-secret: "leave empty to keep current" sentinel → omit value from PUT); Delete confirmation dialog; persistent amber warning banner: "Configuration (including LLM provider API keys) is distributed to APPROVED beacons only. Verify each beacon before approving. Secrets are stored on this coordinator and never shown in full after saving." Use useAuthenticatedFetch + useToast + ErrorBanner + extractApiError/networkErrorMessage.
- drone-coordinator-ui/src/lib/types.ts: `CoordinatorConfigEntry { key, value, secret: boolean, description?: string|null, updatedAt: number }`.
- Test drone-coordinator-ui/src/pages/config.test.tsx: list masks secret; add dialog PUTs; edit-empty-keeps-current omits value; delete DELETEs; error path toasts.

### B7 — Docs
- docs/agents/swarm-plugin.md "LLM provider config via swarm underlays": update to describe coordinator UI /api/config (global allowlist: providers.*, llm.active, llm.reasoningLevel, compaction.*, session.guardrail.*), beacon pull on 5-min sync → scope='swarm', merged /config (beacon-local wins), applied at agent session start, secrets masked + write-only, ${VAR} preserved, ~5-min propagation, encryption-at-rest = documented follow-up.
- AGENTS.md ~line 106 config-cascade sentence: rewrite "Coordinator (50) → Beacon (75)" to reflect reality (coordinator values ride the beacon merged underlay at precedence 75; beacon-local wins within it; applied at session start) — no longer aspirational.

### B8 — Tests (coordinator, beacon, agent)
- drone-coordinator/test/: config db CRUD; route allowlist validation (unknown key 400, providers.foo accepted); secret masking on GET; PUT upsert.
- drone-beacon/test/: composite-PK migration; replaceSwarmConfig; merged /config local-wins.
- drone-agent/test/config-plugin.test.ts: rebuild() invokes injectors in precedence order (mock 2 injectors w/ overlapping keys → higher precedence wins); KNOWN_CONFIG_KEYS now from drone-core (existing tests still pass).
- drone-agent/test (config or swarm): onSessionStart triggers rebuild and engine config exposes underlay llm.active (the B5 seam test).
- UI config page tests (B6).

### B9 — Validation (FINAL STEP — must all pass)
- `pnpm -r run build` FIRST (after B1 drone-core change), then typecheck.
- LSP: zero NEW errors vs baseline (pre-existing getUsageLedger errors untouched).
- `pnpm -r run lint`, `pnpm -r run typecheck`, `pnpm -r run build` zero errors.
- `pnpm -r run test` (fast suite) + `cd drone-coordinator-ui && pnpm test` pass.
- Manual smoke: UI add provider entry (secret) → beacon syncs ≤5 min → agent session start sees provider via llm broker; GET never returns full secret; edit-empty keeps current.

## Validation criteria (Plan B)
- All B8 tests pass. LSP delta-zero. lint/typecheck/build zero errors. Fast + UI suites pass. E2E: pushed config applies as underlay at agent session start; secrets masked on read + write-only on edit; ${VAR} preserved; beacon-local overrides coordinator for same key.