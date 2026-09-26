---
key: plan-gateway-spawn-target-beacon
tags:
  - plan
  - drone-gateway
  - spawn
  - targetBeaconId
  - coordinator
created: 2026-09-26T20:11:38.663Z
updated: 2026-09-26T20:11:38.663Z
---

# Plan: Gateway spawn targeting — wire `targetBeaconId` end-to-end

**Status:** READY FOR EXECUTION
**Package:** `drone-gateway`
**Branch context:** `feat/gateway-swarm-console`

---

## 1. Summary — what and why

`CoordinatorSpawnBackend` (`drone-gateway/src/coordinator-spawn-backend.ts`) accepts an optional `targetBeaconId` constructor argument and silently falls back to the string `'default'`. `createSpawnBackend()` (`drone-gateway/src/index.ts`) never passes the argument, and `GatewayConfig` has no field for it — so the value is **unreachable from configuration**. Every spawn routed through the backend's default path targets a beacon named `"default"`, which does not exist. The coordinator's `POST /api/spawn` requires `targetBeaconId` and returns `BEACON_NOT_FOUND` (404) for an unknown beacon, so today the failure is loud but deeply confusing.

This is latent: the only surface that spawns through the default path is `persona-assignment`; the `swarm-console` surface passes a beacon id explicitly per command (`swarm.beacon.spawn <beaconId>`), and `swarm.agent.terminate` resolves the beacon by scanning. But persona routing over chat is the entire point of the gateway, and it is the exact trap the next phase walks into.

**The fix:** make the target beacon a first-class, configurable value.

- A **gateway-wide default** `targetBeaconId` in `config.json`, required whenever `spawnBackend: "coordinator"`.
- A **per-conversation override** at `controlSurfaces[].config.targetBeaconId`, resolved by the engine as `override ?? gateway default`.
- The **backend stops holding ambient state**: `spawnSession` takes the beacon explicitly, `SpawnSession` records the beacon it actually used, and `terminateSession` kills on _that_ beacon — so a per-conversation override cannot terminate the wrong target.
- The `'default'` fallback string is **deleted**.

---

## 2. Decisions (locked during planning)

| #   | Question                                                  | Decision                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Resolution strategy for the beacon                        | **(A)** Config-only. No dynamic `listBeacons()` auto-selection.                                                                                                                                                                                                             |
| Q2  | Where the gateway-level requirement is enforced           | **(A1)** In the config loader, hard-failing in coordinator mode — mirrors the existing `coordinatorUrl` validation. Constructor param type loses its optionality.                                                                                                           |
| Q3  | Per-conversation override in scope?                       | **(B)** Yes — gateway-wide default **plus** per-conversation override.                                                                                                                                                                                                      |
| Q3b | Where the override lives                                  | **(B)** In the surface config bag: `controlSurfaces[].config.targetBeaconId`. **Not** a conversation-level field.                                                                                                                                                           |
| Q4  | Termination targeting                                     | **(B)** `spawnSession` receives the beacon explicitly; the backend holds **no** ambient beacon field; `SpawnSession.targetBeaconId` records it; `terminateSession` uses `session.targetBeaconId`.                                                                           |
| Q5  | Precedence resolution site                                | **(A)** The engine resolves `spec.config.targetBeaconId ?? config.targetBeaconId` once per conversation and injects the resolved value into that conversation's `SurfaceContext.targetBeaconId`. Surfaces never read raw config.                                            |
| Q6  | `targetBeaconId` configured while `spawnBackend: "local"` | **(B)** Warn (non-fatal) at load, ignore it; engine passes `undefined` into the context in local mode.                                                                                                                                                                      |
| Q7  | Field name and validation                                 | Name `targetBeaconId`. Gateway-level: non-empty string, **throw** if invalid in coordinator mode, **warn-and-ignore** if invalid in local mode. Per-conversation override: **warn-and-ignore** (fall back to gateway default) if invalid — mirroring `parseAllowedSenders`. |
| Q8  | Docs and live config                                      | **(A)** In scope: new ADR 004, `drone-gateway/CONTEXT.md` updates, roadmap inventory update. The live `"ambiorix"` value is a **documented post-merge manual step** — there is no `~/.drone-gateway/` on this host to edit.                                                 |
| Q9  | Test scope                                                | As enumerated in Step 10. Coordinator backend additionally throws a clear local error if invoked without a beacon (defensive; unreachable given loader validation).                                                                                                         |

