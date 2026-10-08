---
tags:
  [decision, gateway, spawn-backend, control-surface, config, architecture, adr]
related:
  [
    modules/drone-gateway.md,
    concepts/spawn-backend.md,
    decisions/224-gateway-spawn-targeting.md,
    decisions/232-gateway-surface-lifecycle-and-working-dir.md,
    decisions/223-gateway-swarm-console-control-surface.md,
  ]
---

# ADR 238: Gateway per-control-surface spawn backend (inferred mode) + explicit `--persona` validation

**Status**: Implemented (2026-10-08, branch `feat/gateway-per-surface-spawn-backend`)

## Context

The gateway chose its spawn backend **once, gateway-wide**: `config.json` set
`spawnBackend: "local" | "coordinator"`, `src/index.ts` built exactly one
`SpawnBackend` from it, and `src/engine.ts` injected that single backend into
every conversation's `SurfaceContext`. That made it impossible to run
**locally-spawned** agents and **coordinator-managed** agents in the same
gateway — a real and wanted deployment shape (e.g. a single-host bot beside a
remote one).

Two prior ADRs established the per-surface override pattern this change extends:
[224-gateway-spawn-targeting](224-gateway-spawn-targeting.md) (a per-conversation
`config.targetBeaconId` overriding a gateway-wide default) and
[232-gateway-surface-lifecycle-and-working-dir](232-gateway-surface-lifecycle-and-working-dir.md)
(a per-surface `config.workingDir`).

The change also exposed a directly-adjacent defect: a locally-spawned agent's
`--persona` that does not resolve failed **silently** (the persona broker logged
a warning and the agent ran with no active persona), and for gateway-spawned
children even that warning was dropped — `LocalSpawnBackend` pipes the child's
stderr but never reads it.

## Decisions

### 1. Mode is inferred per surface; the gateway-wide setting is removed

A surface's spawn mode is **inferred** from configuration, with no explicit field
anywhere:

- `controlSurfaces[].config.targetBeaconId` **present** ⇒ **coordinator** mode,
  spawning on that named beacon.
- `controlSurfaces[].config.targetBeaconId` **absent** ⇒ **local** mode, spawning
  on this host.

`GatewayConfig.spawnBackend` and the gateway-wide `targetBeaconId` are removed.
Inference is total — there is no configuration that wants coordinator mode
without a beacon (the backend rejects it) or local mode with a beacon
(meaningless). Backward compatibility was explicitly **not** a requirement.

### 2. Removed keys are a hard load error

A `config.json` still carrying `spawnBackend` or a gateway-level `targetBeaconId`
is rejected at load with an error naming the key and pointing at per-surface
config. A leftover key must not be silently ignored (it would flip every surface
to local with no signal).

### 3. The backend is chosen per surface and injected

A new `SpawnBackendRegistry` (mirroring `SurfaceRegistry`) holds the available
backends, keyed by `SpawnBackendType`. `GatewayEngine`'s constructor becomes
`(config, backends, swarm?)`; for each surface it resolves the mode and injects
the matching backend as `ctx.spawnBackend` (still **required**).
`resolveTargetBeaconId` loses its coordinator-mode guard and returns the
sanitized surface beacon (or `undefined`). Startup logs list the registered
backend types and each conversation's resolved surface modes.

### 4. A shared requirements module

`src/surfaces/requirements.ts` exports `SPAWNING_SURFACES`
(`persona-assignment`), `SURFACES_REQUIRING_COORDINATOR` (`swarm-console`), and
`resolveSurfaceSpawnMode(spec)`. Both the loader and the engine use the helper,
so the inference rule has one definition.

### 5. Loader rules, keyed per surface

- `coordinatorUrl`/`coordinatorToken` stay gateway-wide. `coordinatorUrl` is
  **required** iff any loaded surface needs the coordinator — a coordinator-mode
  spawner or a `SURFACES_REQUIRING_COORDINATOR` surface (`swarm-console`).
- A **spawning** surface with a present-but-invalid `config.targetBeaconId` is a
  **hard load error** (the field selects the mode; a typo must not silently flip
  a remote spawn to local).
- A `targetBeaconId` on a **non-spawning** surface is warned about and dropped.
- A configured `coordinatorUrl` with no requiring surface is **silently
  accepted**; the unused backend + client are still registered.

### 6. One shared `CoordinatorClient`

