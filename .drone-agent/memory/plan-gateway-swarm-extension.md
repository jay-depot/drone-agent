---
key: plan-gateway-swarm-extension
tags:
  - plan
  - drone-gateway
  - swarm-extension
  - mTLS
  - coordinator
  - extension-node
  - extension-hint
  - ADR-256
created: 2026-10-19T20:44:30.454Z
updated: 2026-10-19T20:44:30.454Z
---

# Plan: drone-gateway as a swarm extension (v0, sender role)

**Branch**: `feat/swarm-extensions`
**Status**: ready for execution. Next ADR number = **256**.
**Supersedes nothing**; extends ADR 254 (swarm extensions) with the gateway replatform it deferred.

## Summary — what and why

The drone-gateway connects chat conversations to drone swarm agents. Today the gateway talks to the coordinator with a Bearer token over the coordinator's web port (the `Coordinator Client`). This plan replaces that connection with a **swarm extension node**. The gateway then speaks the same mTLS protocol as a beacon (ADR 254).

Why: (1) one connection and one trust path replace two; (2) the node gives the gateway a session-event channel and a manifest, which the next phase uses for tool injection and prompt fragments; (3) the gateway stops needing a shared secret (`coordinatorToken`) and uses its own mTLS identity.

**v0 scope.** The gateway is only a **sender**. It sends spawn requests through the node's connection. It does **not** yet declare callable capabilities or ship a front-end bundle. This plan covers "the pipe".

**Not in this plan.** The callee direction, tool and prompt injection, the config UI, remote extensions, and the pre-approval-token flow.

## Decisions (locked in the planning session, Q1–Q15)

| #   | Decision                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The gateway is the **sender**. The extension connection is its outbound pipe for spawn requests. The callee direction is a later phase.                                               |
| D2  | Re-plumb the **Coordinator Client** onto the node's mTLS `getFetch()`. Keep the `CoordinatorClient` class and the `SwarmApi` interface. Drop `coordinatorToken`.                      |
| D3  | Extension hint value = `drone-gateway:<conversationId>`.                                                                                                                              |
| D4  | `coordinatorUrl` **presence** enables the extension. There is no separate flag. `coordinatorToken` is a **removed key** (a hard error if present).                                    |
| D5  | Optional `swarmExtension` block: `id` (default `drone-gateway`), `name` (default `Drone Gateway`), `dataDir` (default `<configDir>/extension`), `requestTimeoutMs` (default `15000`). |
| D6  | `coordinatorUrl` keeps its value (the primary/mTLS port, for example `http://127.0.0.1:3456`). The node makes the WebSocket URL from it.                                              |
| D7  | **One** extension node per gateway process.                                                                                                                                           |
| D8  | The gateway starts at once and registers in the background with retry. It does not wait for the coordinator.                                                                          |
| D9  | The manifest is **empty**: `{ protocolVersion: 1, capabilities: [], bundles: [] }`.                                                                                                   |
| D10 | The extension hint goes to **both** spawn backends (coordinator and local). In local mode it is inert today; the next phase needs it.                                                 |
| D11 | `sessionStarted` / `sessionEnded` handlers are wired, but they only write a debug log. Filtering by hint is the next phase.                                                           |
| D12 | The node's coordinator `fetch` has a **bounded request timeout**. Default `15000` ms. On timeout it rejects with `coordinator did not respond within <ms> ms`.                        |
| D13 | Shutdown order: stop the **Injection API**, stop the **GatewayEngine** (the agents terminate over the live node), stop the node, then exit. Terminate stays best-effort.              |
| D14 | New module `src/extension-node.ts` with an `ExtensionNodeHandle`. `main()` owns the handle. The **Coordinator Client** stays a transport only.                                        |
| D15 | The SDK gains `awaitRegistration` (default `true`). The gateway passes `false` and gets background retry.                                                                             |
| D16 | No change to the coordinator or the beacon. Both `SpawnConfig` types already carry `extensionHint`.                                                                                   |
| D17 | New ADR 256. Update `drone-gateway/CONTEXT.md`, `docs/agents/swarm-extensions.md`, and the swarm wiki. Add `drone-swarm-common` to the gateway's dependencies.                        |

## Key facts (verified against the code)