**Explicitly out of scope:** dynamic beacon discovery/auto-selection; validating the beacon id against the coordinator at startup (the coordinator may be unreachable at boot, and a bad value now fails honestly on first spawn).

---

## 3. Interfaces (target shapes)

### `drone-gateway/src/types.ts`

```ts
export interface GatewayConfig {
  coordinatorUrl: string;
  coordinatorToken?: string;
  spawnBackend: SpawnBackendType;
  /**
   * Gateway-wide default beacon for coordinator-mode spawns. Required when
   * `spawnBackend` is "coordinator"; inert (and warned about) in local mode.
   */
  targetBeaconId?: string;
  agentPath?: string;
  serviceAdapters: ResolvedServiceAdapter[];
}

export interface SpawnSession {
  conversationId: string;
  personaId: string;
  processId: string;
  startedAt: number;
  /** The beacon the spawn was placed on. Coordinator mode only. */
  targetBeaconId?: string;
}

export interface SpawnSessionOptions {
  /** Beacon to spawn on. Required in coordinator mode. */
  targetBeaconId?: string;
}
```

### `drone-gateway/src/spawn-backend.ts`

```ts
spawnSession(
  conversationId: string,
  personaId: string,
  opts?: SpawnSessionOptions
): Promise<SpawnSession>;
```

JSDoc note on the interface: implementations may ignore `opts` when beacon targeting is not applicable (local mode).

### `drone-gateway/src/surfaces/types.ts`

```ts
export interface SurfaceContext {
  spawnBackend: SpawnBackend;
  swarm: SwarmApi | undefined;
  /**
   * Resolved by the engine: the conversation's `controlSurfaces[].config.targetBeaconId`
   * if valid, otherwise the gateway-wide default. Absent in local spawn-backend mode.
   */
  targetBeaconId?: string;
}
```

`targetBeaconId` is **optional**, so the two existing literal fake contexts in tests still typecheck (no churn required for that reason alone).

---

## 4. Implementation steps

Execute in order. Steps 1–9 are the feature; 10 is tests; 11 is docs; 12 is the final check.

### Step 1 — `drone-gateway/src/types.ts` (coder)

Add `targetBeaconId?: string` to `GatewayConfig`, `targetBeaconId?: string` to `SpawnSession`, and export a new `SpawnSessionOptions` interface (snippet in §3). Add the JSDoc above each as shown.

### Step 2 — `drone-gateway/src/spawn-backend.ts` (coder)

Change the `spawnSession` signature to take `opts?: SpawnSessionOptions` (snippet in §3). Import `SpawnSessionOptions` from `./types.js`. Extend the existing JSDoc block on the method to state that callers in coordinator mode must supply `opts.targetBeaconId`, and that implementations may ignore it otherwise.

### Step 3 — `drone-gateway/src/config/load.ts` (coder)

**(a) Gateway-level.** Immediately after the existing `coordinatorUrl` validation block (it ends with the `logger.warn(...)` for local mode), insert:

