---
key: plan-gateway-per-surface-spawn-backend
tags:
  - plan
  - gateway
  - spawn-backend
  - control-surface
  - persona
  - drone-gateway
  - drone-agent
created: 2026-10-08T05:43:34.667Z
updated: 2026-10-08T05:43:34.667Z
---

# Plan: Per-Control-Surface Spawn Backend (gateway) + explicit-`--persona` validation (agent)

**Branch:** `feat/gateway-per-surface-spawn-backend` (created from `main` @ `6547791`).
**Status:** ready for execution.
**Packages touched:** `drone-gateway` (core), `drone-agent` (persona fix), docs.

---

## 1. Why (feature summary)

Today the drone-gateway chooses a **single, gateway-wide** spawn backend: `config.json`
sets `spawnBackend: "local" | "coordinator"`, `src/index.ts` builds exactly one
`SpawnBackend` from it, and `src/engine.ts` injects that one backend into every
conversation's `SurfaceContext`. This makes it impossible to run **locally-spawned** agents
and **coordinator-managed** agents in the same gateway, which is a real (and wanted)
deployment shape.

This plan makes the choice **per control surface**, inferred from configuration, so one
gateway can spawn some conversations locally and others via the coordinator. It also fixes
a directly-adjacent defect the change exposes: a locally-spawned agent's `--persona` that
does not resolve today fails **silently** (warn + run with no persona); this plan makes an
**explicitly requested** `--persona` fail fast with an explanatory message, and makes the
message actually reachable for gateway-spawned children.

### The inference rule (the heart of the change)

A control surface's spawn mode is **inferred**, with no explicit field anywhere:

- `controlSurfaces[].config.targetBeaconId` **present** ⇒ **coordinator** mode, spawning on that named beacon.
- `controlSurfaces[].config.targetBeaconId` **absent** ⇒ **local** mode, spawning on this host.

Consequences (all deliberate): no `config.spawnBackend` field; no gateway-wide
`spawnBackend`; no gateway-wide `targetBeaconId` default (a coordinator surface always
names its own beacon inline). Inference is total — there is no configuration that wants
coordinator mode without a beacon (the backend rejects it) or local mode with a beacon
(meaningless).

### Locked decisions (from grilling)

