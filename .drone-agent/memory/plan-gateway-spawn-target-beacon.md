---
key: plan-gateway-spawn-target-beacon
tags:
  - plan
  - drone-gateway
  - spawn
  - targetBeaconId
  - coordinator
  - completed
created: 2026-09-26T20:11:38.663Z
updated: 2026-09-26T20:18:13.271Z
---

# Plan: Gateway spawn targeting — wire `targetBeaconId` end-to-end

**Status:** COMPLETED (2026-09-26)
**Package:** `drone-gateway`
**Branch:** `feat/gateway-swarm-console` · commit `c4632e29`

---

## ✅ Completion summary

All 12 steps executed and all 15 validation criteria verified.

**Delivered (commit `c4632e29`, 17 files, +560 −122):**

- `src/types.ts` — `GatewayConfig.targetBeaconId?: string`, `SpawnSession.targetBeaconId?: string`, new exported `SpawnSessionOptions`.
- `src/spawn-backend.ts` — `spawnSession(conversationId, personaId, opts?: SpawnSessionOptions)`; JSDoc notes coordinator mode must supply the beacon.
- `src/config/load.ts` — gateway-level validation (throws when missing/non-string in coordinator mode; warns-and-ignores in local mode; value retained); new `sanitizeSurfaceConfig()` drops an invalid per-conversation `config.targetBeaconId` with a warning.
- `src/coordinator-spawn-backend.ts` — dropped the ambient `targetBeaconId` field and the `'default'` fallback; ctor is now `(coordinatorUrl, coordinatorToken)`; `spawnSession` reads `opts.targetBeaconId`, throws if absent, records it on the session; `terminateSession` targets `session.targetBeaconId` (warns + no-ops when absent).
- `src/surfaces/types.ts` — `SurfaceContext.targetBeaconId?: string`.
- `src/surfaces/persona-assignment.ts` — forwards `{ targetBeaconId: ctx.targetBeaconId }`.
- `src/engine.ts` — new `resolveTargetBeaconId(spec)` (`override ?? gateway default`, `undefined` unless coordinator mode) threaded into `surfaceContext(...)` via `createControlSurface`.
- `src/index.ts` — coordinator branch logs the default beacon; `CoordinatorSpawnBackend` constructed with exactly two args.
- `src/local-spawn-backend.ts` — unchanged (two-param `spawnSession` already satisfies the widened interface).
- Tests: `config-load` (+5), `index` (construction arity), `coordinator-spawn-backend` (rewritten: beacon passed, throws without one, terminate uses the session beacon, skip-without-beacon), `surface-registry` (third-arg assertion + forward case), `engine` (+3 beacon-resolution cases; `makeRespondingSpawnBackend` gained a `type` param).
- Docs: new `docs/adr/004-gateway-spawn-targeting.md`; `CONTEXT.md` (config layout + **Spawn Target Beacon** glossary + updated Persona Assignment / Surface Registry entries); `roadmap` Phase 4 entry. Also collapsed a duplicated/stale Phase 4 inventory block found in the roadmap.

**Verification:** `pnpm -r run build` ✅ · `pnpm lint` ✅ · `pnpm test` ✅ (3338 passed, 14 skipped) · gateway suite 288 passed. LSP clean.

**Deviation from the plan text (noted for honesty):** the plan's Step 7 snippet omitted the `createControlSurface` call-site change; the LSP flagged the resulting arity error, and the fix (passing `this.surfaceContext(this.resolveTargetBeaconId(spec))`) was applied. This is the intended behavior of the plan, just an incomplete snippet.

**Post-merge manual step (NOT a code task):** set `"targetBeaconId": "ambiorix"` in the gateway `config.json` on the machine that runs the gateway. There is no `~/.drone-gateway/` on the development host, so no config file was edited.

---

## Original plan (retained for reference)

### 1. Summary — what and why