```ts
// targetBeaconId: required for coordinator mode; inert (warned) for local
const rawTargetBeaconId = gatewayConfig.targetBeaconId as string | undefined;
let targetBeaconId: string | undefined;
if (rawTargetBeaconId === undefined) {
  targetBeaconId = undefined;
} else if (
  typeof rawTargetBeaconId !== 'string' ||
  rawTargetBeaconId.trim() === ''
) {
  if (spawnBackend === 'coordinator') {
    throw new Error(
      'Config field targetBeaconId must be a non-empty string. ' +
        'This field is required when spawnBackend is "coordinator".'
    );
  }
  logger.warn(
    'Config field targetBeaconId is not a non-empty string; ignoring it.'
  );
  targetBeaconId = undefined;
} else {
  targetBeaconId = rawTargetBeaconId;
}

if (spawnBackend === 'coordinator' && !targetBeaconId) {
  throw new Error(
    'Config missing required field: targetBeaconId. ' +
      'This field is required when spawnBackend is "coordinator".'
  );
}

if (spawnBackend === 'local' && targetBeaconId) {
  logger.warn(
    'Config sets targetBeaconId but spawnBackend is "local" — the value has no effect.'
  );
}
```

Then add `targetBeaconId,` to the `const config: GatewayConfig = { ... }` object literal (alongside `coordinatorUrl`, `coordinatorToken`, etc.).

**(b) Per-conversation override.** Add a module-level helper next to `parseAllowedSenders`:

```ts
/**
 * Reads the optional `config.targetBeaconId` override on a control surface.
 * It must be a non-empty string; anything else is warned about and dropped so
 * the conversation falls back to the gateway-wide default.
 */
function sanitizeSurfaceConfig(
  config: Record<string, unknown> | undefined,
  adapterId: string,
  file: string,
  convId: string
): Record<string, unknown> | undefined {
  if (!config) return config;
  const override = config.targetBeaconId;
  if (override === undefined) return config;
  if (typeof override === 'string' && override.trim() !== '') return config;
  logger.warn(
    { adapterId, file, convId },
    `Control surface targetBeaconId in "${file}" is not a non-empty string; ignoring the override`
  );
  const rest = { ...config };
  delete rest.targetBeaconId;
  return rest;
}
```

Use it in the surface-parsing loop where the spec is pushed:

```ts
specs.push({
  type: spec.type as string,
  personaId: spec.personaId as string | undefined,
  config: sanitizeSurfaceConfig(
    spec.config as Record<string, unknown> | undefined,
    adapterId,
    file,
    convId
  ),
});
```

### Step 4 — `drone-gateway/src/coordinator-spawn-backend.ts` (coder)

- **Delete** the `private targetBeaconId: string;` field and the `targetBeaconId?: string` constructor parameter.
- Constructor becomes `(coordinatorUrl: string, coordinatorToken: string | undefined)`.
- `spawnSession(conversationId, personaId, opts?)`:

```ts
  async spawnSession(
    conversationId: string,
    personaId: string,
    opts?: SpawnSessionOptions
  ): Promise<SpawnSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      return existing;
    }

    const targetBeaconId = opts?.targetBeaconId;
    if (!targetBeaconId) {
      throw new Error(
        'CoordinatorSpawnBackend.spawnSession requires a targetBeaconId.'
      );
    }

    logger.info(
      `Spawning agent on beacon "${targetBeaconId}" for conversation ${conversationId} (persona: ${personaId})`
    );

    const spawnId = randomUUID();
    const result = await this.coordinatorClient.spawnAgent({
      targetBeaconId,
      personaId,
      spawnId,
    });

    const spawnResult = result as {
      spawnId: string;
      agentId: string;
      status: string;
    };

    const session: SpawnSession = {
      conversationId,
      personaId,
      processId: spawnResult.agentId || spawnResult.spawnId,
      startedAt: Date.now(),
      targetBeaconId,
    };

    this.sessions.set(conversationId, session);
    return session;
  }
```

- `terminateSession(session)`: read `session.targetBeaconId`; if absent, `logger.warn` and delete the map entry (no network call); otherwise call `this.coordinatorClient.terminateSpawn(session.targetBeaconId, session.processId)` inside the existing try/catch.

- Import `SpawnSessionOptions` from `./types.js`.

### Step 5 — `drone-gateway/src/local-spawn-backend.ts` (coder)