| #     | Decision                                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1    | Fully per-surface. Drop the global `spawnBackend`. No backward-compat requirement.                                                                                                                                                            |
| Q2/Q3 | Mode is **inferred** from `config.targetBeaconId` presence. No explicit `spawnBackend` field. No gateway-wide `targetBeaconId`.                                                                                                               |
| Q4    | `coordinatorUrl`/`coordinatorToken` stay gateway-wide. Drop `spawnBackend` + `targetBeaconId` from `config.json`.                                                                                                                             |
| Q5    | New `SpawnBackendRegistry` class; `GatewayEngine` ctor becomes `(config, backends, swarm?)`.                                                                                                                                                  |
| Q6    | `ctx.spawnBackend` stays **required**; engine injects the inferred backend. `resolveTargetBeaconId` drops its coordinator-mode guard.                                                                                                         |
| Q7    | Loader hard-requires `coordinatorUrl` iff **any** loaded surface is a coordinator-mode spawner **or** a `swarm-console`.                                                                                                                      |
| Q8    | New `src/surfaces/requirements.ts` with `SURFACES_REQUIRING_COORDINATOR`.                                                                                                                                                                     |
| Q9    | Replace `createSpawnBackend` with `createSpawnBackends(config, coordinatorClient?)` returning a `SpawnBackendRegistry`; register `local` always, `coordinator` iff a client is supplied. Delete the "Unknown spawn backend type" exit path.   |
| Q10   | A **spawning** surface with a present-but-invalid `targetBeaconId` is a **hard load error**.                                                                                                                                                  |
| Q11   | Shared `resolveSurfaceSpawnMode(spec): 'local' \| 'coordinator'` in `requirements.ts`.                                                                                                                                                        |
| Q12   | Loader **hard-errors** on the now-removed keys (`spawnBackend`, gateway-level `targetBeaconId`) in `config.json`.                                                                                                                             |
| Q13   | `SpawnBackendRegistry` mirrors `SurfaceRegistry` (`register`/`get`/`types` + duplicate guard). Startup log lists registered backend types.                                                                                                    |
| Q14   | Startup logs each conversation's resolved surface modes once.                                                                                                                                                                                 |
| Q15   | **Scope expansion:** improve the `--persona`-not-found message (agent side). No gateway load-time check.                                                                                                                                      |
| Q15a  | Do **not** force swarm connectivity on locally-spawned children (no `--plugin swarm` from the gateway). Connectivity stays governed by the child's config cascade.                                                                            |
| Q16   | Reword the message **and** make `LocalSpawnBackend` drain child stderr into the gateway logger (so it is visible in `journalctl`).                                                                                                            |
| Q17   | Only `SPAWNING_SURFACES` may carry `config.targetBeaconId`; a `targetBeaconId` on any other surface is warned about and **dropped**.                                                                                                          |
| Q18   | Two-branch not-found message, chosen by config introspection (`enabledPlugins.includes('swarm')`).                                                                                                                                            |
| Q19   | An **explicit** `--persona` that will not resolve is **fatal** (throw from the persona-broker `onSessionStart`; `exitCode=1`).                                                                                                                |
| Q20   | Fatality applies to explicit requests only; `config.activePersona` stays lenient.                                                                                                                                                             |
| Q21   | Fatality applies to the **`--persona` flag only**; `DRONE_PERSONA` env and `config.activePersona` stay lenient.                                                                                                                               |
| Q22   | Drop `options.persona ??= process.env.DRONE_PERSONA` from `cli.ts`; `runtimeOptions.persona` becomes the explicit flag only. The broker resolves flag (**fatal**) → `process.env.DRONE_PERSONA` (lenient) → `config.activePersona` (lenient). |
| Q23   | `LocalSpawnBackend` detects a child that exits before its first `turnComplete(stream close)` and returns an error string (with the stderr tail) instead of `''`.                                                                              |
| Q24   | Uniform fatality on every path (CLI, gateway-local, beacon-spawn). A doomed beacon spawn row is reconciled by ADR 231.                                                                                                                        |
| Q25   | A configured `coordinatorUrl` with no needing surface is silently accepted (unused backend/client registered).                                                                                                                                |
| Q26   | Extend stderr-tail capture to the one-shot inject helper (`src/inject/spawn-once.ts`).                                                                                                                                                        |
| Q27   | The broker picks the Q18 branch by config introspection (`registration.getConfig().enabledPlugins.includes('swarm')`), no cross-plugin import.                                                                                                |
| Q28   | Docs: new ADR `238`, gateway `CONTEXT.md`, roadmap memory; wiki follows via ingest.                                                                                                                                                           |
| Q29   | Dedupe `CoordinatorClient`: build **one** instance and inject it into both `ctx.swarm` and `CoordinatorSpawnBackend`.                                                                                                                         |
| Q30   | Keep the `swarm-console` fail-closed guard; reword to "Swarm console requires a configured coordinatorUrl."                                                                                                                                   |

**Explicitly deferred (NOT in this plan):** surfacing the persona failure into chat from the _agent_ side (Q16 "C"); beacon-side persona pre-validation before spawn (Q24 "B").

---

## 2. Verified facts (line anchors; re-confirm before editing)

> Line numbers are as read on 2026-10-08 (`main` @ `6547791`). **Re-read each file immediately before editing.**

**drone-gateway**