- The coordinator's `/api/*` routes are on **both** ports (`registerRoutes` runs inside `buildApp`). The primary port (`:3456`) has `enableMtls: true` and `/ws/beacon`.
- The web-auth hook only applies to **non-local** requests (`web-auth.ts:88-91`). A loopback caller bypasses it.
- `POST /api/spawn` forwards the `config` bag to the beacon (`drone-coordinator/src/routes/spawn.ts:66-82`). The spawner adds `--extension-hint` when `config.extensionHint` is set (`drone-swarm-common/src/spawner.ts:139-143`).
- Both `SpawnConfig` types already have `extensionHint?: string` (`drone-beacon/src/types.ts:78-84`, `drone-coordinator/src/types.ts:133-139`). Only the gateway's client type is narrow (`coordinator-client.ts:72`).
- The gateway's `CoordinatorClient.request` uses the global `fetch` with **no timeout** (`coordinator-client.ts:14-31`). `createCoordinatorFetch` uses `http`/`https.request` with **no timeout** (`coordinator-fetch.ts:70-100`).
- The beacon's reverse-channel retry is exponential backoff, 1 s to 30 s, without end. `attempts` resets on `open` (`drone-beacon/src/coordinator-ws.ts:135-142`, `:265`).
- The SDK already retries the **WebSocket** the same way (`extension-server.ts:293-301`). Only **registration** has no retry.
- A loopback registration is auto-approved (`drone-coordinator/src/db/beacon-trust.ts:115-121`).
- The engine serialises messages per conversation on a tail (`engine.ts:61-72`, `:228`). A slow spawn blocks only that conversation's tail.
- The `Coordinator Client` definition in `CONTEXT.md:230-234` says "web port (8080)" and "Bearer token authentication". Both become false.
- `coordinatorToken` exists only in `drone-gateway/src/{types,load}.ts`, `CONTEXT.md`, ADR 224, ADR 238. No render script or live `config.json` in this repo. ADR 224 set a precedent for a post-merge manual config step on the gateway host.

## Step-by-step plan

> **Order.** Steps 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Step 1 changes a dependency package, so Step 1 must come first. After Step 1, run `pnpm -r run build`. All steps are for the `code` persona.

### Step 1 — SDK: background registration, retry, and request timeout

**File: `drone-swarm-common/src/coordinator-fetch.ts`** — add one optional parameter:

```ts
export function createCoordinatorFetch(
  baseUrl: string,
  expectedCoordinatorFingerprint?: string,
  onFirstFingerprint?: (fp: string) => void,
  tlsIdentity?: TlsIdentity,
  timeoutMs?: number            // NEW
): typeof fetch {
```

After the request is made, add:

```ts
if (timeoutMs && timeoutMs > 0) {
  req.setTimeout(timeoutMs, () => {
    req.destroy(
      new Error(`coordinator did not respond within ${timeoutMs} ms`)
    );
  });
}
```

**File: `drone-swarm-common/src/extension-server.ts`** — extend the options:

```ts
export interface CreateExtensionNodeOptions {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  name: string;
  capabilities: DroneExtensionCapability[];
  handlers?: ExtensionNodeHandlers;
  awaitRegistration?: boolean; // NEW; default true
  requestTimeoutMs?: number; // NEW; default undefined
}
```

Give the fetch the timeout:

```ts
const cfetch = createCoordinatorFetch(
  opts.coordinatorUrl,
  undefined,
  undefined,
  tlsIdentity,
  opts.requestTimeoutMs
);
```

Add registration retry, with the beacon's backoff shape:

```ts
const REGISTER_RETRY_MIN_MS = 1000;
const REGISTER_RETRY_MAX_MS = 30000;
let registerAttempts = 0;
let registerTimer: NodeJS.Timeout | null = null;

const scheduleRegisterRetry = (): void => {
  if (stopped || registerTimer) return;
  const delay = Math.min(
    REGISTER_RETRY_MIN_MS * 2 ** registerAttempts,
    REGISTER_RETRY_MAX_MS
  );
  registerAttempts++;
  registerTimer = setTimeout(() => {
    registerTimer = null;
    void tryRegister();
  }, delay);
};

const tryRegister = async (): Promise<void> => {
  if (stopped) return;
  try {
    await register();
    registerAttempts = 0;
    connect();
  } catch (err) {
    logger.warn(`Extension node registration failed: ${err}`);
    scheduleRegisterRetry();
  }
};
```

Change the start block:

```ts
if (opts.awaitRegistration === false) {
  void tryRegister();
} else {
  await register(); // unchanged default behavior
  connect();
}
```

Clear `registerTimer` in `stop()`.

**Tests: `drone-swarm-common/test/extension-server.test.ts`** — `awaitRegistration: false` returns before registration then registers in the background; a failed registration retries; `requestTimeoutMs` rejects a slow response with the clear message.

### Step 2 — Gateway: config schema

**File: `drone-gateway/src/types.ts`** — remove `coordinatorToken`. Add:

```ts
export interface SwarmExtensionConfig {
  id: string;
  name: string;
  dataDir: string;
  requestTimeoutMs: number;
}
```

Add `swarmExtension?: SwarmExtensionConfig;` to `GatewayConfig` (present only when `coordinatorUrl` is set).

