---
tags: [decision, coordinator, config, underlay, secrets, ui, adr]
related: [concepts/beacon-config-override-spec.md, architecture/config-cascade.md, modules/drone-coordinator.md, modules/drone-beacon.md, modules/drone-coordinator-ui.md, modules/drone-core.md, modules/drone-agent-plugins.md, entities/DroneAgentConfig.md, decisions/007-beacon-config-underlay.md, decisions/005-config-cascade.md, decisions/211-beacon-coordinator-trust-hardening.md, decisions/209-stored-secrets-config-split.md, decisions/213-swarm-config-underlay-resolution.md]
---

# 212: Coordinator config pipeline — allowlisted store, beacon pull, `rebuild()` wiring, `/config` page

**Status**: Implemented (2026-09-11) · **Branch**: `feat/coordinator-config-ui-and-secure-storage` (`9a24458`..`d4527ac`) · **Plan**: project-memory `plan-coordinator-config-ui-and-secret-handling` (Plan B) — *deleted from project memory after ingest*

**Summary**: The documented coordinator→beacon→agent config cascade was **aspirational dead plumbing**: `DroneConfigCapability.rebuild()` was declared but never implemented, `inject()`/`getInjectors()`/`rebuild()` were never called, the runtime loaded only default→user→project from disk, there was no coordinator config table or `/config` API, and `beacon_config.scope='swarm'` was unused. This ADR makes the cascade real end-to-end: a global **allowlisted** key/value store on the coordinator, a 5-minute **pull** by the beacon into a merged underlay, a `rebuild()` on the agent that applies that underlay at session start, and a `/config` management page in the coordinator UI.

## Context

Plan A ([211-beacon-coordinator-trust-hardening](211-beacon-coordinator-trust-hardening.md)) was the prerequisite: pushing real LLM API keys through the coordinator is only safe once a pending (unapproved) beacon is blocked **server-side**. With that closed, Plan B could proceed.

The pre-implementation review found the config-push infrastructure was largely non-functional:

| Claimed capability | Actual state |
| --- | --- |
| `DroneConfigCapability.rebuild()` | Declared in the type, **never implemented** |
| `inject()` / `getInjectors()` / `rebuild()` calls | **Never called** anywhere |
| Documented "Coordinator (50) → Beacon (75)" cascade | Docs-only; no coordinator injector existed |
| Coordinator config table + `/config` API | **Did not exist** |
| `beacon_config.scope='swarm'` | Dead column value |
| Runtime config load | Default→user→project from disk only |

## Decision

1. **Surface (Q5): a global, allowlisted key/value store.** Not per-beacon, not a raw JSON blob. Keys are dot-notation and validated against a curated allowlist.
2. **Tokens (Q6): plaintext-at-rest + masked-on-read + write-only editing.** `GET` returns `••••` + last-4 for secret keys; the edit dialog uses a "leave empty to keep current" sentinel; `${VAR}` templates are stored and returned **as-is** (receiver-side interpolation — see [213-swarm-config-underlay-resolution](213-swarm-config-underlay-resolution.md)). **Encryption-at-rest was explicitly deferred** as a follow-up.
3. **Allowlist (Q7): move `KNOWN_CONFIG_KEYS` into `drone-core` as the canonical shared list.** Narrow MVP: `providers.<id>` as whole-entry units, `llm.active`, `llm.reasoningLevel`, `compaction.*`, `session.guardrail.*`. This required a **second** list, `UNDERLAY_ALLOWLIST` — see the deviation below.
4. **Delivery (Q8): coordinator is the source of truth; the beacon PULLS.** Direction is strictly coordinator → beacon → agent. The beacon pulls on its existing 5-minute `triggerCoordinatorSync` and stores non-secret entries as `beacon_config scope='swarm'`; agents fetch the merged beacon `/config` where **beacon-local wins** for the same key. Near-real-time push was explicitly out of scope.
5. **Apply timing (Q9): at agent session start**, via the now-wired `rebuild()`. No live mid-session re-apply (deferred).
6. **UI (Q10): a dedicated `/config` page** + nav item, modeled on `personas.tsx` list+CRUD, with secret masking and a persistent amber trust warning banner.

## Implementation