- `src/types.ts:94` `export type SpawnBackendType = 'local' | 'coordinator';`; `:110` `GatewayConfig.spawnBackend`; `:113-114` its doc comment; `:116` `targetBeaconId?`.
- `src/spawn-backend.ts:27` `SpawnBackend` interface; `:39-43` `spawnSession(conv, persona, opts?)`; `:54-58` `sendMessage`; `:63` `terminateSession`.
- `src/local-spawn-backend.ts` — ctor `(agentPath?)` `:24`; `spawnSession` `:28`; args `['--output-json', …]` `:67-81`; `sendMessage` `:116` (readline loop, returns `lastAssistantMessage` after loop); `terminateSession` `:181`.
- `src/coordinator-spawn-backend.ts` — `:15` class; `:22-27` ctor `(coordinatorUrl, coordinatorToken)` builds its **own** `CoordinatorClient`; `:29`/`:55` spawn; `:103` `sendMessage` (returns `null`); `:124` `terminateSession`.
- `src/engine.ts` — `:91-103` ctor `(config, spawnBackend, swarm?)`; `:109` startup log; `:339-347` `createControlSurface`; `:354-363` `resolveTargetBeaconId` (`:359` guards on `this.spawnBackend.type !== 'coordinator'`); `:365-375` `surfaceContext` (`:369` `spawnBackend`, `:370` `swarm`); `:92`/`:98`/`:102` swarm field.
- `src/surfaces/types.ts:9-38` `SurfaceContext` (`:10` `spawnBackend`, `:12` `swarm`).
- `src/surfaces/registry.ts:3-20` `SurfaceRegistry` (the pattern to mirror).
- `src/surfaces/builtins.ts:6-10` `registerBuiltInSurfaces` (3 types).
- `src/surfaces/swarm-console.ts:22-27` the fail-closed message.
- `src/config/load.ts` — `:67-149` `sanitizeSurfaceConfig` (`:90-95` targetBeaconId); `:267-268` computes `spawnBackend`; `:270-283` coordinatorUrl required-iff-coordinator; `:286-318` targetBeaconId gateway-level validation; `:340-341` writes both into config; `:434-…` surface-parsing loop.
- `src/index.ts` — `:77-79` late default; `:84-102` `createSpawnBackend` switch + unknown exit; `:138-143` builds backend + gated swarm client + `new GatewayEngine(...)`.
- `src/inject/spawn-once.ts` — `:63` `child.stderr.resume()` (discarded); `:100-105` `SpawnOnceFailureError(lastError ?? exit code)`.

**drone-agent**

- `src/cli.ts:181` `options.persona = argv[++i]`; `:268` `options.persona ??= process.env.DRONE_PERSONA;` (inside the `default`-kind branch, after the workflow/positional returns).
- `src/index.tsx:211` `persona: invocation.options.persona` into `runtimeOptions`; `:356` `engine.initialize()`; `:371-372` `onPluginsLoaded` then `onSessionStart`; `:579-588` `main().catch` → `process.exitCode = 1`.
- `src/runtime/plugin-engine.ts:961` `runtimeOptions.persona` → `_runtime`; `:1002-1020` `runHooks` (re-throws all hooks except `onBeforePrompt`).
- `src/plugins/persona/index.ts` — `:41` providers; `:44-67` precedence merge; `:236-256` `activatePersona` (warn at `:247-249`, returns `null`); `:265` `selectPersona`; `:342-369` `onSessionStart` activation (fatal path target; old warn at `:365-367`); `:29-35` plugin metadata (`defaultEnabled: false`).
- `src/plugins/swarm/index.ts:69-83` swarm metadata (`defaultEnabled:false`; deps `persona`+`config`); `:214-223` requests `persona` cap; `:247` uses `runtimeInfo.persona` for the `sessionStarted` event fallback.
- `src/plugins/swarm/providers.ts:107-124` registers `swarm-persona-beacon` (PRECEDENCE_SWARM) + `swarm-persona-coordinator` (PRECEDENCE_COORDINATOR).
- `drone-swarm-common/src/spawner.ts:114-130` beacon spawner passes `--swarm --output-json --persona <id>`.

**Tests to touch:** gateway `engine.test.ts`, `index.test.ts`, `config-load.test.ts`, `coordinator-spawn-backend.test.ts`, `swarm-console-surface.test.ts`, `local-spawn-backend.test.ts`, `inject-spawn-once.test.ts`, `surface-registry.test.ts`; agent `persona-cli-flag.test.ts` (+ `persona-select.test.ts`, `local-spawn-*` as needed).

---

## 3. Execution plan

Agents: **coder** implements; **tester** writes/adjusts unit tests; **review** verifies. Phases 1–8 run in order. Steps inside a phase are sequential unless noted; phases 2, 6 depend on their producer phase.

### Phase 1 — `drone-gateway`: core per-surface backend (coder)

**Step 1.1 — New `src/surfaces/requirements.ts`.**
Exports a `SurfaceSpawnMode` type, two `ReadonlySet<string>` constants, and the shared inference helper used by both the loader and the engine.