**No change required.** Its two-parameter `spawnSession(conversationId, personaId)` already satisfies the widened interface (TypeScript permits an implementation with fewer parameters). Deliberately do **not** declare an unused third parameter — that would only invite an unused-binding lint error. Do not set `targetBeaconId` on the session it returns (the field is optional and local spawns have no beacon).

### Step 6 — `drone-gateway/src/surfaces/persona-assignment.ts` (coder)

Pass the context's resolved beacon through:

```ts
session = await ctx.spawnBackend.spawnSession(conversationId, personaId, {
  targetBeaconId: ctx.targetBeaconId,
});
```

### Step 7 — `drone-gateway/src/engine.ts` (coder)

Add a resolver and thread the value into the context:

```ts
  /**
   * The beacon a conversation's spawns target: the surface override when
   * present, otherwise the gateway-wide default. Always undefined in local
   * mode, where there is no beacon.
   */
  private resolveTargetBeaconId(
    spec: ControlSurfaceSpec
  ): string | undefined {
    if (this.spawnBackend.type !== 'coordinator') return undefined;
    const override = spec.config?.targetBeaconId;
    if (typeof override === 'string' && override.trim() !== '') return override;
    return this.config.targetBeaconId;
  }
```

Update `createControlSurface` to pass it through, and `surfaceContext` to accept it:

```ts
return factory(
  spec,
  conversationId,
  this.surfaceContext(this.resolveTargetBeaconId(spec))
);
```

```ts
  private surfaceContext(targetBeaconId: string | undefined): SurfaceContext {
    return {
      spawnBackend: this.spawnBackend,
      swarm: this.swarm,
      targetBeaconId,
    };
  }
```

### Step 8 — `drone-gateway/src/index.ts` (coder)

`createSpawnBackend`, coordinator branch — drop the (never-passed) third constructor argument:

```ts
    case 'coordinator':
      logger.info(
        `Using coordinator spawn backend (default beacon: ${config.targetBeaconId ?? '(none)'})`
      );
      return new CoordinatorSpawnBackend(
        config.coordinatorUrl,
        config.coordinatorToken
      );
```

(The `'default'` literal must not survive anywhere in the package.)

### Step 9 — Dead-code sweep (coder)

Grep the package for `'default'` as a beacon value and for any remaining `targetBeaconId` ambient state:
`rg "targetBeaconId" drone-gateway/src drone-gateway/test`. Confirm the only remaining references are the config field, the option, the session field, the engine resolver, the surface pass-through, and tests.

---

## 5. Step 10 — Tests (coder, then reviewer)

All additions go in the existing files. `pnpm test` inside `drone-gateway` runs the suite.

### `test/config-load.test.ts`

- **throws when coordinator mode lacks `targetBeaconId`** — `{ coordinatorUrl, spawnBackend: 'coordinator' }` → rejects with a message containing `targetBeaconId`.
- **accepts `targetBeaconId` in coordinator mode** — loaded value equals the configured string.
- **throws when the gateway-level value is not a string** in coordinator mode (e.g. `42`).
- **local mode: warns but loads** — configured `targetBeaconId` + `spawnBackend: 'local'` → resolves, `config.targetBeaconId` retained.
- **per-conversation override: accepted** — a surface `{ type: 'persona-assignment', personaId: 'x', config: { targetBeaconId: 'b2' } }` survives parsing intact.
- **per-conversation override: invalid is dropped** — `config: { targetBeaconId: 42 }` → parsed surface has no `targetBeaconId` key (other `config` keys preserved), and load did not reject.

### `test/index.test.ts`

- extend `createSpawnBackend` coverage: the coordinator case still returns a coordinator-typed backend (two-argument construction), and `CoordinatorSpawnBackend` is constructed with exactly `(coordinatorUrl, coordinatorToken)` — assert via the mocked constructor's `mock.calls`.
- add `targetBeaconId: 'beacon-1'` to the coordinator-mode fixture configs and assert the backend is still constructed (no third argument).

