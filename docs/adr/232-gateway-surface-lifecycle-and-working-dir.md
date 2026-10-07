---
tags: [decision, gateway, spawn, lifecycle, working-dir, control-surface, config, architecture, adr]
related: [modules/drone-gateway.md, concepts/spawn-backend.md, modules/drone-agent.md, decisions/224-gateway-spawn-targeting.md, decisions/223-gateway-swarm-console-control-surface.md, decisions/197-beacon-cwd-roots.md, decisions/231-agent-termination-ladder-and-reconcile.md]
---

# 232 — Gateway surface lifecycle management + per-surface working directory

**Status**: Implemented (2026-10-05) · **Branch**: `feat/gateway-surface-lifecycle-and-workdir` · **Commits**: `81f3e203` (plan) + `c4fd39f4` (feature) + `aaf40e0d` (plan summary + insights) · **Plan**: project-memory `plan-gateway-surface-lifecycle-and-workdir` — *deleted from project memory after ingest* · **Gateway ADR**: merged into this page (2026-10-06) — the former in-tree `drone-gateway/docs/adr/005-surface-lifecycle-and-working-dir.md` copy was deleted

**Summary**: The gateway's spawning control surface (`persona-assignment`) spawned one agent per conversation on the first message and **never terminated it**. Three consequences followed: agents leaked on gateway shutdown, a dead agent poisoned its conversation forever, and nothing reclaimed memory. Separately, every bot inherited the gateway process cwd, so there was nowhere per-bot for memories and scratch files. This ADR adds **surface-local lifecycle management** (idle-timeout terminate + lazy re-spawn, one-shot death detection + retry, shutdown disposal) behind a shared `SessionLifecycle` helper, gives each control surface its own **working directory**, serializes dispatch **per conversation**, and fixes the long-dead `drone-agent --working-dir` flag. Deliberately **no session resume**: continuity across a re-spawn is the on-disk working directory.

## Why

The `persona-assignment` surface held one `SpawnSession` forever: it spawned lazily on the first message and never called `terminateSession`. `GatewayEngine.stop()` stopped adapters but never disposed surfaces, so every spawned agent outlived the gateway. And if the agent process died (a local `exit`, or an out-of-band coordinator terminate), the local backend dropped it from its map while the surface kept handing the **stale** session to `sendMessage`, which errored on every subsequent message — a conversation that could never recover. There was also **no per-bot filesystem identity**: all bots shared the gateway cwd, so memories and scratch files had no home.

The dispatch path was also **concurrent**: `adapter.onMessage(msg => { void this.handleMessage(msg); })` never awaited the previous message, so two messages in one conversation could both observe `session === null`, both call `spawnSession`, and both create a process (the second overwriting the first in the backend map), and `LocalSpawnBackend.sendMessage` opens a fresh `readline` over the persistent child `stdout` on every call, so concurrent readers would steal each other's NDJSON lines.

Finally, `drone-agent --working-dir` was **parsed but never consumed** (`cli.ts`); the spawner's `cwd` option was the only mechanism that actually took effect, masking the dead flag.

## Locked design decisions (7)

