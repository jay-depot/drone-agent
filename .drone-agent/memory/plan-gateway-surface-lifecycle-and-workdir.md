---
key: plan-gateway-surface-lifecycle-and-workdir
tags:
  - plan
  - drone-gateway
  - drone-agent
  - lifecycle
  - working-dir
  - control-surface
  - spawn-backend
created: 2026-10-05T23:06:42.538Z
updated: 2026-10-05T23:06:42.538Z
---

# Plan: Gateway control-surface lifecycle management + per-surface working directory

**Branch:** `feat/gateway-surface-lifecycle-and-workdir` (already created and checked out)
**Origin:** planning session 2026-10-05
**Status:** READY FOR EXECUTION

## 1. What and why

Two related gaps in `drone-gateway`, plus one dead flag in `drone-agent`.

1. **No lifecycle management for spawned agents.** The `persona-assignment` control surface spawns one agent per conversation on the first message and **never terminates it**. Consequences: (a) agents leak when the gateway shuts down; (b) if the agent process dies (local `exit`, out-of-band coordinator terminate), the surface keeps handing a stale `SpawnSession` to `sendMessage` and errors forever; (c) memory/processes are never reclaimed.
2. **No per-bot filesystem identity.** Every bot inherits the gateway process cwd, so there is nowhere per-bot for memories and scratch files. A per-control-surface `workingDir` gives each (effectively) chat bot its own pseudo-"project" directory.
3. **`drone-agent --working-dir` is parsed but never consumed** (`drone-agent/src/cli.ts:156-157`; grep confirms no reader). Today only the spawner's `cwd` option actually takes effect. Fix it while we are in the area.

**Deferred (do NOT implement here):** conversation continuity / session *resume* across re-spawn. Continuity for now is the on-disk `workingDir`. Likely to lean on the swarm later. Also out of scope: per-sender sessions, streaming/partial replies, persona hot-switching.

## 2. Settled decisions (locked in the planning grilling)

| Topic | Decision |
|---|---|
| Lifecycle scope | All four: (1) idle-timeout terminate + lazy re-spawn; (2) death detection + one-shot re-spawn + retry the message once; (3) shutdown disposal; (4) **no session resume** — fresh in-memory context on re-spawn |
| `workingDir` location | **Per-surface only**, `controlSurfaces[].config.workingDir`. **No gateway-wide default.** Absent ⇒ behavior unchanged (local: inherit gateway cwd; coordinator: omit ⇒ beacon `defaultSpawnRoot`) |
| `workingDir` local whitelist | **None.** Any filesystem path. A nonexistent path surfaces as a spawn `error` event → existing error-as-response path |
| `workingDir` wiring | Loader validates → engine injects `ctx.workingDir` → surface passes to `spawnSession`. Surfaces never read raw config (ADR-004 pattern) |
| `workingDir` validation (load) | non-empty string else warn+drop; `~` / `~/` expands via `os.homedir()`; result must be **absolute** else warn+drop; length ≤ **4096** (`MAX_WORKING_DIR_LENGTH`); **no existence check at load** |
| Idle timeout | `config.lifecycle.idleTimeoutMs` (surface) ?? top-level `idleTimeoutMs` (config.json) ?? **300000 ms**. Reset on **turn completion** (never mid-turn). `unref()`'d timer. `0` **disables**. Same timer in both spawn modes. On expiry: `terminateSession` + drop session + log info |
| `--working-dir` fix | `process.chdir()` FIRST in `drone-agent/src/index.tsx` `main()`, before `loadAgentConfig`, `discoverExternalPlugins`, the engine, and every cwd-reading plugin. Throw a clear error if the path is missing or not a directory. Keep the spawner's `cwd` too |
| Local backend spawn | Sets `cwd: opts.workingDir` **and** appends `--working-dir <dir>` |
| Lifecycle ownership | **Surface-local.** New optional `dispose?(): Promise<void>` on `DroneControlSurface`, called by `GatewayEngine.stop()` for every instantiated surface. A shared `SessionLifecycle` helper owns the timer + spawn-on-demand + death-retry + terminate-on-idle/dispose |
| Concurrency | Serialize per conversation at the engine (promise-chain tail on `InstantiatedConversation`) so first-match-wins is deterministic; **plus** an internal tail in `SessionLifecycle` (load-bearing: a single wildcard surface instance can be reached from multiple conversationIds); **plus** in-flight spawn-promise caching in both backends |