```ts
import type { ControlSurfaceSpec } from '../types.js';

export type SurfaceSpawnMode = 'local' | 'coordinator';

/** Surface types that spawn agents and therefore may name a target beacon. */
export const SPAWNING_SURFACES: ReadonlySet<string> = new Set([
  'persona-assignment',
]);

/** Surface types that require a coordinator connection (whether or not they spawn). */
export const SURFACES_REQUIRING_COORDINATOR: ReadonlySet<string> = new Set([
  'swarm-console',
]);

/**
 * A surface's spawn mode is inferred: a surface that names a
 * `config.targetBeaconId` spawns via the coordinator on that beacon; any other
 * surface spawns locally.
 */
export function resolveSurfaceSpawnMode(
  spec: ControlSurfaceSpec
): SurfaceSpawnMode {
  const beacon = spec.config?.targetBeaconId;
  return typeof beacon === 'string' && beacon.trim() !== ''
    ? 'coordinator'
    : 'local';
}
```

**Step 1.2 — New `src/spawn-backend-registry.ts`.** Mirror `SurfaceRegistry`.

```ts
import type { SpawnBackend } from './spawn-backend.js';
import type { SpawnBackendType } from './types.js';

export class SpawnBackendRegistry {
  private backends = new Map<SpawnBackendType, SpawnBackend>();

  register(type: SpawnBackendType, backend: SpawnBackend): void {
    if (this.backends.has(type)) {
      throw new Error(`Duplicate spawn backend: ${type}`);
    }
    this.backends.set(type, backend);
  }

  get(type: SpawnBackendType): SpawnBackend | undefined {
    return this.backends.get(type);
  }

  types(): SpawnBackendType[] {
    return [...this.backends.keys()].sort();
  }
}
```

**Step 1.3 — `src/types.ts`: drop the global fields.**
Remove `spawnBackend: SpawnBackendType;` and `targetBeaconId?: string;` (and their JSDoc) from `GatewayConfig`. **Keep** `export type SpawnBackendType = 'local' | 'coordinator';` (the registry keys on it). Update the `GatewayConfig` doc comment to describe the per-surface inference.

**Step 1.4 — `src/config/load.ts`: validation rewrite.**

- At the top of `loadGatewayConfig` (before anything else), **reject removed keys**:

```ts
for (const removed of ['spawnBackend', 'targetBeaconId'] as const) {
  if (gatewayConfig[removed] !== undefined) {
    throw new Error(
      `Removed config field "${removed}": the spawn backend is now chosen per ` +
        `control surface. A spawning surface that sets ` +
        `controlSurfaces[].config.targetBeaconId spawns via the coordinator; ` +
        `any other spawning surface spawns locally. Delete "${removed}" from config.json.`
    );
  }
}
```

- Read `coordinatorUrl`/`coordinatorToken` as before, but **delete** the `spawnBackend` computation (`:267-268`) and the coordinatorUrl required-iff-coordinator block (`:270-283`) and the gateway-level targetBeaconId block (`:286-318`). Do not warn about either key.
- Change `sanitizeSurfaceConfig` to take the surface `type` and enforce Q10/Q17:

```ts
if (rest.targetBeaconId !== undefined) {
  if (!SPAWNING_SURFACES.has(type)) {
    warn(
      `surface type "${type}" does not spawn agents; ignoring its targetBeaconId`
    );
    delete rest.targetBeaconId;
  } else if (
    typeof rest.targetBeaconId !== 'string' ||
    rest.targetBeaconId.trim() === ''
  ) {
    throw new Error(
      `Control surface "${type}" in "${file}" (conversation "${convId}", ` +
        `adapter "${adapterId}") has an invalid targetBeaconId (expected a non-empty string).`
    );
  }
}
```

(`workingDir`, `lifecycle.idleTimeoutMs`, `batch.debounceMs` handling unchanged.)

- Build the `GatewayConfig` **without** `spawnBackend`/`targetBeaconId`.
- **After** all adapters/conversations are loaded, enforce Q7/Q25:

```ts
if (!coordinatorUrl && anySurfaceNeedsCoordinator(config.serviceAdapters)) {
  throw new Error(
    'Config missing required field: coordinatorUrl. At least one control surface ' +
      'requires the coordinator (a coordinator-mode spawner or a swarm-console surface).'
  );
}
```

with a local helper:

```ts
function anySurfaceNeedsCoordinator(
  adapters: ResolvedServiceAdapter[]
): boolean {
  for (const adapter of adapters) {
    for (const conv of adapter.conversations.values()) {
      for (const spec of conv.surfaces) {
        if (SURFACES_REQUIRING_COORDINATOR.has(spec.type)) return true;
        if (resolveSurfaceSpawnMode(spec) === 'coordinator') return true;
      }
    }
  }
  return false;
}
```