1. **Surface-local lifecycle ownership via a shared `SessionLifecycle`.** Lifecycle lives in the surface, not the backend. A new `surfaces/lifecycle.ts` owns a surface's single agent session: spawn-on-demand, idle-timeout termination, one-shot death recovery, and shutdown disposal. Reusable by future spawning surfaces (e.g. `mention-router`).
2. **`dispose()` on `DroneControlSurface`, called by the engine.** New optional `dispose?(): Promise<void>`; `GatewayEngine.stop()` calls it once for every instantiated surface **after** adapters stop. Implementations are idempotent and never throw (the engine logs and swallows).
3. **Idle timeout with precedence and `0`-disables.** `config.lifecycle.idleTimeoutMs` (surface) ?? gateway-wide `idleTimeoutMs` ?? **300000 ms**. The timer resets on turn **completion** (never mid-turn), is `unref()`'d, is cleared in `dispose()`, and `0` disables it. Same timer in both spawn modes. On expiry: `terminateSession` + drop the session + log at info; the next message lazily re-spawns.
4. **No session resume — continuity is the working directory.** A re-spawn (after idle or death) starts a fresh agent with fresh in-memory context; continuity comes from the on-disk `workingDir`. Resume across re-spawn is explicitly deferred (likely to lean on the swarm).
5. **`workingDir` is per-surface config, validated at load.** `controlSurfaces[].config.workingDir`; **no** gateway-wide default. Absent ⇒ unchanged (local mode inherits the gateway cwd; controller mode omits the field so the beacon applies its `defaultSpawnRoot`). The loader warns-and-drops anything invalid (non-empty string; `~`/`~/` expands via `os.homedir()` and must resolve absolute; length ≤ 4096; **no existence check**). The engine injects the validated value as `ctx.workingDir`; the surface passes it to `spawnSession` (the ADR-004 pattern — surfaces never read raw config). Local mode has no whitelist; coordinator mode's whitelist is enforced beacon-side by the existing `spawnRoots` check, surfacing an out-of-whitelist dir as the beacon's own `Error: …` reply.
6. **`--working-dir` applies an early `process.chdir()`.** In `drone-agent`, `applyWorkingDir()` runs as the first statement of `main()` after arg parsing — before config load, external-plugin discovery, the engine, and every cwd-reading plugin. It throws a clear error if the path is missing or is not a directory. The spawner's `cwd` option is **kept** (belt-and-suspenders), and the local backend both sets `cwd` and appends `--working-dir <dir>`.
7. **Per-conversation serialization plus in-flight spawn dedup.** The engine serializes dispatch per conversation with a promise-chain tail on the instantiated-conversation record, keyed on the conversation that actually runs (exact match when the sender is allowed, otherwise the wildcard). `SessionLifecycle` also serializes internally (load-bearing: a single wildcard surface instance can be reached from multiple `conversationId`s). Both spawn backends additionally cache the in-flight spawn promise per conversation. A queued message arriving after an idle-terminate simply re-spawns.

## Implementation

- `drone-agent/src/working-dir.ts` (**new**) — `applyWorkingDir(workingDir)`; `index.tsx` calls it first in `main()`.
- `drone-gateway/src/types.ts` — `DroneControlSurface.dispose?()`; `SpawnSessionOptions.workingDir?`; `SpawnSession.workingDir?`; `GatewayConfig.idleTimeoutMs?`.
- `drone-gateway/src/surfaces/types.ts` — `SurfaceContext` gains engine-resolved `workingDir?` and `idleTimeoutMs?`.
- `drone-gateway/src/config/load.ts` — new `sanitizeWorkingDir` (`~`/`~/` expansion, absolute, ≤ 4096, no existence check) and `sanitizeIdleTimeoutMs` (finite non-negative; `0` valid); `sanitizeSurfaceConfig` now prunes all three surface keys with warnings; top-level `idleTimeoutMs` read into the config.
- `drone-gateway/src/coordinator-client.ts` — `spawnAgent` input gains `config?: { workingDir?: string }`.
- `drone-gateway/src/local-spawn-backend.ts` — `spawnSession(conv, persona, opts?)`; passes `cwd: opts.workingDir` **and** appends `--working-dir <dir>`; records `workingDir` on the session; per-conversation in-flight spawn-promise cache.
- `drone-gateway/src/coordinator-spawn-backend.ts` — forwards `config: { workingDir }` (omitting `config` entirely when absent so the beacon applies `defaultSpawnRoot`); records `workingDir`; in-flight spawn cache.
- `drone-gateway/src/surfaces/lifecycle.ts` (**new**) — `SessionLifecycle` + `DEFAULT_IDLE_TIMEOUT_MS = 300_000`: spawn-on-demand, idle-timeout terminate + lazy re-spawn, one-shot death detection (a throwing `sendMessage` → best-effort terminate + clear → re-spawn → retry once; a second failure propagates), idempotent `dispose()`, internal serial tail.
- `drone-gateway/src/surfaces/persona-assignment.ts` — rewritten on `SessionLifecycle`; gains `dispose: () => lifecycle.dispose()`; keeps the `{ response: 'Error: …', handled: true }` contract.
- `drone-gateway/src/engine.ts` — `surfaceContext(spec)` now resolves `targetBeaconId` + `workingDir` + `idleTimeoutMs`; `InstantiatedConversation` gains a `tail` and dispatch is serialized per conversation via `runOnTail`; `stop()` disposes every instantiated surface after adapters stop.
- Plus gateway `CONTEXT.md` (glossary: *Working Directory*, *Idle Timeout*, *Surface Disposal*; amended *Persona Assignment*, *Control Surface*, *Spawn Registry*, *Spawn Target Beacon*; config layout) and the gateway ADR 005.

