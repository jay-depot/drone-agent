---
key: plan-coordinator-config-ui-and-secret-handling
tags: []
created: 2026-09-11T01:41:33.900Z
updated: 2026-09-11T04:57:00.599Z
---

# PLAN B — Coordinator Config Pipeline + UI + Secret Handling

Status: ✅ COMPLETED (executed 2026-09-11). Branch: feat/coordinator-config-ui-and-secure-storage. Commits: B1-3 (9a24458), B4 (6611473), B5 (8c4b9df), B6 (8be9d82), B7 (53c62dd), B8 (a3390df), B9 formatting (d4527ac). All validation green (build/typecheck/lint exit 0, fast suite 208 files/2951 tests, UI 32 files/236 tests, LSP clean).

## Feature summary

A dedicated coordinator UI page (/config) to manage a GLOBAL, ALLOWLISTED set of config entries (LLM provider entries w/ API keys, llm.active, compaction settings) distributed coordinator→beacon→agent and applied as a config underlay at agent session start. API keys: plaintext at rest (encryption-at-rest DEFERRED as follow-up), masked on read, write-only on edit, ${VAR} templates preserved (receiver-side interpolation).

## What shipped (per step)

- B1 (drone-core): NEW src/config-keys.ts — KNOWN_CONFIG_KEYS (moved verbatim from config plugin) + UNDERLAY_ALLOWLIST (providers._, llm.active, llm.reasoningLevel, compaction.enabled, compaction.strategy, session.guardrail._) + isUnderlayAllowed() + CoordinatorConfigEntry wire type; re-exported from index.ts. Config plugin imports KNOWN_CONFIG_KEYS from drone-core (stale local copy removed).
- B2 (coordinator): coordinator_config table (key PK, value JSON, secret, description, timestamps) in db/init.ts; NEW db/config.ts CRUD (list/get/upsert/deleteCoordinatorConfig); exported via db/index.ts.
- B3 (coordinator): NEW routes/config.ts — GET /config, GET /config/:key, PUT /config/:key (allowlist-validated via isUnderlayAllowed → 400 + valid patterns on reject; masked response), DELETE /config/:key (404 if absent); maskSecretValue() masks apiKey/api_key/*Key inside provider JSON + scalar → •••• + last4, ${VAR} preserved. Registered under /api in routes/index.ts. Web-port web-auth protected; primary-port mTLS approved-only (Plan A).
- B4 (beacon): CoordinatorClient.getCoordinatorConfig() (cfetch GET /api/config, coordinatorTrusted()-gated) + interface; beacon_config composite-PK migration (key → PRIMARY KEY (scope,key)) in db/init.ts; db/config.ts rewritten — scoped getBeaconConfig(key, scope='local')/listBeaconConfig(scope?)/update/delete, NEW listMergedConfig() (local wins, one row per key) + replaceSwarmConfig(CoordinatorConfigEntry[]) (swarm-scope-only replace); triggerCoordinatorSync pulls config after fragments + adds configs count; beacon GET /config → listMergedConfig.
- B5 (agent): config plugin DroneConfigCapability gained `rebuild` (type + impl) — createDefaultAgentConfig + applyAgentConfigLayer over injectors in precedence order, then MUTATES the shared engine config object in place (providers/llm/compaction/session) so all consumers (llm broker, budget service) observe the underlay. swarm/hooks.ts registerHooks: renamed underscore params → configCap/beaconConfigInjector; added TOP-LEVEL onSessionStart hook calling configCap.rebuild(). swarm/config.ts BeaconConfigInjector docstring updated (merged view, Q8).
- B6 (coordinator UI): lib/types.ts CoordinatorConfigEntry; NEW pages/config.tsx (table, add/edit dialog with secret-masking + write-only keep-current sentinel, delete confirm, persistent amber trust warning banner); App.tsx nav item + /config route; config.test.tsx (5 tests).
- B7 (docs): swarm-plugin.md underlays section rewritten (coordinator→beacon→agent reality, allowlist, masking, ~5-min propagation); AGENTS.md config-cascade rewritten (coordinator values ride beacon merged underlay @75, applied at session start) — no longer aspirational.
- B8 (tests): drone-coordinator/test/routes/config.test.ts (13 tests: db CRUD + routes incl. masking/allowlist validation/upsert/404); drone-beacon/test/db.test.ts extended Beacon Config CRUD (composite-PK coexist, scoped update/delete/list, merged local-wins, replaceSwarmConfig swarm-only) — all 102 pass; drone-agent/test/config-plugin.test.ts rebuild() precedence + shared-config-mutation test (21 pass).

## KEY GOTCHAS (log for future plans)

1. **better-sqlite3 `db.transaction(() => {...})` does NOT reliably persist multi-statement `exec` DDL/DML (CREATE/ALTER TABLE ... RENAME, DELETE+INSERT) in the vitest fork pool.** The composite-PK migration and replaceSwarmConfig both silently no-op'd when wrapped in db.transaction(). Fix: run the statements via db.exec()/prepare().run() directly (matching init.ts's existing pattern). Verified empirically with a debug test (transaction-wrapped → PK unchanged; direct exec → composite PK).
2. **`getBeaconConfig` returns `undefined` for missing rows (not null)** — matches the pre-existing CRUD tests (`toBeUndefined`); `updateBeaconConfig` returns `null` (`toBeNull`). New tests/accessors must respect this distinction; the composite-PK scoped versions preserved it.
3. **Plan A gotchas** (from plan-coordinator-trust-hardening): Node ed25519 needs one-shot crypto.sign, app.inject defaults remoteAddress to loopback (auto-approves), cfetch writes bodies via req.write.

## Out of scope / follow-ups

- Encryption-at-rest for secret config values (documented follow-up; currently plaintext-at-rest by locked Q6 decision).
- WS push / live mid-session re-apply of config (5-min pull only; applied at next session start).
- Manual E2E smoke runbook (UI add secret provider → beacon sync ≤5 min → agent session start sees provider) still worth running against live services.
