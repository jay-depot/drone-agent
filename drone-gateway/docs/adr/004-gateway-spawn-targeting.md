# ADR 004: Gateway Spawn Targeting — Configurable Target Beacon

**Status:** Accepted

**Context:** `CoordinatorSpawnBackend` accepted an optional `targetBeaconId` constructor argument and silently fell back to the string `'default'`. `createSpawnBackend()` never passed the argument, and `GatewayConfig` had no field for it — so the value was unreachable from configuration. Every spawn routed through the backend's default path targeted a beacon named `"default"`, which does not exist. The coordinator's `POST /api/spawn` requires `targetBeaconId` and returns `BEACON_NOT_FOUND` (404) for an unknown beacon, so the failure was loud but deeply confusing.

The defect was latent: the only surface that spawned through the default path was `persona-assignment`. The `swarm-console` surface passed a beacon id explicitly per command (`swarm.beacon.spawn <beaconId>`), and `swarm.agent.terminate` resolved the beacon by scanning beacons and spawns. But persona routing over chat is the entire point of the gateway, and the missing wiring was the exact trap the next phase would walk into.

## Decision 1: Config-only resolution, no dynamic discovery

**Decision:** The target beacon is resolved from configuration only. There is no dynamic `listBeacons()` auto-selection.

**Rationale:**

- Resolution happens once, deterministically, from a value the operator wrote down. A beacon that is wrong fails on first spawn with the coordinator's own `BEACON_NOT_FOUND`, which is now an honest error rather than a mystery.
- Auto-selecting "the only connected beacon" adds an async network call to a constructor-adjacent path and an ambiguity rule that must be tested. It is better as a follow-up if multi-beacon gateways ever become real.

**Alternatives considered:**

- Dynamic fallback (config wins when set, otherwise `listBeacons()` and auto-select when exactly one beacon is connected): rejected for the added nondeterminism and network dependency.

## Decision 2: Loader-level requirement in coordinator mode

**Decision:** `loadGatewayConfig` requires `targetBeaconId` whenever `spawnBackend` is `"coordinator"`, throwing a clear error naming the field. It mirrors the existing `coordinatorUrl` validation exactly. The value must be a non-empty string.

**Rationale:**

- Keeping every "required config in coordinator mode" rule in one place (the loader) gives a single source of truth and a startup failure rather than a first-message failure.
- With the requirement in the loader, the spawning backend never needs an ambient default and the `'default'` fallback string is deleted outright.

**Consequences:** A coordinator-mode gateway whose conversations are only `swarm-console` or `discard` must still name a beacon, even though those surfaces never spawn via the default. That is acceptable for a single-beacon swarm (one line of config).

## Decision 3: Per-conversation override in the surface config bag

**Decision:** A conversation may override the gateway-wide default with `controlSurfaces[].config.targetBeaconId`. The engine resolves the effective value as `override ?? gateway default` and injects the resolved value into that conversation's `SurfaceContext`. Surfaces never read raw config.

**Rationale:**

- The beacon is a property of the spawn target for that conversation, and the override naturally lives on the spec that spawns.
- Resolving precedence in exactly one place (the engine) keeps surfaces dumb and the rule singular.
- A conversation can legitimately be `[swarm-console, persona-assignment]`, where the beacon applies only to the one surface that spawns; the surface-level bag expresses that without inventing a conversation-level field.

**Alternatives considered:**

- A conversation-level `targetBeaconId` field: rejected — the beacon is surface-specific, and the `config` bag already exists for surface options.
- Surface-side precedence resolution: rejected — it duplicates the rule into every future spawning surface.

## Decision 4: The backend holds no ambient beacon; termination uses the session's own beacon

**Decision:** `SpawnBackend.spawnSession` receives the beacon explicitly via `SpawnSessionOptions`. `CoordinatorSpawnBackend` holds no beacon field; it records the beacon it used on the returned `SpawnSession.targetBeaconId`, throws if invoked without one, and `terminateSession` targets `session.targetBeaconId`. A session lacking a beacon is warned about and skipped without a network call.

**Rationale:**

- With per-conversation overrides, a single ambient backend field would terminate a conversation that spawned on beacon `x` against the _default_ beacon — a silent wrong-target kill. Recording the beacon on the session makes the kill target the beacon the spawn actually landed on.
- No ambient state means exactly one source of truth, and `LocalSpawnBackend` stays symmetric (its two-parameter `spawnSession` already satisfies the widened interface and ignores the option).

**Consequences:** The `SpawnBackend.spawnSession` interface gains an optional `opts` parameter, so every implementer and test mock is affected.

## Decision 5: Inert in local mode

**Decision:** A configured `targetBeaconId` has no effect when `spawnBackend` is `"local"`. The loader warns (non-fatal) and retains the value; the engine passes `undefined` into the surface context in local mode regardless of config.

**Rationale:**

- The value is provably inert without a coordinator, and a loud one-time warning tells the operator they configured something that does nothing.
- A hard error would break a config that merely switched back from coordinator mode; `coordinatorUrl` is already allowed-but-warned in local mode, and `targetBeaconId` follows the same pattern.

## Decision 6: Invalid per-conversation override is dropped with a warning

**Decision:** A per-conversation `config.targetBeaconId` that is not a non-empty string is warned about and removed, so the conversation falls back to the gateway-wide default. The load still succeeds.

**Rationale:**

- Consistent with how `allowedSenders` validates today: one bad override should not kill the whole gateway, and the gateway default is a sane, working answer.

## Consequences

- `GatewayConfig` gains `targetBeaconId?: string`; `SpawnSession` gains `targetBeaconId?: string`; a new `SpawnSessionOptions` interface is exported.
- `SpawnBackend.spawnSession` accepts `opts?: SpawnSessionOptions`.
- `SurfaceContext` gains an engine-resolved `targetBeaconId?: string`.
- `CoordinatorSpawnBackend`'s constructor is `(coordinatorUrl, coordinatorToken)`; `createSpawnBackend` passes exactly two arguments and logs the default beacon.
- The `'default'` beacon fallback no longer exists anywhere in the package.
- **Post-merge manual step:** set `"targetBeaconId": "ambiorix"` in the gateway `config.json` on the machine that runs the gateway.
