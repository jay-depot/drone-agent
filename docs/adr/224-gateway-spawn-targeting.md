---
tags:
  [
    decision,
    gateway,
    spawn,
    coordinator,
    target-beacon,
    config,
    architecture,
    adr,
  ]
related:
  [
    modules/drone-gateway.md,
    concepts/spawn-backend.md,
    decisions/058-gateway-config-model.md,
    decisions/223-gateway-swarm-console-control-surface.md,
    decisions/043-inter-beacon-spawn-routing.md,
  ]
---

# 224 — Gateway spawn targeting: configurable target beacon (gateway ADR 004)

**Status**: Implemented (2026-09-26) · **Branch**: `feat/gateway-swarm-console` · **Commits**: `c4632e29` (feature) + memory `170bf620`, `3b4e45e4` · **Plan**: project-memory `plan-gateway-spawn-target-beacon` — _deleted from project memory after ingest_ · **Gateway ADR**: merged into this page (2026-10-06) — the former in-tree `drone-gateway/docs/adr/004-gateway-spawn-targeting.md` copy was deleted

**Summary**: `CoordinatorSpawnBackend` accepted an optional `targetBeaconId` constructor argument and silently fell back to the literal string `'default'`, but `createSpawnBackend()` never passed the argument and `GatewayConfig` had no field for it — so the value was **unreachable from configuration** and every spawn through the backend's default path targeted a beacon named `"default"`, which does not exist (the coordinator's `POST /api/spawn` requires `targetBeaconId` and 404s with `BEACON_NOT_FOUND` for an unknown beacon). The fix makes the target beacon a **first-class, configurable value**: a gateway-wide default (required in coordinator mode, mirroring `coordinatorUrl`) plus a per-conversation override, resolved into the `SurfaceContext` by the engine; the spawning backend holds no ambient beacon, records the beacon it used on the session, and terminates on that recorded beacon. The `'default'` fallback is deleted.

## Why

The defect was **latent**. The only surface that spawned through the default path was `persona-assignment`; the `swarm-console` surface passes a beacon id explicitly per command (`swarm.beacon.spawn <beaconId>`), and `swarm.agent.terminate` resolves the beacon by scanning. But persona routing over chat is the entire point of the gateway, and the missing wiring was the exact trap the next phase would walk into. It is the fix for one of the two pre-existing gateway defects surfaced by [223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md) (the other — the relay `{fromBeaconId, …}` mismatch — remains open).

## Locked design decisions (6)

1. **Config-only resolution, no dynamic discovery.** The target beacon comes from configuration only; there is **no** `listBeacons()` auto-selection. Resolution is deterministic, and a wrong beacon now fails honestly on first spawn with the coordinator's own `BEACON_NOT_FOUND`. (Dynamic "pick the only connected beacon" was rejected: it adds an async network call to a constructor-adjacent path plus an ambiguity rule to test.)
2. **Loader-level requirement in coordinator mode.** `loadGatewayConfig` requires `targetBeaconId` (a non-empty string) whenever `spawnBackend` is `"coordinator"`, throwing a clear error naming the field — mirroring the existing `coordinatorUrl` validation. With the requirement in the loader, the spawning backend never needs an ambient default.
3. **Per-conversation override in the surface config bag.** A conversation may override the gateway-wide default with `controlSurfaces[].config.targetBeaconId`. The engine resolves the effective value as **`override ?? gateway default`** and injects the resolved value into that conversation's `SurfaceContext` — surfaces never read raw config. (A conversation-level field was rejected: the beacon is surface-specific, and `config` already exists for surface options.)
4. **The backend holds no ambient beacon; termination uses the session's own beacon.** `SpawnBackend.spawnSession` receives the beacon explicitly via `SpawnSessionOptions`. `CoordinatorSpawnBackend` records the beacon it used on the returned `SpawnSession.targetBeaconId`, **throws** if invoked without one, and `terminateSession` targets `session.targetBeaconId`. A session lacking a beacon is warned about and skipped without a network call. Rationale: with per-conversation overrides, a single ambient backend field would terminate a conversation that spawned on beacon `x` against the _default_ beacon — a silent wrong-target kill.
5. **Inert in local mode.** A configured `targetBeaconId` has no effect when `spawnBackend` is `"local"`: the loader warns (non-fatal) and retains the value, and the engine passes `undefined` into the context regardless. (A hard error would break a config that merely switched back from coordinator mode; `coordinatorUrl` is already allowed-but-warned in local mode.)
6. **Invalid per-conversation override is dropped with a warning.** A `config.targetBeaconId` that is not a non-empty string is warned about and removed, so the conversation falls back to the gateway-wide default; the load still succeeds — consistent with how `allowedSenders` validates.