- **B1 (`drone-core`)** — new `src/config-keys.ts`: `KNOWN_CONFIG_KEYS` (moved verbatim from the config plugin) **plus** `UNDERLAY_ALLOWLIST` (`providers._`, `llm.active`, `llm.reasoningLevel`, `compaction.enabled`, `compaction.strategy`, `session.guardrail._`), `isUnderlayAllowed()`, and the `CoordinatorConfigEntry` wire type; re-exported from `index.ts`. The config plugin now imports `KNOWN_CONFIG_KEYS` from `drone-core` (stale local copy removed).
- **B2 (`drone-coordinator`)** — `coordinator_config` table (`key` PK, `value` JSON, `secret`, `description`, timestamps) in `db/init.ts`; new `db/config.ts` CRUD (list/get/upsert/delete).
- **B3 (`drone-coordinator`)** — new `routes/config.ts`: `GET /config`, `GET /config/:key`, `PUT /config/:key` (allowlist-validated → 400 + valid patterns on reject; masked response), `DELETE /config/:key` (404 if absent); `maskSecretValue()` masks `apiKey`/`api_key`/`*Key` inside provider JSON and scalars → `••••` + last-4, preserving `${VAR}` templates. Registered under `/api`. Web port is web-auth protected; primary port is mTLS approved-only (Plan A).
- **B4 (`drone-beacon`)** — `CoordinatorClient.getCoordinatorConfig()` (cfetch `GET /api/config`, gated on `coordinatorTrusted()`); `beacon_config` migration from `key` PK to **composite PK `(scope, key)`**; `db/config.ts` rewritten with scoped `getBeaconConfig(key, scope='local')` / `listBeaconConfig(scope?)` / `update` / `delete`, new `listMergedConfig()` (local wins, one row per key) and `replaceSwarmConfig(entries[])` (swarm-scope-only replace); `triggerCoordinatorSync` pulls config after fragments and adds a `configs` count; beacon `GET /config` → `listMergedConfig`.
- **B5 (`drone-agent`)** — the config plugin's `DroneConfigCapability` gained a working `rebuild`: composes defaults + injectors in precedence order, then **mutates the shared engine config object in place** so all consumers (LLM broker, budget service) observe the underlay. `swarm/hooks.ts` gained a **top-level `onSessionStart` hook** calling `configCap.rebuild()`.
- **B6 (`drone-coordinator-ui`)** — `CoordinatorConfigEntry` type; new `pages/config.tsx` (table, add/edit dialog with secret masking + write-only keep-current sentinel, delete confirm, persistent amber trust banner); `App.tsx` nav item + `/config` route; `config.test.tsx` (5 tests).
- **B7 (docs)** — `docs/agents/swarm-plugin.md` underlays section rewritten to the coordinator→beacon→agent reality (allowlist, masking, ~5-min propagation); `AGENTS.md` config-cascade rewritten — no longer aspirational.
- **B8 (tests)** — coordinator `routes/config.test.ts` (13 tests); beacon `db.test.ts` extended (composite-PK coexistence, scoped update/delete/list, merged local-wins, `replaceSwarmConfig` swarm-only; 102 pass); agent `config-plugin.test.ts` `rebuild()` precedence + shared-config-mutation (21 pass).

## Deviations recorded

- The plan's stated fast suite was root `pnpm test`; `pnpm -r run lint` has no lint script at package level — the real gates are root `pnpm lint` (`lint:eslint` + `lint:prettier`).
- The plan's suggested branch `feat/stored-secrets-config-split` was created but **git did not switch to it**; all work was committed on `feat/coordinator-config-ui-and-secure-storage`. The branch name was only a suggestion.
- Underlay filtering uses `isUnderlayAllowed` (`UNDERLAY_ALLOWLIST`), *not* `KNOWN_CONFIG_KEYS` as the plan's literal text implied — `KNOWN_CONFIG_KEYS` has no `providers.*` entries and would have silently dropped every coordinator-pushed provider entry, defeating the feature.

## Key gotchas (recorded for future planners)

1. **`better-sqlite3` `db.transaction(() => {...})` does NOT reliably persist multi-statement `exec` DDL/DML in the vitest fork pool.** The composite-PK migration and `replaceSwarmConfig` both silently no-op'd when wrapped in `db.transaction()`. Fix: run the statements via `db.exec()` / `prepare().run()` directly (matching `init.ts`'s existing pattern). Verified empirically with a debug test (transaction-wrapped → PK unchanged; direct exec → composite PK).
2. **`getBeaconConfig` returns `undefined` for a missing row (not `null`)**, while `updateBeaconConfig` returns `null`. New scoped accessors must preserve that distinction.
3. Node ed25519 needs the one-shot `crypto.sign`; `app.inject()` defaults `remoteAddress` to loopback (auto-approves after Plan A); the beacon's `cfetch` writes bodies via `req.write`. (Carried over from Plan A.)

## Consequences

- The config cascade documented since [005-config-cascade](005-config-cascade.md) and [007-beacon-config-underlay](007-beacon-config-underlay.md) is now **real in code**, with exactly one coordinator-level underlay (the merged beacon view at precedence 75) rather than a separate coordinator injector.
- Coordinator-pushed LLM provider entries (with API keys) reach agent sessions without a disk config edit — the first feature that actually required Plan A's server-side trust gate.
- `${VAR}` templates ride end-to-end as literal strings until the receiver interpolates them ([213-swarm-config-underlay-resolution](213-swarm-config-underlay-resolution.md)).
- Plaintext-at-rest on the coordinator is a **deliberate, documented posture**; encryption-at-rest remains an open follow-up.
- Propagation latency is up to 5 minutes, and changes only take effect at the next session start.

## Validation

Build/typecheck/lint exit 0; fast suite 208 files / 2951 tests; UI 32 files / 236 tests; LSP clean.

**Pending (handed to the user)**: manual E2E smoke — add a provider entry in the UI → beacon sync ≤5 min → agent session start sees the provider.

## Related

- beacon-config-override-spec — the underlay spec this makes real (and corrects)
- [config-cascade](005-config-cascade.md) — the cascade layer
- [211-beacon-coordinator-trust-hardening](211-beacon-coordinator-trust-hardening.md) — the prerequisite
- [209-stored-secrets-config-split](209-stored-secrets-config-split.md) — phase 2, which replaced this ADR's secret-row model
- [213-swarm-config-underlay-resolution](213-swarm-config-underlay-resolution.md) — the `${VAR}` interpolation + rebuild fix on the agent side