## Validation

LSP clean; `pnpm -r run build` (8 packages) exit 0; `pnpm typecheck` exit 0; `pnpm run lint` exit 0; root `pnpm test` **3555 passed / 14 skipped / 0 failed**. Gateway suite **338 passed / 24 files**. New suites: `session-lifecycle.test.ts` (10), `persona-assignment-surface.test.ts` (9), `working-dir.test.ts` (4). Updated: `config-load.test.ts` (29, +7), `local-spawn-backend.test.ts` (16, +3), `coordinator-spawn-backend.test.ts` (12, +3), `engine.test.ts` (18, +3 and exact-arg updates), `surface-registry.test.ts` (10, exact-arg updates). Behavioral checks: `--working-dir /nonexistent` fails loudly with `--working-dir does not exist: …`; a per-surface `workingDir` reaches `spawnSession` as `{ targetBeaconId, workingDir }`; two concurrent messages for one conversation run serially; `stop()` terminates a live session.

## Implementation notes (gotchas)

- **`apply_diff` mangles files whose change zone contains template-literal lines.** A hunk over `test/engine.test.ts` whose zone held `` order.push(`start:${text}`) `` collapsed the surrounding newlines and swallowed a trailing `describe` block (esbuild: "Unexpected end of file"). Caught by the build gate; repaired by truncating at the last good line and re-appending the tail via a quoted heredoc. Same failure family as the swarm-wiki page `drone-agent-plan-execution-verification-lessons` (lesson 3), which warns against `apply_diff` on interpolated template lines — it holds for the *surrounding block*, not just the line itself.
- **`pnpm run lint` runs `prettier --write .` repo-wide and `pnpm-lock.yaml` is not in `.prettierignore`** (only `dist/` is), so lint dirtied the tree with a ~5877-line lockfile reflow plus unrelated `.drone-agent/insights/*.json` newline fixes. Reverted with `git checkout HEAD -- pnpm-lock.yaml .drone-agent/insights/ …` before committing, keeping only reformats of files actually changed this session. (Already recorded in `.drone-agent/insights/project/tooling.json`; it recurred.)

## Out of scope (explicitly deferred)

- Conversation continuity / session **resume** across re-spawn (continuity is the on-disk `workingDir`; likely swarm-leveraged later).
- Per-sender sessions; streaming/partial replies; persona hot-switching; gateway hot-reload.

## Related

- [[modules/drone-gateway]] — the gateway module page (config model, key files, types, surfaces).
- [[concepts/spawn-backend]] — the `SpawnBackend` interface (the `workingDir` option + in-flight dedup).
- [[modules/drone-agent]] — `applyWorkingDir` + `--working-dir` now consumed.
- [[decisions/224-gateway-spawn-targeting]] — the sibling per-surface config pattern (`targetBeaconId`) this ADR extends.
- [[decisions/223-gateway-swarm-console-control-surface]] — the engine `SurfaceRegistry` the new `dispose()` hook hangs off.
- [[decisions/197-beacon-cwd-roots]] — the beacon `spawnRoots` whitelist that enforces coordinator-scope `workingDir`.
- [[decisions/231-agent-termination-ladder-and-reconcile]] — the terminate ladder the idle/dispose paths drive.