`index.ts` builds a single `CoordinatorClient` (when `coordinatorUrl` is set) and
injects it into **both** `ctx.swarm` and `CoordinatorSpawnBackend` (whose
constructor now takes the client instead of `(url, token)`), removing a
same-object duplication. `createSpawnBackend` is replaced by
`createSpawnBackends(config, coordinatorClient?)`; the "Unknown spawn backend
type" exit path is deleted (there is no user-supplied backend string anymore).

### 7. `swarm-console` guard reworded

`ctx.swarm` can now only be undefined when no `coordinatorUrl` is configured. The
defensive branch is kept (direct factory construction) and reworded to _"Swarm
console requires a configured coordinatorUrl."_

### 8. Explicit `--persona` is validated; env and config stay lenient

The persona broker's `onSessionStart` resolution order becomes: the explicit
`--persona` flag (**fatal** if it will not resolve), then `DRONE_PERSONA`
(lenient), then `config.activePersona` (lenient). `cli.ts` no longer folds
`DRONE_PERSONA` into the same slot, so `runtimeOptions.persona` is the explicit
flag by construction. A missing explicit persona throws out of the hook (the
engine re-throws non-`onBeforePrompt` hook errors) and sets `process.exitCode = 1`
— uniform across CLI, gateway-local, and beacon-spawn paths (a doomed beacon
spawn row is reconciled by [231-agent-termination-ladder-and-reconcile](231-agent-termination-ladder-and-reconcile.md)).
A stale `DRONE_PERSONA` or `config.activePersona` only warns — a config default
must not brick startup.

### 9. Two-branch not-found message

The failure message is chosen by config introspection
(`registration.getConfig().enabledPlugins.includes('swarm')`, no cross-plugin
import): swarm **absent** → _"… running WITHOUT swarm connectivity — if X is a
swarm persona, enable the 'swarm' plugin (see ~/.drone-agent/config.json)"_;
swarm **present** → _"… swarm personas are loaded, but none has id X — check the
id and its scope"_.

### 10. Child stderr is drained; early exit is an error

`LocalSpawnBackend` now drains the child's stderr into the gateway logger (so the
message is visible in `journalctl`, and the pipe cannot fill) and keeps a bounded
ring for diagnostics. If a child closes stdout **without** a `turnComplete`, the
turn returns `Error: agent exited before replying: <stderr tail>` instead of `''`,
so the operator sees the reason in chat. The one-shot inject helper
(`inject/spawn-once.ts`) gets the same stderr-tail treatment in
`SpawnOnceFailureError`.

## Consequences

### Positive

- One gateway can spawn some conversations locally and others via the
  coordinator; the mode is declarative and per-surface.
- Config errors that would silently change where an agent runs are loud.
- A locally-spawned agent's persona failure is now visible and actionable.
- One `CoordinatorClient` instead of two.

### Neutral

- A coordinator surface always names its beacon inline (no gateway default).
- A gateway whose surfaces never need the coordinator needs no `coordinatorUrl`.
- `DRONE_PERSONA` now applies to **all** invocation kinds (the fallback moved
  from the `default`-only CLI branch into the broker).

### Out of scope (deferred)

- Surfacing the persona failure directly into chat from the agent side.
- Beacon-side persona pre-validation before spawning.

## Validation

- LSP clean; `pnpm -r run build` exit 0; `pnpm typecheck` exit 0; `pnpm run lint`
  exit 0; 8 packages.
- Gateway suite **461 passed** (34 files); new `test/requirements.test.ts` (6)
  and `test/spawn-backend-registry.test.ts` (4); `config-load`, `engine`,
  `index`, `coordinator-spawn-backend`, `swarm-console-surface`,
  `local-spawn-backend`, `inject-spawn-once` updated.
- Agent suite: `persona-cli-flag.test.ts` covers explicit-fatal, env-lenient,
  config-lenient, and both message branches.

## Related

- [224-gateway-spawn-targeting](224-gateway-spawn-targeting.md) — the per-surface
  `targetBeaconId` pattern this extends; this ADR removes its gateway-wide
  default and the global mode.
- [232-gateway-surface-lifecycle-and-working-dir](232-gateway-surface-lifecycle-and-working-dir.md)
  — the sibling per-surface config pattern; the engine `SurfaceContext`.
- [223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md)
  — the surface registry + `swarm-console` (the coordinator-requiring surface).
- [231-agent-termination-ladder-and-reconcile](231-agent-termination-ladder-and-reconcile.md)
  — reconciles a doomed beacon spawn row.