**Step 1.5 — `src/coordinator-spawn-backend.ts`: take an injected client (Q29).**
Change the ctor from `(coordinatorUrl, coordinatorToken)` to `(client: CoordinatorClient)`; store it; delete the internal `new CoordinatorClient(...)`. Everything else unchanged.

**Step 1.6 — `src/engine.ts`: registry + per-surface resolution.**

- Ctor `(config: GatewayConfig, backends: SpawnBackendRegistry, swarm?: SwarmApi)`; field `private backends: SpawnBackendRegistry;`.
- Startup log lists registered backends: `` `(spawn backends: ${this.backends.types().join(', ') || 'none'})` ``.
- In the per-conversation loop in `start()`, log each conversation's surfaces once (Q14):

```ts
logger.info(
  { adapterId: adapterConfig.id, conversationId: convId },
  `Conversation "${convId}" surfaces: ${conv.surfaces.map(s => this.describeSurface(s)).join(', ')}`
);
```

with:

```ts
private describeSurface(spec: ControlSurfaceSpec): string {
  if (!SPAWNING_SURFACES.has(spec.type)) return spec.type;
  const mode = resolveSurfaceSpawnMode(spec);
  const beacon = this.resolveTargetBeaconId(spec);
  return mode === 'coordinator' ? `${spec.type}(coordinator:${beacon})` : `${spec.type}(local)`;
}
```

- `resolveTargetBeaconId` loses the coordinator guard (Q6): return the sanitized `spec.config?.targetBeaconId` when it is a non-empty string, else `undefined`.
- `surfaceContext` injects `spawnBackend: this.resolveSpawnBackend(spec)` (new private method below) and `targetBeaconId: this.resolveTargetBeaconId(spec)`:

```ts
private resolveSpawnBackend(spec: ControlSurfaceSpec): SpawnBackend {
  const mode = resolveSurfaceSpawnMode(spec);
  const backend = this.backends.get(mode);
  if (!backend) {
    throw new Error(
      `No "${mode}" spawn backend is registered, but a "${spec.type}" surface requires it.`
    );
  }
  return backend;
}
```

**Step 1.7 — `src/index.ts`: registry factory + one shared client (Q9, Q29).**

- Replace `createSpawnBackend` with:

```ts
export function createSpawnBackends(
  config: GatewayConfig,
  coordinatorClient?: CoordinatorClient
): SpawnBackendRegistry {
  const registry = new SpawnBackendRegistry();
  registry.register('local', new LocalSpawnBackend(config.agentPath));
  logger.info(
    `Registered local spawn backend (agentPath: ${config.agentPath || 'drone-agent (from PATH)'})`
  );
  if (coordinatorClient) {
    registry.register(
      'coordinator',
      new CoordinatorSpawnBackend(coordinatorClient)
    );
    logger.info(
      `Registered coordinator spawn backend (${config.coordinatorUrl})`
    );
  }
  return registry;
}
```

- In `main()`: build the client once, reuse it for both the backend and the engine:

```ts
const coordinatorClient = config.coordinatorUrl
  ? new CoordinatorClient(config.coordinatorUrl, config.coordinatorToken)
  : undefined;
const backends = createSpawnBackends(config, coordinatorClient);
const engine = new GatewayEngine(config, backends, coordinatorClient);
```

- Remove the late `if (!config.spawnBackend) config.spawnBackend = 'local'` default in `loadConfig`, and the unknown-backend `process.exit(1)` path. Drop the now-unused `SpawnBackendType` import if it becomes unused.

**Step 1.8 — `src/surfaces/swarm-console.ts` (Q30).** Reword the fail-closed message to `"Swarm console requires a configured coordinatorUrl."` Keep the branch.

**Phase 1 gate:** `pnpm -r run build` after Phase 1.3 (types) so dependents resolve `dist/`.

### Phase 2 — `drone-gateway` tests (tester) — depends on Phase 1