**File: `drone-gateway/src/config/load.ts`** — (1) a `coordinatorToken` removed-key error with its own message; (2) resolve `swarmExtension` when `coordinatorUrl` is set, applying the D5 defaults, resolving `dataDir` against `configDir`, with `~` expansion.

**Tests: `drone-gateway/test/config-load.test.ts`** — `coordinatorToken` present is a hard error; defaults applied when `swarmExtension` is absent; `dataDir` resolves against the config directory; `swarmExtension` absent when `coordinatorUrl` is absent.

### Step 3 — Gateway: the extension node handle

**New file: `drone-gateway/src/extension-node.ts`** — class `ExtensionNodeHandle`:

```ts
export class ExtensionNodeHandle {
  private node: ExtensionNode | null = null;
  private stopped = false;
  constructor(
    private readonly coordinatorUrl: string,
    private readonly config: SwarmExtensionConfig
  ) {}
  start(): void {
    void createExtensionNode({
      coordinatorUrl: this.coordinatorUrl,
      dataDir: this.config.dataDir,
      id: this.config.id,
      name: this.config.name,
      capabilities: [],
      awaitRegistration: false,
      requestTimeoutMs: this.config.requestTimeoutMs,
      handlers: {
        onSessionStarted: s =>
          logger.debug({ sessionId: s.sessionId }, 'session started'),
        onSessionEnded: s =>
          logger.debug({ sessionId: s.sessionId }, 'session ended'),
      },
    })
      .then(node => {
        if (this.stopped) {
          void node.stop();
          return;
        }
        this.node = node;
      })
      .catch(err => logger.warn(`Extension node failed: ${err}`));
  }
  isReady(): boolean {
    return this.node !== null;
  }
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.node)
      throw new Error(
        'coordinator unavailable: gateway extension node not connected'
      );
    return this.node.getFetch()(url, init);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const node = this.node;
    this.node = null;
    if (node) await node.stop();
  }
}
```

**New file: `drone-gateway/test/extension-node.test.ts`** — not ready before the node; `fetch` throws the clear error; `fetch` delegates when ready; `stop()` is idempotent.

### Step 4 — Gateway: the Coordinator Client transport swap

**File: `drone-gateway/src/coordinator-client.ts`** — constructor becomes `(fetchFn: CoordinatorFetch, baseUrl: string)`; `request()` calls `this.fetchFn`; remove the Bearer header and the `token` field. Also widen `spawnAgent`'s config type to `{ workingDir?: string; extensionHint?: string }`.

```ts
export type CoordinatorFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;
```

**Tests: `drone-gateway/test/coordinator-client.test.ts`** — pass a fake fetch in the constructor; remove the global `fetch` stub.

### Step 5 — Gateway: spawn hint plumbing

- `drone-gateway/src/spawn-backend.ts` — add `extensionHint?: string` to `SpawnSessionOptions`.
- `drone-gateway/src/surfaces/types.ts` — add `extensionHintPrefix?: string` to `SurfaceContext`.
- `drone-gateway/src/surfaces/lifecycle.ts` — compose the hint in `ensureSession`: `${prefix}:${conversationId}` where `prefix = ctx.extensionHintPrefix ?? DEFAULT_GATEWAY_EXTENSION_ID`.
- `drone-gateway/src/engine.ts` — set `extensionHintPrefix` in `surfaceContext()` from `this.config.swarmExtension?.id ?? DEFAULT_GATEWAY_EXTENSION_ID`.
- `drone-gateway/src/coordinator-spawn-backend.ts` — forward `opts.extensionHint` into the spawn `config` bag.
- `drone-gateway/src/local-spawn-backend.ts` — append `['--extension-hint', opts.extensionHint]`.

**Tests** — update `lifecycle`, `coordinator-spawn-backend`, and `local-spawn-backend` tests to assert the hint.

### Step 6 — Gateway: `main()` wiring

```ts
const nodeHandle = config.swarmExtension
  ? new ExtensionNodeHandle(config.coordinatorUrl, config.swarmExtension)
  : undefined;
const coordinatorClient = nodeHandle
  ? new CoordinatorClient(
      nodeHandle.fetch.bind(nodeHandle),
      config.coordinatorUrl
    )
  : undefined;
const backends = createSpawnBackends(config, coordinatorClient);
const engine = new GatewayEngine(config, backends, coordinatorClient);

const shutdown = async () => {
  await controlApi?.stop();
  await engine.stop(); // agents terminate over the LIVE node
  await nodeHandle?.stop(); // node stops LAST
  process.exit(0);
};

await engine.start();
nodeHandle?.start(); // NOT awaited
```