### `test/coordinator-spawn-backend.test.ts`

- constructor becomes `(url, token)` — update `beforeEach`.
- **spawnSession passes the supplied beacon**: `spawnSession('conv-1', 'coder', { targetBeaconId: 'beacon-1' })` → `spawnAgent` called with `targetBeaconId: 'beacon-1'`; returned session's `targetBeaconId === 'beacon-1'`.
- **spawnSession throws without a beacon**: omit `opts` → rejects with `/requires a targetBeaconId/`; `spawnAgent` not called.
- **idempotency still holds** with the option supplied.
- **terminateSession targets the session's beacon, not a default**: spawn on `beacon-2`, terminate → `terminateSpawn` called with `('beacon-2', 'agent-xyz')`.
- **terminateSession warns (no throw, no call) when the session has no beacon**: hand-build a session without `targetBeaconId` → resolves, `terminateSpawn` not called.
- keep the existing "warns on failure but does not throw" case.

### `test/local-spawn-backend.test.ts`

No changes required (two-argument calls remain valid). Optionally add one case asserting a session spawned by the local backend has no `targetBeaconId`.

### `test/surface-registry.test.ts`

- the persona-assignment success assertion becomes
  `expect(spawnBackend.spawnSession).toHaveBeenCalledWith('conv-1', 'coder', { targetBeaconId: undefined });`
- add a case where the context supplies `targetBeaconId: 'beacon-9'` and assert it is forwarded.

### `test/swarm-console-surface.test.ts`

No functional change. The shared `makeSurface` helper may optionally accept `targetBeaconId` in its `Partial<SurfaceContext>` overrides — the field is optional, so nothing must change.

### `test/engine.test.ts`

Add a `describe('spawn target beacon resolution')` block driving a `persona-assignment` conversation and asserting the value the spawn backend received:

- **gateway default used when no override** — config `targetBeaconId: 'beacon-default'`, conversation `persona-assignment` with no `config` → `spawnSession` called with `{ targetBeaconId: 'beacon-default' }`.
- **per-conversation override wins** — conversation spec `config: { targetBeaconId: 'beacon-override' }` → `spawnSession` called with `{ targetBeaconId: 'beacon-override' }`.
- **local mode yields undefined** — `spawnBackend: 'local'` with a configured gateway default → `spawnSession` called with `{ targetBeaconId: undefined }`.

Note: `makeRespondingSpawnBackend()`'s `vi.fn` currently declares two parameters; widen it to `(conversationId, personaId, opts)` (or leave the implementation as-is and assert on `mock.calls[0][2]`) so the assertions read clearly.

---

## 6. Step 11 — Documentation (coder)

1. **New file `drone-gateway/docs/adr/004-gateway-spawn-targeting.md`.** Follow the ADR house style of 001–003 (Status / Context / Decision N / Rationale / Alternatives considered / Consequences). It must record: config-only targeting (dynamic `listBeacons()` resolution rejected); loader-level hard requirement in coordinator mode mirroring `coordinatorUrl`; the per-conversation override living in `controlSurfaces[].config.targetBeaconId` with engine-side precedence resolution; that the spawning backend holds no ambient beacon and `terminateSession` uses the session's own beacon (with the wrong-target hazard called out); the local-mode warn; and the deleted `'default'` fallback.
2. **`drone-gateway/CONTEXT.md`.** In the Config Layout block add `targetBeaconId?: string  # Gateway-wide default spawn beacon; required when spawnBackend is "coordinator"` next to `coordinatorUrl`, and show the override in the `controlSurfaces` example (e.g. `{ type: "persona-assignment", personaId: "...", config: { targetBeaconId: "other-beacon" } }`). Add a short glossary entry **Spawn Target Beacon** defining the resolved value and its precedence, and reference it from the _Persona Assignment_ entry.
3. **Roadmap.** Update the `roadmap` project memory's Phase 4 gateway inventory to note that coordinator-mode spawn targeting is wired (gateway default + per-conversation override), replacing the silent `'default'`.
4. Record `targetBeaconId: "ambiorix"` in the gateway `config.json` as a **post-merge manual step** in the plan's completion note (not a code task).