- **New** `test/requirements.test.ts`: `resolveSurfaceSpawnMode` (present ⇒ coordinator; absent/empty/non-string ⇒ local); the two constants' contents.
- **New** `test/spawn-backend-registry.test.ts`: register/get/types + duplicate throw (mirror `surface-registry.test.ts`).
- `test/config-load.test.ts`: rewrite the coordinatorUrl + targetBeaconId blocks — removed keys throw; a coordinator-mode spawner with no `coordinatorUrl` throws; a `swarm-console` with no `coordinatorUrl` throws; a local-only gateway with no `coordinatorUrl` loads; a configured `coordinatorUrl` with no needing surface loads silently; an invalid `targetBeaconId` on a `persona-assignment` throws; a `targetBeaconId` on `swarm-console`/`discard` is dropped with a warning.
- `test/engine.test.ts`: drop `spawnBackend` from `makeMinimalConfig`; construct `GatewayEngine(config, registry, swarm?)` (build a `SpawnBackendRegistry` with the mock backend(s)); keep/adjust the beacon-resolution cases (default vs override vs local-undefined) to build the registry both ways; add a case where a coordinator surface with no coordinator backend registered throws the Q6 error; assert the startup logs list types.
- `test/index.test.ts`: replace `createSpawnBackend` tests with `createSpawnBackends` (local-only registry; local+coordinator registry when a client is passed); remove the "unknown spawn backend type" test; drop `spawnBackend` from config fixtures.
- `test/coordinator-spawn-backend.test.ts`: construct with a mock `CoordinatorClient` instead of `(url, token)`; keep all spawn/terminate assertions.
- `test/swarm-console-surface.test.ts`: update the expected fail-closed string.
- Confirm `surface-registry.test.ts`, `session-lifecycle.test.ts`, `persona-assignment-surface.test.ts` still pass unchanged (the `SurfaceContext` _shape_ is unchanged).

### Phase 3 — `drone-agent`: explicit-`--persona` validation (coder)

**Step 3.1 — `src/cli.ts` (Q22).** Delete the line `options.persona ??= process.env.DRONE_PERSONA;` (`:268`). Leave `DRONE_SUBAGENT_ID`/`DRONE_SESSION_ID` untouched. After this, `options.persona` is set **only** by `--persona`, so `runtimeOptions.persona` (`index.tsx:211`) is the explicit flag by construction.

**Step 3.2 — `src/plugins/persona/index.ts` (Q18/19/20/21/22/27).** Rewrite the `onSessionStart` activation hook:

```ts
registration.hooks.onSessionStart(async () => {
  const runtime = registration.request<{ persona?: string }>('runtime');
  const explicit = runtime?.persona; // --persona: FATAL if unresolved
  const envPersona = process.env.DRONE_PERSONA; // lenient
  const configured = config.activePersona; // lenient
  const candidate = explicit ?? envPersona ?? configured;
  if (!candidate) return;

  const activated = await activatePersona(candidate);
  if (activated) {
    registration.logger.info(
      `active persona: ${activated.name} (${activated.id})`
    );
    return;
  }

  const swarmEnabled = registration
    .getConfig()
    .enabledPlugins.includes('swarm');
  const message = swarmEnabled
    ? `persona "${candidate}" not found. Swarm personas are loaded, but none has id ` +
      `"${candidate}" — check the id and its scope (local/beacon/coordinator).`
    : `persona "${candidate}" not found. This agent is running WITHOUT swarm ` +
      `connectivity — if "${candidate}" is a swarm persona, enable the "swarm" plugin ` +
      `for this agent (see ~/.drone-agent/config.json).`;
  if (explicit) throw new Error(message);
  registration.logger.warn(message);
});
```