**Tests: `drone-gateway/test/index.test.ts`** — mock `./extension-node.js`; assert the shutdown order (engine before node).

### Step 7 — Gateway package dependency

`drone-gateway/package.json` — add `"drone-swarm-common": "workspace:*"`. Run `pnpm install` and `pnpm -r run build`.

### Step 8 — Documentation

1. New `docs/adr/256-gateway-swarm-extension.md` (D1–D17, protocol role, trust note, timeout, deferred items).
2. `drone-gateway/CONTEXT.md` — rewrite the **Coordinator Client** term (mTLS node fetch, no web port / Bearer); add a **Swarm Extension** term; update the Config Layout block (remove `coordinatorToken`, add `swarmExtension`).
3. `docs/agents/swarm-extensions.md` — add "Gateway as an extension"; remove the "gateway replatform deferred" sentence.
4. Swarm wiki — one migration page.

### Step 9 — Check the work against the validation criteria

Walk every item in Validation Criteria. Run each command. Correct until all pass. Do not mark the plan complete until LSP, lint, build, and the fast test suite are green.

## File split (reference)

| File                                                          | Change                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `drone-swarm-common/src/coordinator-fetch.ts`                 | add `timeoutMs`                                             |
| `drone-swarm-common/src/extension-server.ts`                  | `awaitRegistration`, `requestTimeoutMs`, registration retry |
| `drone-swarm-common/test/extension-server.test.ts`            | new tests                                                   |
| `drone-gateway/src/types.ts`                                  | remove `coordinatorToken`; add `SwarmExtensionConfig`       |
| `drone-gateway/src/config/load.ts`                            | removed key; resolve `swarmExtension`                       |
| `drone-gateway/src/extension-node.ts`                         | NEW                                                         |
| `drone-gateway/src/coordinator-client.ts`                     | transport swap                                              |
| `drone-gateway/src/spawn-backend.ts`                          | `SpawnSessionOptions.extensionHint`                         |
| `drone-gateway/src/surfaces/types.ts`                         | `SurfaceContext.extensionHintPrefix`                        |
| `drone-gateway/src/surfaces/lifecycle.ts`                     | compose the hint                                            |
| `drone-gateway/src/engine.ts`                                 | set the prefix                                              |
| `drone-gateway/src/coordinator-spawn-backend.ts`              | forward the hint                                            |
| `drone-gateway/src/local-spawn-backend.ts`                    | append the flag                                             |
| `drone-gateway/src/index.ts`                                  | handle, wiring, shutdown order                              |
| `drone-gateway/package.json`                                  | add `drone-swarm-common`                                    |
| `docs/adr/256-gateway-swarm-extension.md`                     | NEW                                                         |
| `drone-gateway/CONTEXT.md`, `docs/agents/swarm-extensions.md` | update                                                      |

## Validation Criteria

1. **Dependency build first.** `pnpm -r run build` passes with zero errors. Run after Step 1 and after every later step (dependent packages read the dependency's `dist/`).
2. **LSP.** `lsp__get_diagnostics` reports **zero** errors and **zero** warnings across the whole workspace, including tests. Run after every step.
3. **Typecheck.** `pnpm typecheck` passes (includes `tsc -p tsconfig.test.json`).
4. **Lint.** `pnpm run lint` passes with zero errors. **Read all files again after this command** (Prettier rewrites them).
5. **Fast tests.** `pnpm run test` passes (zero failures).
6. **New tests exist** for: SDK background registration and retry, SDK request timeout, config removed-key and defaults, the `ExtensionNodeHandle`, the Coordinator Client transport, the spawn hint on both backends, and the `main()` shutdown order.
7. **No dead code, no fluff comments, no duplicated logic.** Files stay under the size budget (split at 750 lines, must split at 1000).
8. **Behavioural acceptance (manual, with a local coordinator and a beacon):** the gateway starts without waiting; the node registers and `GET /api/extensions` lists `drone-gateway` with an empty capability list; a coordinator-mode chat spawns an agent whose snapshot shows `extensionHint = drone-gateway:<conversationId>`; a debug line shows `sessionStarted`; gateway stop terminates the agent (no leak); with the coordinator stopped the gateway still serves local conversations and registers when the coordinator returns.
9. **ADR 256 written; `CONTEXT.md` and `docs/agents/swarm-extensions.md` updated; wiki page exists; project memory updated with the result.**

## Deferred (not in this plan)

- The callee direction: the gateway exposes capabilities that other swarm members invoke.
- Tool injection and prompt fragments for gateway-spawned agents.
- The gateway config UI.
- Remote extensions and the pre-approval-token flow.
- A project-wide shutdown hardening: wait for terminate confirmation instead of best-effort.
- A front-end bundle for the gateway.