## 3. Files touched

**drone-agent**
- NEW `src/working-dir.ts` — `applyWorkingDir()`
- `src/index.tsx` — call it first in `main()`
- NEW `test/working-dir.test.ts`

**drone-gateway**
- `src/types.ts` — `DroneControlSurface.dispose?`, `SpawnSessionOptions.workingDir?`, `GatewayConfig.idleTimeoutMs?`
- `src/surfaces/types.ts` — `SurfaceContext += workingDir?, idleTimeoutMs?`
- `src/config/load.ts` — sanitize `workingDir` + `lifecycle.idleTimeoutMs` + top-level `idleTimeoutMs`
- `src/coordinator-client.ts` — `spawnAgent` gains `config?: { workingDir?: string }`
- `src/local-spawn-backend.ts` — `cwd` + `--working-dir` + in-flight cache
- `src/coordinator-spawn-backend.ts` — pass `config.workingDir` + in-flight cache
- NEW `src/surfaces/lifecycle.ts` — `SessionLifecycle` + `DEFAULT_IDLE_TIMEOUT_MS`
- `src/surfaces/persona-assignment.ts` — rewrite on the helper, add `dispose`
- `src/engine.ts` — resolve ctx, per-conversation serialization, dispose on `stop()`
- NEW `test/session-lifecycle.test.ts`, NEW `test/persona-assignment-surface.test.ts`
- `test/config-load.test.ts`, `test/local-spawn-backend.test.ts`, `test/coordinator-spawn-backend.test.ts`, `test/engine.test.ts`, `test/surface-registry.test.ts` — update/add
- `CONTEXT.md`, NEW `docs/adr/005-surface-lifecycle-and-working-dir.md`

## 4. Step-by-step plan

Each step is atomic and independently testable. Agent types: **coder**, **tester**, **reviewer**. Execute top to bottom; "Depends on" lists blockers.

---

### A1 — (coder) Add `applyWorkingDir` and call it first in `main()`
**Depends on:** nothing.

Create `drone-agent/src/working-dir.ts`:

```ts
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Change the process working directory before any config/plugin discovery,
 * so cwd-derived project config, memories, macros and prompt files all resolve
 * against the intended directory. No-op when undefined.
 */
export async function applyWorkingDir(
  workingDir: string | undefined
): Promise<void> {
  if (!workingDir) return;
  const resolved = path.resolve(workingDir);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`--working-dir does not exist: ${workingDir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`--working-dir is not a directory: ${workingDir}`);
  }
  process.chdir(resolved);
}
```

In `drone-agent/src/index.tsx`, import it and make it the first statement of `main()` after arg parsing (before `createConsoleLogger`/`loadAgentConfig(process.cwd(), …)` at ~line 64 and `discoverExternalPlugins(process.cwd(), …)` at ~line 136):

```ts
async function main(): Promise<void> {
  const invocation = parseCliArgs(process.argv.slice(2));
  await applyWorkingDir(invocation.options.workingDir);
  const logger = createConsoleLogger('drone-agent', { ... });
  ...
```

Note: `index.tsx` calls `main()` at import time, so the helper must live in its own module (do not define+call it inside `index.tsx` at module scope in a way that breaks tests that import `index.tsx`).

### A2 — (tester) Unit-test `applyWorkingDir`
**Depends on:** A1.

New `drone-agent/test/working-dir.test.ts`: no-op when `undefined`; `chdir` to a temp dir (assert `process.cwd()` changed, restore afterwards in `afterEach`); throws on a nonexistent path; throws when the path is a file, not a directory.

---

### B1 — (coder) Gateway core types
**Depends on:** nothing.

In `drone-gateway/src/types.ts`:
- `DroneControlSurface` gains an optional `dispose?(): Promise<void>;` (document: called once by the engine at shutdown; must be idempotent and must not throw).
- `SpawnSessionOptions` gains `workingDir?: string;`.
- `GatewayConfig` gains `idleTimeoutMs?: number;` (documented: gateway-wide default; inert-but-valid in local mode).

### B2 — (coder) Extend `SurfaceContext`
**Depends on:** nothing.

In `drone-gateway/src/surfaces/types.ts`:
```ts
export interface SurfaceContext {
  spawnBackend: SpawnBackend;
  swarm: SwarmApi | undefined;
  targetBeaconId?: string;
  /** Engine-resolved per-surface working directory (already validated at load). */
  workingDir?: string;
  /** Engine-resolved idle timeout in ms (0 disables). Defaults applied by SessionLifecycle. */
  idleTimeoutMs?: number;
}
```

### B3 — (coder) Config loader validation
**Depends on:** B1.

In `drone-gateway/src/config/load.ts`:

Add at module top:
```ts
import os from 'node:os';
const MAX_WORKING_DIR_LENGTH = 4096;
```

Add sanitizers and extend `sanitizeSurfaceConfig` to handle all three surface keys (`targetBeaconId`, `workingDir`, `lifecycle.idleTimeoutMs`). `sanitizeSurfaceConfig` must keep returning the (possibly pruned) `config` bag; drop invalid keys with a warning naming the file+conversation.

```ts
function sanitizeWorkingDir(value: unknown, log: (msg: string) => void): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') { log('workingDir is not a non-empty string; ignoring'); return undefined; }
  let expanded = value;
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(2));
  if (!path.isAbsolute(expanded)) { log('workingDir must be an absolute path; ignoring'); return undefined; }
  if (expanded.length > MAX_WORKING_DIR_LENGTH) { log(`workingDir exceeds ${MAX_WORKING_DIR_LENGTH} chars; ignoring`); return undefined; }
  return path.normalize(expanded);
}