Also make `activatePersona` silent on miss (remove the `logger.warn` at `:247-249`; it currently double-logs on startup) and have the `selectPersona` capability (`:265`) log its own `persona "${id}" not found` when activation returns `null` (preserves the TUI capability's feedback). **Note the consequence:** because the env fallback moved into the broker, `DRONE_PERSONA` now applies to _all_ invocation kinds (previously only the `default` kind) — an accepted, documented widening of its scope.

**Step 3.3 — verify `src/plugins/swarm/index.ts:247`.** With the env fallback gone from `runtimeOptions.persona`, the `sessionStarted` event's persona fallback no longer sees `DRONE_PERSONA`. This is harmless (the active persona wins; the subagent passes `--persona` explicitly). No code change expected; add a one-line comment only if it clarifies.

### Phase 4 — `drone-agent` tests (tester) — depends on Phase 3

- `test/persona-cli-flag.test.ts`: an explicit `--persona X` that does not resolve **throws** (and, via `main()`, yields a non-zero exit); `DRONE_PERSONA=X` with X missing **warns** and continues; `config.activePersona` with X missing **warns** and continues; the message picks the swarm-absent branch when `enabledPlugins` lacks `swarm`, and the swarm-present branch when it includes it.
- Confirm `test/persona-select.test.ts` still passes given the `selectPersona` logging tweak; adjust if it asserted the old inner warning.
- `test/cli-swarm-flags.test.ts`: confirm unaffected.

### Phase 5 — `drone-gateway`: child stderr visibility + early-exit error (coder)

**Step 5.1 — `src/local-spawn-backend.ts` (Q16, Q23).**

- In `startSession`, attach a `readline` interface over `childProcess.stderr`; for each non-empty line: forward it to the gateway `logger` (e.g. `logger.info({ conversationId }, line)`), **and** push it into a bounded ring (`MAX_STDERR_LINES = 20`) stored on `ManagedAgentSession`.
- In `sendMessage`, track whether `turnComplete` was observed. On `turnComplete`, return `lastAssistantMessage` as today. If the readline loop over stdout ends **without** a `turnComplete` (child died / stdout closed), return an error string built from the ring (last ~10 lines, capped ~800 chars):

```ts
const tail = managed.stderrTail.join('\n').trim().slice(-800);
return `Error: agent exited before replying${tail ? `: ${tail}` : ''}`;
```

This replaces the current "return whatever we have" fallback. (The `persona-assignment` surface already posts any non-empty reply, so the reason reaches chat.)

**Step 5.2 — `src/inject/spawn-once.ts` (Q26).**

- Replace `child.stderr.resume()` with a buffered reader (same ring pattern).
- On non-zero exit, include the tail: `throw new SpawnOnceFailureError(lastError ?? \`Agent exited with code ${exitCode}: ${tail}\`);`.

### Phase 6 — `drone-gateway` tests (tester) — depends on Phase 5

- `test/local-spawn-backend.test.ts`: a child that closes stdout without `turnComplete` yields the `Error: agent exited before replying…` string (not `''`); stderr lines are captured into the message.
- `test/inject-spawn-once.test.ts`: a failing child surfaces the stderr tail in `SpawnOnceFailureError`.

### Phase 7 — Documentation (coder) — may run after Phase 1+3

- **New** `docs/adr/238-gateway-per-surface-spawn-backend.md`: context (the mixed-mode blocker), the inference rule, the registry, the loader rules (removed keys throw; coordinatorUrl required iff needed; invalid beacon on a spawner throws; stray beacon on a non-spawner dropped), the shared-client dedupe, and the persona-fix scope expansion (explicit `--persona` fatal; env/config lenient; new branchy message; stderr drain + early-exit error).
- Add a row to `docs/adr/index.md`.
- **`drone-gateway/CONTEXT.md`**: rewrite _Spawn Target Beacon_ (inference, no gateway-wide default), the _Swarm Console_ "requires coordinator" note → "requires a configured `coordinatorUrl`", the config-layout block (drop `spawnBackend`/`targetBeaconId`; document per-surface `config.targetBeaconId`), and the _Surface Registry_ entry (mention `SpawnBackendRegistry`).
- **Roadmap memory** (`memory__manage` key `roadmap`): update the Phase-4 "Gateway Spawn Targeting" entry to state the backend is per-surface and inferred from `config.targetBeaconId`.

### Phase 8 — Verification (review/tester)

Run the full Validation Criteria below; then commit. Per `AGENTS.md`, project memory/insights are checked in on a feature branch — commit the plan memory and any insights with the change.

---

## 4. Files changed (checklist)

**New**

- `drone-gateway/src/surfaces/requirements.ts`
- `drone-gateway/src/spawn-backend-registry.ts`
- `drone-gateway/test/requirements.test.ts`
- `drone-gateway/test/spawn-backend-registry.test.ts`
- `docs/adr/238-gateway-per-surface-spawn-backend.md`

**Modified (source)**

- `drone-gateway/src/types.ts`
- `drone-gateway/src/config/load.ts`
- `drone-gateway/src/coordinator-spawn-backend.ts`
- `drone-gateway/src/engine.ts`
- `drone-gateway/src/index.ts`
- `drone-gateway/src/surfaces/swarm-console.ts`
- `drone-gateway/src/local-spawn-backend.ts`
- `drone-gateway/src/inject/spawn-once.ts`
- `drone-agent/src/cli.ts`
- `drone-agent/src/plugins/persona/index.ts`

**Modified (tests)**

- `drone-gateway/test/{config-load,engine,index,coordinator-spawn-backend,swarm-console-surface,local-spawn-backend,inject-spawn-once}.test.ts`
- `drone-agent/test/persona-cli-flag.test.ts` (+ `persona-select.test.ts` if needed)

**Modified (docs)**

- `drone-gateway/CONTEXT.md`
- `docs/adr/index.md`

---

## 5. Validation criteria

All of the following must pass, **zero errors**:

1. **LSP:** diagnostics clean across the workspace (the connected TypeScript LSP must report no errors).
2. **Build:** `pnpm -r run build` exits 0 (run after the `drone-core`/types-bearing changes, since dependents resolve the built `dist/`).
3. **Typecheck:** `pnpm typecheck` exits 0.
4. **Lint:** `pnpm run lint` (ESLint + Prettier) exits 0. _(Reminder: prettier rewrites files — re-read before further edits.)_
5. **Tests (fast suite):** `pnpm run test` passes with zero failures; the `drone-gateway` and `drone-agent` suites are green.
6. **New coverage:** every new behavior has unit tests — `resolveSurfaceSpawnMode`, the two constants, `SpawnBackendRegistry`, the loader rules (removed keys; coordinatorUrl-required; invalid-beacon-on-spawner; stray-beacon-dropped; unused-url-accepted), the engine's per-surface backend selection + missing-backend throw, the reworded `swarm-console` message, the explicit-`--persona` fatality + two-branch message + lenient env/config, the stderr drain, the early-exit error string, and the inject-helper stderr tail.
7. **Dead-code sweep:** no `GatewayConfig.spawnBackend`; no gateway-wide `targetBeaconId`; no `createSpawnBackend(` (singular) references; no `'default'` beacon literal; no unused imports/params introduced.
8. **Behavioral spot-checks:**
   - A mixed config (one `persona-assignment` with `config.targetBeaconId: "x"`, one `persona-assignment` with none, one `swarm-console`) loads, logs both backends, and logs each conversation's resolved mode.
   - `coordinatorUrl` absent + a `swarm-console` conversation ⇒ load fails naming the field.
   - A `config.json` still containing `spawnBackend` or gateway-level `targetBeaconId` ⇒ load fails naming the removed key.
   - `drone-agent --persona does-not-exist` ⇒ non-zero exit with the explanatory message.
   - `DRONE_PERSONA=does-not-exist drone-agent` ⇒ warns, continues.
   - A gateway-local child whose agent exits at startup ⇒ the surface posts `Error: agent exited before replying: …` (not silence).

**Done when:** all eight criteria are satisfied.

---

## 6. Execution summary (2026-10-08) — COMPLETE

**Branch:** `feat/gateway-per-surface-spawn-backend`. **Commits:** `4f47a5ae` (plan + planning insights), `d78251a5` (feature).

All 20 phases executed. **Gates:** LSP clean; `pnpm -r run build` 0; `pnpm typecheck` 0; `pnpm run lint` 0; `pnpm run test` **3694 passed / 14 skipped / 0 failed** (gateway suite **461**).

**Deviations / notes:**

- Step 1.3 (`types.ts`) and several edit sites were mangled by fuzzy `apply_diff` anchors; repaired by rewriting the affected span or re-anchoring. `types.ts` was rewritten whole.
- `LocalSpawnBackend` tests: the mock's stderr was a `Writable`; the readline drain calls `input.resume()`, so the mock's stderr was switched to a `Readable` (+ an `emitStderrLine` helper).
- Phase 4 (`persona-cli-flag.test.ts`) needed a minimal `swarm` `DronePlugin` stub so `enabledPlugins: ['persona','swarm']` passes engine validation (the swarm plugin is not otherwise in that test's plugin list).
- `pnpm run lint` reflowed files repo-wide (the ADR-232 gotcha). Unrelated churn (all other ADRs, `pnpm-lock.yaml`, `.drone-agent/insights/*`, `drone-{beacon,coordinator}/README.md`, the other planning-seed memories) was reverted with `git checkout HEAD -- …` before committing; only session-relevant changes were kept.
- The plan's "Q10 hard error" is enforced with the extra `SPAWNING_SURFACES` constant, as planned.

**Deferred (not done, as planned):** agent-side chat surfacing of the persona failure (Q16 "C"); beacon-side persona pre-validation before spawn (Q24 "B").