---

## 7. Step 12 — Final step: verify against the validation criteria

Run, in the repo root, and confirm every one passes:

```
pnpm -r run build
pnpm -r run lint
pnpm test            # fast suite (includes drone-gateway vitest)
```

Then walk §8 line by line and confirm each criterion is met, reporting any that are not.

---

## 8. Validation criteria

**Functional**

1. `GatewayConfig` has `targetBeaconId?: string`; `SpawnSession` has `targetBeaconId?: string`; `SpawnSessionOptions` exists and is exported.
2. `SpawnBackend.spawnSession` accepts `opts?: SpawnSessionOptions`; both built-in backends still satisfy the interface; `LocalSpawnBackend` compiles without an unused-parameter lint error.
3. The string literal `'default'` no longer appears anywhere as a beacon fallback in `drone-gateway/src`.
4. `CoordinatorSpawnBackend`'s constructor takes exactly `(coordinatorUrl, coordinatorToken)` and holds no beacon field; `createSpawnBackend` passes exactly two arguments.
5. Loading a coordinator-mode config without `targetBeaconId` **throws** with a message naming the field; with a valid value it loads and the value is retained.
6. A non-string/invalid gateway-level `targetBeaconId` throws in coordinator mode and is warned-and-ignored in local mode.
7. A valid per-conversation `controlSurfaces[].config.targetBeaconId` is preserved through config loading; an invalid one is warned about, dropped, and the load still succeeds.
8. The engine resolves `override ?? gateway default` per conversation and passes it via `SurfaceContext`; in local mode the context value is `undefined` regardless of config.
9. `persona-assignment` forwards `ctx.targetBeaconId` to `spawnSession`.
10. `CoordinatorSpawnBackend.terminateSession` targets `session.targetBeaconId`; a session lacking one is warned about and skipped without a network call.
11. `CoordinatorSpawnBackend.spawnSession` throws a clear error when invoked without a beacon.

**Tooling (mandatory)** 12. LSP diagnostics clean across the workspace (`pnpm -r run build`, i.e. `tsc -b`, passes with zero errors). 13. `pnpm -r run lint` passes with zero errors (this runs ESLint and then Prettier). 14. `pnpm test` (the fast suite) passes; `drone-gateway`'s vitest suite is green. 15. Every new behavior above is covered by a unit test in the files listed in Step 10; no dead code, unused bindings, or fluff comments are introduced (per `AGENTS.md` standards).

---

## 9. Risks / notes for the implementer

- **Interface widening is cross-cutting.** Adding the parameter to `SpawnBackend.spawnSession` touches every implementer and every test mock. Per the project principle, sweep all call sites with LSP `find_references` on `spawnSession` and `SpawnSession` before declaring the change complete.
- **The `surface-registry.test.ts` assertion at the persona-assignment success case will break** as soon as the surface passes a third argument — that is expected, not a regression.
- **Do not add startup beacon validation.** The coordinator may be down when the gateway boots; a wrong beacon now fails honestly on first spawn with the coordinator's own `BEACON_NOT_FOUND`.
- **`AGENTS.md` standards apply:** new behavior needs tests, dead code must be removed, and `pnpm -r run lint` reformats files — re-read any file before editing it again after a lint run.
- **Post-merge manual step (not a code task):** set `"targetBeaconId": "ambiorix"` in the gateway `config.json` on the machine that runs the gateway.

## Related memory

- `followup-swarm-spawn-terminate-beacon-restart` — spawn termination is lost across a beacon restart (separate, still-open issue; this plan does not address it).
- `followup-swarm-console-unbacked-commands` — swarm-console commands awaiting coordinator endpoints.
- `roadmap` — Phase 4 gateway inventory.