## Implementation

- `src/types.ts` — `GatewayConfig.targetBeaconId?: string`; `SpawnSession.targetBeaconId?: string`; new exported `SpawnSessionOptions`.
- `src/spawn-backend.ts` — `spawnSession(conversationId, personaId, opts?: SpawnSessionOptions)`.
- `src/config/load.ts` — gateway-level validation (throws when missing/non-string in coordinator mode; warns-and-ignores in local mode) + new `sanitizeSurfaceConfig()` (drops an invalid per-conversation `targetBeaconId`, mirroring `parseAllowedSenders`).
- `src/coordinator-spawn-backend.ts` — dropped the ambient `targetBeaconId` field and the `'default'` fallback; ctor is now `(coordinatorUrl, coordinatorToken)`; `spawnSession` reads `opts.targetBeaconId`, throws if absent, records it on the session; `terminateSession` targets `session.targetBeaconId`.
- `src/surfaces/types.ts` — `SurfaceContext.targetBeaconId?: string`.
- `src/surfaces/persona-assignment.ts` — forwards `{ targetBeaconId: ctx.targetBeaconId }`.
- `src/engine.ts` — new `resolveTargetBeaconId(spec)` (`override ?? gateway default`, `undefined` unless coordinator mode) threaded into `surfaceContext(...)` via `createControlSurface`.
- `src/index.ts` — coordinator branch logs the default beacon; `CoordinatorSpawnBackend` constructed with exactly two args.
- `src/local-spawn-backend.ts` — **unchanged** (its two-parameter `spawnSession` already satisfies the widened interface; it ignores the option, and its sessions carry no beacon).
- Plus gateway `CONTEXT.md` (config layout + a new _Spawn Target Beacon_ glossary entry) and the roadmap's Phase-4 inventory.

**Deviation from the written plan:** the plan's Step-7 snippet showed the new `resolveTargetBeaconId` helper definition but not the `createControlSurface` call-site change, so the call site still passed no argument; the LSP/build caught the resulting TS2554 and it was fixed (`this.surfaceContext(this.resolveTargetBeaconId(spec))`). The plan's code blocks are illustrative, not exhaustive.

## Validation

LSP clean; `pnpm -r run build` exit 0; `pnpm lint` exit 0; `pnpm test` **3338 passed / 14 skipped / 0 failed**; gateway suite **288 passed / 19 files**. New/updated tests: `config-load.test.ts` (22, +5: missing → throw, accepted, non-string → throw, local-mode warn, override drop/keep), `coordinator-spawn-backend.test.ts` (8, rewritten: beacon passed, throws without one, terminate uses the session beacon, skip-without-beacon), `surface-registry.test.ts` (10, third-arg assertion + forward), `engine.test.ts` (15, +3 beacon-resolution cases), `index.test.ts` (11, construction arity).

**Post-merge manual step (NOT a code task):** set `"targetBeaconId": "ambiorix"` in the gateway `config.json` on the machine that runs the gateway. There is no `~/.drone-gateway/` on the development host, so no config file was edited.

## Consequences

- `GatewayConfig`, `SpawnSession`, and `SurfaceContext` each gain an optional `targetBeaconId`; `SpawnSessionOptions` is new; `SpawnBackend.spawnSession` gains an optional `opts` parameter (touching every implementer and test mock).
- `CoordinatorSpawnBackend` is now two-arg; `createSpawnBackend` passes exactly two arguments; the `'default'` beacon literal no longer exists anywhere in the package.
- A coordinator-mode gateway whose conversations are only `swarm-console` or `discard` must still name a beacon (one line of config).

## Related

- [drone-gateway](../../drone-gateway/) — the gateway module page (config model, key files, types, surfaces).
- spawn-backend — the `SpawnBackend` interface (the `spawnSession` widening).
- [058-gateway-config-model](058-gateway-config-model.md) — the folder-hierarchy config model extended here.
- [223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md) — surfaced the `'default'` defect; this ADR fixes it (and the surface registry's `SurfaceContext` is where the resolved beacon now rides).
- [043-inter-beacon-spawn-routing](043-inter-beacon-spawn-routing.md) — the coordinator `POST /spawn` contract (`targetBeaconId` required).