`CoordinatorSpawnBackend` accepted an optional `targetBeaconId` constructor argument and silently fell back to the string `'default'`. `createSpawnBackend()` never passed the argument, and `GatewayConfig` had no field for it — so the value was unreachable from configuration. Every spawn routed through the backend's default path targeted a beacon named `"default"`, which does not exist. The coordinator's `POST /api/spawn` requires `targetBeaconId` and returns `BEACON_NOT_FOUND` (404) for an unknown beacon, so today the failure is loud but deeply confusing.

This was latent: the only surface that spawned through the default path was `persona-assignment`; the `swarm-console` surface passes a beacon id explicitly per command. But persona routing over chat is the entire point of the gateway, and it is the exact trap the next phase walks into.

**The fix:** make the target beacon first-class and configurable — a gateway-wide default (required in coordinator mode) plus a per-conversation override; the backend stops holding ambient state; the `'default'` fallback is deleted.

### 2. Decisions (locked during planning)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Resolution strategy | **(A)** Config-only. No dynamic `listBeacons()` auto-selection. |
| Q2 | Enforcement site | **(A1)** Config loader, hard-fail in coordinator mode — mirrors `coordinatorUrl`. |
| Q3 | Per-conversation override | **(B)** In scope. |
| Q3b | Override location | **(B)** `controlSurfaces[].config.targetBeaconId`. |
| Q4 | Termination targeting | **(B)** `spawnSession` takes the beacon; backend holds no ambient field; session records it; terminate uses it. |
| Q5 | Precedence site | **(A)** Engine resolves `override ?? default` into `SurfaceContext`. |
| Q6 | Local mode | **(B)** Warn (non-fatal), ignore; context gets `undefined`. |
| Q7 | Name / validation | `targetBeaconId`; throw (coordinator) / warn-and-ignore (local and override). |
| Q8 | Docs / live config | **(A)** ADR 004 + CONTEXT.md + roadmap; live `"ambiorix"` is a post-merge manual step. |
| Q9 | Tests | As enumerated; coordinator backend throws if invoked without a beacon. |

**Out of scope:** dynamic beacon discovery; validating the beacon against the coordinator at startup.

### 3. Interfaces (as implemented)

```ts
// types.ts
export interface GatewayConfig { /* … */ targetBeaconId?: string; }
export interface SpawnSession { /* … */ targetBeaconId?: string; }
export interface SpawnSessionOptions { targetBeaconId?: string }

// spawn-backend.ts
spawnSession(conversationId, personaId, opts?: SpawnSessionOptions): Promise<SpawnSession>;

// surfaces/types.ts
export interface SurfaceContext { /* … */ targetBeaconId?: string; }
```

### 4. Validation criteria — all met

1. Types added/exported ✅ 2. Interface widened; both backends compile; no unused-param error ✅ 3. No `'default'` beacon fallback in `src` ✅ 4. Coordinator ctor two-arg; `createSpawnBackend` passes two ✅ 5. Missing `targetBeaconId` throws; valid loads ✅ 6. Invalid gateway value throws (coordinator) / warns-and-ignores (local) ✅ 7. Valid override preserved; invalid dropped with warning, load succeeds ✅ 8. Engine resolves per conversation; `undefined` in local mode ✅ 9. `persona-assignment` forwards `ctx.targetBeaconId` ✅ 10. Terminate uses `session.targetBeaconId`; absent → warn, no call ✅ 11. Spawn without a beacon throws ✅ 12. Build (LSP) clean ✅ 13. Lint clean ✅ 14. Fast suite green ✅ 15. New behavior unit-tested; no dead code ✅

### Related memory
- `followup-swarm-spawn-terminate-beacon-restart` — spawn termination lost across a beacon restart (separate, still open).
- `followup-swarm-console-unbacked-commands` — swarm-console commands awaiting coordinator endpoints.
- `roadmap` — Phase 4 gateway inventory.