function sanitizeIdleTimeoutMs(value: unknown, log: (msg: string) => void): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { log('idleTimeoutMs must be a non-negative number; ignoring'); return undefined; }
  return value;
}
```

Also read the **top-level** `idleTimeoutMs` from `config.json` into `GatewayConfig.idleTimeoutMs` with the same `sanitizeIdleTimeoutMs` semantics (invalid ⇒ warn + omit).

### B4 — (tester) Config-loader tests
**Depends on:** B3.

Extend `drone-gateway/test/config-load.test.ts` (the only gateway config test file): valid absolute `workingDir` survives; relative `workingDir` dropped; `~/bots/x` expands to `homedir()/bots/x`; over-length dropped; non-string dropped; nested `lifecycle.idleTimeoutMs` valid survives / negative dropped; top-level `idleTimeoutMs` valid survives / invalid omitted.

---

### C1 — (coder) `CoordinatorClient.spawnAgent` accepts a spawn config
**Depends on:** B1.

In `drone-gateway/src/coordinator-client.ts`, widen the input:
```ts
async spawnAgent(input: {
  targetBeaconId: string;
  personaId?: string;
  task?: string;
  spawnId?: string;
  config?: { workingDir?: string };
}): Promise<unknown> {
  return this.mutate('POST', '/api/spawn', input, 'Spawn failed', true);
}
```
(The coordinator's `SpawnRequest.config` is `SpawnConfig { model?, preamble?, workingDir?, env? }`.)

### C2 — (coder) `LocalSpawnBackend`: cwd + `--working-dir` + in-flight cache
**Depends on:** B1.

In `drone-gateway/src/local-spawn-backend.ts`:
- Change the signature to `spawnSession(conversationId, personaId, opts?: SpawnSessionOptions)`.
- Add a `private pending = new Map<string, Promise<SpawnSession>>();` and make `spawnSession` return the in-flight promise when one exists (move the body into a private `startSession`).
- Build args: `['--output-json']`, then `--persona <id>` if `personaId`, then `--working-dir <dir>` if `opts?.workingDir`.
- Pass `cwd` only when `opts?.workingDir` is set:
```ts
const childProcess = spawn(resolvedPath, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  ...(opts?.workingDir ? { cwd: opts.workingDir } : {}),
});
```
- Record `workingDir: opts?.workingDir` on the returned `SpawnSession` (optional, aids debugging).

### C3 — (coder) `CoordinatorSpawnBackend`: forward `workingDir` + in-flight cache
**Depends on:** C1, B1.

In `drone-gateway/src/coordinator-spawn-backend.ts`:
- Add `private pending = new Map<string, Promise<SpawnSession>>();` and dedupe concurrent spawns per conversation (cache the promise; clear it in a `finally`).
- Pass the working dir through to the client:
```ts
const result = await this.coordinatorClient.spawnAgent({
  targetBeaconId,
  personaId,
  spawnId,
  ...(opts?.workingDir ? { config: { workingDir: opts.workingDir } } : {}),
});
```
- When `opts.workingDir` is absent, omit `config` entirely so the beacon applies `getDefaultSpawnRoot()`.

### C4 — (tester) Backend tests
**Depends on:** C2, C3.

- `test/local-spawn-backend.test.ts`: assert `spawn` is called with `cwd` and that `--working-dir` is in the args when a working dir is supplied; assert it is absent (and `cwd` omitted) otherwise; assert two concurrent `spawnSession` calls for one conversation spawn **once**.
- `test/coordinator-spawn-backend.test.ts`: assert `spawnAgent` receives `config: { workingDir }`; that `config` is omitted when no working dir; and concurrent-spawn dedup.

---

### D1 — (coder) `SessionLifecycle` helper
**Depends on:** B1, B2.

New `drone-gateway/src/surfaces/lifecycle.ts`:

```ts
import { logger } from '../logger.js';
import type { SpawnSession } from '../types.js';
import type { SurfaceContext } from './types.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface SessionLifecycleOptions {
  surfaceType: string;
  conversationId: string;
  personaId: string;
  ctx: SurfaceContext;
}

