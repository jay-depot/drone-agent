# ADR 005: Surface Lifecycle Management and Per-Surface Working Directory

**Status:** Accepted

**Context:** The gateway's spawning control surface (`persona-assignment`) spawned one agent per conversation on the first message and never terminated it. Three consequences followed. (a) Agents leaked on gateway shutdown: `GatewayEngine.stop()` stopped adapters but never disposed surfaces, so every spawned agent outlived the gateway. (b) A dead agent poisoned its conversation forever: local `exit` or an out-of-band coordinator terminate removed the session from the backend's map, but the surface kept handing the stale `SpawnSession` to `sendMessage`, which then errored on every subsequent message. (c) Nothing reclaimed memory. Separately, every bot inherited the gateway process cwd, so there was nowhere per-bot for memories and scratch files.

The dispatch path also ran messages concurrently: `adapter.onMessage(msg => { void this.handleMessage(msg); })` never awaited the previous message, so two messages in one conversation could both observe `session === null`, both call `spawnSession`, and both end up with a fresh process (the second overwriting the first in the backend map). In local mode, `LocalSpawnBackend.sendMessage` opens a fresh `readline` over the persistent child `stdout` on every call, so concurrent readers would steal each other's NDJSON lines.

Finally, `drone-agent --working-dir` was parsed (`cli.ts`) but never consumed — the spawner's `cwd` option was the only mechanism that actually took effect.

## Decision 1: Surface-local lifecycle ownership via `SessionLifecycle`

**Decision:** Lifecycle is owned by the surface, not the backend. A shared `SessionLifecycle` helper (`surfaces/lifecycle.ts`) owns a surface's single agent session: spawn-on-demand, idle-timeout termination, one-shot death recovery, and shutdown disposal. Surfaces reuse it instead of re-implementing the state machine.

**Rationale:** The surface knows the idle clock, the conversation, and whether it currently has a live session; the backend stays a transport that already does idempotent-ish spawn + `sendMessage` + `terminateSession`. One helper keeps the state machine singular and reusable by future spawning surfaces (`mention-router`).

## Decision 2: `dispose()` on `DroneControlSurface`, called by the engine

**Decision:** `DroneControlSurface` gains an optional `dispose?(): Promise<void>`, called once by `GatewayEngine.stop()` for every instantiated surface across every adapter, after adapters stop. Implementations must be idempotent and must not throw; the engine logs and swallows failures.

**Rationale:** The engine already built and held every surface instance; it simply never asked them to clean up. Disposal is surface-local (not backend-wide) because only the surface knows whether it still holds a live session to terminate.

## Decision 3: Idle timeout with precedence and `0`-disables

**Decision:** The idle timeout is `config.lifecycle.idleTimeoutMs` (surface) ?? top-level `idleTimeoutMs` (config.json) ?? **300000 ms**. The timer resets on **turn completion** (never mid-turn, so a long-running turn cannot trip it). The timer is `unref()`'d so a pending idle timer cannot hold the process open, and it is cleared in `dispose()`. `0` disables the timer. The same timer runs in both local and coordinator mode. On expiry the helper calls `terminateSession`, drops the cached session, and logs at info; the next message lazily re-spawns.

**Rationale:** A shared default is harmless here (it is just a number), unlike `workingDir` where a shared default would be a footgun. Resetting on completion is the only point at which the agent is provably not mid-turn. `0` preserves the pre-existing keep-it-forever behavior as an escape hatch.

## Decision 4: No session resume — continuity is the working directory

**Decision:** Re-spawn (after idle or death) starts a fresh agent with fresh in-memory LLM context. Continuity is carried by the on-disk `workingDir` (memories and scratch files), not by resuming the old agent. Session resume across re-spawn is explicitly deferred.

**Rationale:** Resume is a materially larger feature (persist and reattach `agentId`/`sessionId`). The on-disk project directory is the lightweight continuity mechanism for now; resume is expected to lean on the swarm later.

## Decision 5: `workingDir` is per-surface config, validated at load

**Decision:** A conversation's surfaces may set `controlSurfaces[].config.workingDir`. There is **no** gateway-wide default. Absent means behavior is unchanged: local mode inherits the gateway cwd; coordinator mode omits the field so the beacon applies its `defaultSpawnRoot`. The loader validates it (non-empty string; `~`/`~/` expands via `os.homedir()` and must resolve absolute; length ≤ 4096; no existence check) and warns-and-drops anything invalid. The engine injects the validated value as `ctx.workingDir`; the surface passes it to `spawnSession` (ADR-004 pattern — surfaces never read raw config).

**Rationale:** Each bot gets its own pseudo-project, so a shared default would be meaningless and a footgun (two bots sharing one scratch dir). Local mode has no whitelist (the gateway host trusts its own config); coordinator mode's whitelist is enforced beacon-side by the existing `spawnRoots` check, and an out-of-whitelist `workingDir` surfaces as the beacon's own error, rendered as an `Error: …` chat reply.

## Decision 6: `--working-dir` applies an early `process.chdir()`

**Decision:** In `drone-agent`, `applyWorkingDir()` runs as the first statement of `main()` after argument parsing, before config load, external-plugin discovery, the engine, and every plugin that reads `process.cwd()`. It throws a clear error if the path is missing or is not a directory. The spawner's `cwd` option is kept as well (belt-and-suspenders), and the local backend both sets `cwd` and appends `--working-dir <dir>`.

**Rationale:** A flag that sets a process-wide cwd must take effect before anything derives a path from `process.cwd()`. A nonexistent path must fail loudly rather than silently staying in the old cwd.

## Decision 7: Per-conversation serialization plus in-flight spawn dedup

**Decision:** The engine serializes dispatch per conversation with a promise-chain tail on the instantiated-conversation record, keyed on the conversation that will actually run (exact match when the sender is allowed, otherwise the wildcard). `SessionLifecycle` also serializes internally (load-bearing: a single wildcard surface instance can be reached from multiple `conversationId`s). Both spawn backends additionally cache the in-flight spawn promise per conversation. A queued message that arrives after an idle-terminate simply re-spawns.

**Rationale:** The engine tail is the single choke point that makes first-match-wins ordering deterministic and stops two messages sharing one agent. The helper tail and backend dedup are defense-in-depth and keep the backends honest for a future caller that is not the engine.

## Consequences

- `DroneControlSurface` gains optional `dispose?`.
- `SpawnSessionOptions` gains `workingDir?`; `SpawnSession` gains a recorded `workingDir?`.
- `GatewayConfig` gains `idleTimeoutMs?`.
- `SurfaceContext` gains `workingDir?` and `idleTimeoutMs?`.
- New modules: `drone-agent/src/working-dir.ts`, `drone-gateway/src/surfaces/lifecycle.ts`.
- An out-of-whitelist coordinator `workingDir` is rejected by the beacon (existing behavior), surfaced as an `Error: …` reply.
- Deferred: conversation continuity / session resume; per-sender sessions; streaming replies; persona hot-switching; gateway hot-reload.