/**
 * Owns a surface's single agent session: spawn-on-demand, idle-timeout
 * termination, one-shot death recovery, and shutdown disposal. All work is
 * serialized on an internal tail so a surface instance shared by several
 * conversations (e.g. the wildcard) can never overlap two turns.
 */
export class SessionLifecycle {
  private session: SpawnSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: SessionLifecycleOptions) {
    this.idleTimeoutMs = opts.ctx.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureSession(): Promise<SpawnSession> {
    if (this.session) return this.session;
    const session = await this.opts.ctx.spawnBackend.spawnSession(
      this.opts.conversationId,
      this.opts.personaId,
      { targetBeaconId: this.opts.ctx.targetBeaconId, workingDir: this.opts.ctx.workingDir }
    );
    this.session = session;
    return session;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => { void this.expireIdle(); }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private async expireIdle(): Promise<void> {
    this.idleTimer = null;
    const session = this.session;
    if (!session || this.disposed) return;
    this.session = null;
    logger.info({ conversationId: this.opts.conversationId },
      `Idle timeout: terminating ${this.opts.surfaceType} agent`);
    try { await this.opts.ctx.spawnBackend.terminateSession(session); }
    catch (err) { logger.warn({ err }, 'Idle-timeout terminate failed'); }
  }

  async send(text: string): Promise<string> {
    return this.run(async () => {
      if (this.disposed) throw new Error('surface disposed');
      const session = await this.ensureSession();
      try {
        const response = await this.opts.ctx.spawnBackend.sendMessage(session, text);
        this.armIdleTimer();
        return response;
      } catch (err) {
        logger.warn({ err, conversationId: this.opts.conversationId },
          'sendMessage failed; re-spawning agent and retrying once');
        try { await this.opts.ctx.spawnBackend.terminateSession(session); } catch { /* best effort */ }
        if (this.session === session) this.session = null;
        const fresh = await this.ensureSession();
        const response = await this.opts.ctx.spawnBackend.sendMessage(fresh, text);
        this.armIdleTimer();
        return response;
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    if (!session) return;
    try { await this.opts.ctx.spawnBackend.terminateSession(session); }
    catch (err) { logger.warn({ err }, 'Dispose terminate failed'); }
  }
}
```

### D2 — (tester) `SessionLifecycle` tests
**Depends on:** D1.

New `drone-gateway/test/session-lifecycle.test.ts` with a mock `SpawnBackend` and Vitest fake timers: spawn-once-then-reuse; idle timeout fires `terminateSession` and clears the session, and the next `send` re-spawns; `idleTimeoutMs: 0` never fires; timer resets after each successful turn; `sendMessage` throwing triggers exactly one re-spawn + retry and succeeds; a second failure propagates; `dispose()` terminates and is idempotent; concurrent `send()` calls do not overlap (internal tail).

---

### E1 — (coder) Rewrite `persona-assignment` on the helper
**Depends on:** D1.

`drone-gateway/src/surfaces/persona-assignment.ts` becomes:

```ts
import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import { SessionLifecycle } from './lifecycle.js';

export const createPersonaAssignmentSurface: SurfaceFactory = (
  spec, conversationId, ctx
) => {
  if (!spec.personaId) {
    throw new Error('persona-assignment control surface requires personaId');
  }
  const personaId = spec.personaId;
  const lifecycle = new SessionLifecycle({ surfaceType: 'persona-assignment', conversationId, personaId, ctx });

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: async (msg: AdapterMessage) => {
      try {
        return { response: await lifecycle.send(msg.text), handled: true };
      } catch (err) {
        logger.error({ err, conversationId, personaId },
          'Error handling message via persona-assignment surface');
        return { response: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, handled: true };
      }
    },
    dispose: () => lifecycle.dispose(),
  };
};
```

Keep the `{ response: 'Error: …', handled: true }` contract (tests depend on it).

### E2 — (tester) Surface tests
**Depends on:** E1.

New `drone-gateway/test/persona-assignment-surface.test.ts` (a dedicated file, rather than only the indirect registry tests): missing `personaId` throws; first message spawns then sends; second message reuses the session; idle timeout terminates; a dropped agent is re-spawned and the message retried; `dispose()` terminates; `spawnSession` receives `{ targetBeaconId, workingDir }` from `ctx`; errors become `Error: …` responses.

---

### F1 — (coder) Engine: resolve ctx, serialize dispatch, dispose on stop
**Depends on:** B2, B3, B1.

In `drone-gateway/src/engine.ts`:

1. Extend the conversation record and initialize the tail:
```ts
type InstantiatedConversation = {
  allowedSenders?: string[];
  surfaces: DroneControlSurface[];
  tail: Promise<unknown>;
};
// init:
byConv.set(convId, { allowedSenders: conv.allowedSenders, surfaces, tail: Promise.resolve() });
```

2. Replace the per-surface context builder so it resolves all three:
```ts
private surfaceContext(spec: ControlSurfaceSpec): SurfaceContext {
  const cfg = spec.config ?? {};
  const lifecycle = cfg.lifecycle as { idleTimeoutMs?: number } | undefined;
  return {
    spawnBackend: this.spawnBackend,
    swarm: this.swarm,
    targetBeaconId: this.resolveTargetBeaconId(spec),
    workingDir: cfg.workingDir as string | undefined,
    idleTimeoutMs: lifecycle?.idleTimeoutMs ?? this.config.idleTimeoutMs ?? undefined,
  };
}
```
(`createControlSurface` calls `this.surfaceContext(spec)`; `resolveTargetBeaconId` stays as-is.)

3. Serialize dispatch per conversation, keyed on the conversation that will actually run:
```ts
function runOnTail<T>(conv: InstantiatedConversation, fn: () => Promise<T>): Promise<T> {
  const result = conv.tail.then(fn, fn);
  conv.tail = result.then(() => undefined, () => undefined);
  return result;
}
```
In `handleMessage`, after computing `exact`/`wildcard`:
```ts
const exactApplies = exact !== undefined && senderAllowed(exact.allowedSenders, msg.senderId);
const queue = exactApplies ? exact : wildcard;
if (!queue) return;
await runOnTail(queue, async () => {
  const candidates = [
    ...(exactApplies ? exact!.surfaces : []),
    ...(wildcard && senderAllowed(wildcard.allowedSenders, msg.senderId) ? wildcard.surfaces : []),
  ];
  for (const surface of candidates) {
    const result = await surface.handleMessage(msg);
    if (result.handled) {
      if (result.response) { const a = this.adapters.get(msg.adapterId); if (a) await a.sendMessage(msg.conversationId, result.response); }
      return;
    }
  }
  logger.debug({ adapterId: msg.adapterId, conversationId: msg.conversationId }, 'Message unhandled by any control surface');
});
```

4. Dispose every surface in `stop()` (after adapters stop, before clearing):
```ts
for (const byConv of this.controlSurfaces.values()) {
  for (const conv of byConv.values()) {
    for (const surface of conv.surfaces) {
      if (surface.dispose) {
        try { await surface.dispose(); }
        catch (err) { logger.warn({ err }, 'Surface dispose failed'); }
      }
    }
  }
}
```

### F2 — (tester) Engine tests
**Depends on:** F1.

Update `drone-gateway/test/engine.test.ts`: the beacon-resolution assertions read `spy.mock.calls[0][2]` and must now compare `{ targetBeaconId: 'beacon-default', workingDir: undefined }` (and the override / local cases likewise). Add: `ctx.workingDir` reaches `spawnSession` when the surface config sets it; two concurrent messages for one conversation run serially (second `handleMessage` begins only after the first resolves); `stop()` calls `dispose()` on instantiated surfaces.

### G1 — (tester) Registry test exact-arg sweep
**Depends on:** E1.

Update `drone-gateway/test/surface-registry.test.ts`: the persona-assignment assertions now expect `spawnSession` called with `('conv-1', 'coder', { targetBeaconId: undefined, workingDir: undefined })` and `('conv-1', 'coder', { targetBeaconId: 'beacon-9', workingDir: undefined })`. Belt-and-suspenders: `grep -rn "targetBeaconId: " drone-gateway/test` for any other exact-object assertion.

---

### H1 — (coder) Documentation
**Depends on:** F1, E1.

- Add an ADR `drone-gateway/docs/adr/005-surface-lifecycle-and-working-dir.md` capturing: surface-local lifecycle ownership; `dispose()` on `DroneControlSurface`; the `SessionLifecycle` helper; `workingDir` as a per-surface config key with the validation rules and no local whitelist; the idle-timeout precedence and `0`-disables semantics; no session resume (continuity = workingDir); and the concurrency rule (engine tail + helper tail + backend in-flight dedup).
- Extend `drone-gateway/CONTEXT.md` glossary: new **Working Directory**, **Idle Timeout**, **Surface Disposal**; amend **Persona Assignment** (now lifecycle-managed), **Control Surface** (`dispose?`), **Spawn Target Beacon** (working dir resolved the same way). Update the Config Layout block with `idleTimeoutMs` (top-level) and `workingDir` / `lifecycle.idleTimeoutMs` (surface config).
- Optionally refresh the `roadmap` project memory's Phase 4 gateway inventory.

---

### I1 — (reviewer) Full validation
**Depends on:** all of the above.

Run the complete validation suite (section 5) and inspect the diff for: dead code removed, no unused variables, no fluff comments, no duplicated session logic (the helper is the single source), and that both backends remain symmetric.

## 5. Validation criteria

All must pass. Do not consider the job done until every item is green.

1. **LSP diagnostics clean** for every touched file (`drone-agent` and `drone-gateway`), zero errors and zero warnings.
2. **Build:** `pnpm -r run build` — zero errors. (Run this before relying on LSP/typecheck in dependent packages, since they resolve built `dist/`.)
3. **Typecheck:** `pnpm typecheck` — zero errors.
4. **Lint (the project-specific "linting" process):** `pnpm run lint` — zero errors. Note: this runs Prettier on success; re-read any file before editing it again.
5. **Fast tests:** `pnpm run test` — all green, including the new `working-dir`, `session-lifecycle`, and `persona-assignment-surface` suites and the updated `config-load`, `engine`, `surface-registry`, `local-spawn-backend`, and `coordinator-spawn-backend` suites.
6. **Behavioral acceptance (manual, document the result):**
   - A gateway config with a per-surface `config.workingDir` spawns the local agent with that directory as both `cwd` and `--working-dir`, and the agent's project config/memories resolve there.
   - In coordinator mode, an in-whitelist `workingDir` is accepted by the beacon; an out-of-whitelist one is rejected with the beacon's existing `workingDir … is not in the spawnRoots whitelist` error surfaced as an `Error: …` chat reply.
   - `config.lifecycle.idleTimeoutMs: 1000` terminates the agent after ~1s idle; the next message re-spawns; `0` keeps it alive indefinitely.
   - Killing the agent process out-of-band causes the next message to re-spawn and still return a reply.
   - SIGINT/SIGTERM on the gateway terminates every spawned agent.
7. **Dead code / fluff sweep:** `--working-dir` is now consumed (not dead); `MAX_WORKING_DIR_LENGTH` is used; no leftover `'default'` beacon fallback; no unused imports/vars/comments introduced.

## 6. Out of scope (explicitly deferred)

- Conversation continuity / session resume across re-spawn (later; likely swarm-leveraged).
- Per-sender sessions; streaming/partial replies; persona hot-switching; gateway hot-reload.