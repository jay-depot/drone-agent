---
key: plan-gateway-external-process-injection
tags:
  - plan
  - drone-gateway
  - injection
  - cron
  - external-process
  - control-api
  - helper-cli
  - one-shot-agent
created: 2026-10-07T00:57:40.780Z
updated: 2026-10-07T00:57:40.780Z
---

# Plan: Gateway external-process injection + one-shot agent helper

**Status:** READY FOR EXECUTION
**Created:** 2026-10-06 (plan session)
**Target package:** `drone-gateway` (with a `drone-core` reuse point)

---

## 1. Summary — what and why

The gateway today bridges chat platforms to agents in one direction only: **inbound** (chat message → engine → control surface → `SpawnBackend.sendMessage` → agent). There is no way for an *external* process (a cron job, a CI hook, any script) to get text **into** a chat conversation.

This feature adds the **outbound** direction. An external process can:

1. **`run-agent`** — launch a one-shot agent that carries out a task and reports its result into an existing gateway conversation (heartbeat/triage/report jobs), optionally staying silent via a `<<NO_RESPONSE>>` sentinel.
2. **`inject-message`** — inject a literal message into a conversation, with no LLM involved (deterministic processes can post output directly).

Both helpers live in one new binary, `drone-gateway-inject`, and share **one** injection API: a new loopback HTTP **control API** on the running gateway daemon. The daemon owns the platform connections (including E2EE keys, which never leave its process), so it — not the helper — performs the actual post.

### Architecture

```
cron / CI / script
  │
  ├─ drone-gateway-inject run-agent   ── spawns local child ─▶ drone-agent --once --output-json
  │        (one-shot: {type:'kickoff',task} in, final chat message out)
  │
  └─ drone-gateway-inject inject-message
  │
  ▼  HTTP POST /inject (loopback)          ┌─────────────────────────────┐
  ────────────────────────────────────────▶│  drone-gateway daemon       │
                                            │   ControlApiServer (new)    │
                                            │        │                    │
                                            │        ▼                    │
                                            │  engine.injectMessage()     │
                                            │        │                    │
                                            │        ▼                    │
                                            │  adapter.sendMessage() ────▶ chat room/DM
                                            └─────────────────────────────┘
```

### Locked decisions (from the planning grilling — do not re-litigate)

| # | Decision |
|---|---|
| Q1/Q2 | Two helpers, one shared injection API. Loopback HTTP control API on the gateway daemon (new `controlApi` config). |
| Q3 | **Outbound only.** Inject = `adapter.sendMessage()`. No engine/surface dispatch. Inbound delivery + conversation continuity **deferred**. |
| Q4 | Opt-in = per-conversation `injection: { enabled: boolean }` in the conversation file. Loader keeps a conversation that has a non-empty `controlSurfaces` **or** `injection.enabled`. |
| Q5 | Agent helper spawns a **local** child only. Coordinator-routed spawn **deferred (v2)**. |
| Q6 | New dedicated `src/inject/spawn-once.ts`; **not** `LocalSpawnBackend`. Reuse `resolveDroneExecutable` + NDJSON event types only. |
| Q7 | **Second bin** in the same package: `drone-gateway-inject`. Subcommands `inject-message`, `run-agent`. |
| Q8 | API: `POST /inject`, `GET /status`, `GET /conversations`. 404 unknown adapter/conversation; 403 not opted in. |
| Q9 | Framing verbatim + optional caller `--prefix`. |
| Q10 | `controlApi: { enabled: false, host: "127.0.0.1", port: 8090 }` (+ optional `token`). |
| Q11 | Task input = positional **or** `--task-file <path|->` (stdin); exactly one. |
| Q12 | `run-agent` flags: `--persona --working-dir --model --agent-path --timeout(600s) --json`. |
| Q13 | Return value = **the final chat message only** (last `assistantMessage`). No subagent mimicry. Inject on success only. |
| Q14 | Final-only. Streaming narration **deferred** (default-off `--narration`). |
| Q15 | Task-only input; no ambient conversation context. |
| Q16 | Optional `controlApi.token` (Bearer); loopback trust when unset; loader warns on non-loopback host. |
| Q17 | Helper discovers daemon via `--config` → `controlApi.{host,port,token}`, with `--host/--port/--token` + `DRONE_GATEWAY_TOKEN` overrides. |
| Q18 | Bridge = public `GatewayEngine.injectMessage(adapterId, conversationId, text)` + `listAdapterIds()` + `listInjectableConversations()`, with typed errors. |
| Q19 | Failure matrix: unreachable/404/403 → stderr + exit 1; child error/timeout → no inject + exit 1; success → inject + exit 0. Plain SIGTERM→SIGKILL (no process group). |
| Q20 | No serialization — injection bypasses `runOnTail`; may interleave with a live turn (documented). |
| Q21 | `inject-message` input = positional **or** `--file <path|->`; exactly one. |
| Q22 | `--prefix` on both subcommands; helper-side; prepends to the first line (literal prepend); interprets `\n` `\t` `\\`. |
| Q23 | `ControlApiServer` built in `main()`, started after `engine.start()`, stopped before `engine.stop()`; `EADDRINUSE` → exit 1; no hot-reload. |
| Q24 | Fixed 30s helper HTTP timeout. `--timeout` is the agent budget only. |
| Q25 | Docs: this plan → project memory (user macro pulls to wiki). No `docs/` how-to, no local ADR. |
| Q25b | Update `drone-gateway/CONTEXT.md`. |
| Q26 | Hand-rolled arg parser (may unify into `drone-core` later). |
| Q27 | `run-agent --no-response-sentinel`: on `isNoResponse(rawFinalMessage)` → inject nothing, stderr notice, **exit 0**, `--json` reports `{ ok:true, injected:false, suppressed:true }`. |

### Incidental rules baked in

- The **wildcard `*` is never injectable**; an `injection` block on `_default_.json` is ignored with a warning.
- `GET /status` → `{ ok:true, version, adapters:[ids] }`; `GET /conversations` → `{ ok:true, conversations:[{adapterId,conversationId}] }`.
- The child's **stdin is closed** after the kickoff line (`runJsonMode` reads stdin until EOF). `--working-dir` is passed both as `--working-dir <dir>` **and** as the child `cwd`.
- An **empty/whitespace final message** → no inject, stderr warning, exit 0 ("nothing to report").
- A conversation loaded for injection only (zero surfaces) **drops inbound chat** (logged, unchanged behavior for surfaces).

---

## 2. Files

### New
| File | Purpose |
|---|---|
| `drone-gateway/src/errors.ts` | `UnknownAdapterError`, `UnknownConversationError`, `InjectionNotEnabledError`. |
| `drone-gateway/src/control-api/server.ts` | `ControlApiServer` (Fastify). |
| `drone-gateway/src/inject/args.ts` | Hand-rolled argv parser → `InjectInvocation`. |
| `drone-gateway/src/inject/prefix.ts` | `unescapePrefix`, `applyPrefix`. |
| `drone-gateway/src/inject/client.ts` | `ControlApiClient` (status/list/inject, 30s timeout). |
| `drone-gateway/src/inject/spawn-once.ts` | `spawnOnce()` one-shot child runner. |
| `drone-gateway/src/inject/commands.ts` | `runInjectCli` + the two subcommands. |
| `drone-gateway/src/inject/cli.ts` | Bin entry (`main`). |
| `drone-gateway/bin/drone-gateway-inject` | ESM shim → `dist/inject/cli.js`. |
| `drone-gateway/test/control-api-server.test.ts` | Server tests. |
| `drone-gateway/test/inject-args.test.ts` | Parser tests. |
| `drone-gateway/test/inject-prefix.test.ts` | Prefix tests. |
| `drone-gateway/test/inject-client.test.ts` | Client tests. |
| `drone-gateway/test/inject-spawn-once.test.ts` | Spawn-once tests. |
| `drone-gateway/test/inject-commands.test.ts` | End-to-end helper tests (mocked client + spawn). |

### Modified
| File | Change |
|---|---|
| `drone-gateway/src/types.ts` | `ControlApiConfig`; `GatewayConfig.controlApi?`; `ResolvedConversation.injectionEnabled?`. |
| `drone-gateway/src/config/load.ts` | Parse `controlApi`; parse per-conversation `injection`; relax the "non-empty surfaces" requirement; add `parseInjection`. |
| `drone-gateway/src/engine.ts` | `injectionEnabled` on the conversation record; keep zero-surface conversations; public `injectMessage`/`listAdapterIds`/`listInjectableConversations`. |
| `drone-gateway/src/index.ts` | Build/start/stop `ControlApiServer`. |
| `drone-gateway/package.json` | Add `fastify@^5.12.5` dep + `drone-gateway-inject` bin. |
| `drone-gateway/CONTEXT.md` | New glossary terms + config layout. |

---

## 3. Step-by-step plan

Steps are grouped by dependency layer. `agent` = the persona best suited to run it.

### Step 0 — Prep
- **agent:** coordinator
- `pnpm install` (baseline), confirm a clean tree, confirm the current branch is not `main` (memories/skills are committed intentionally; do not commit plan artifacts to `main`).
- Run `pnpm -r run build` once so dependents resolve fresh `dist/` (see project principle).

---

### Step 1 — Types and error classes
- **agent:** coder
- **depends on:** none
- **Files:** `drone-gateway/src/types.ts`, `drone-gateway/src/errors.ts`

1. In `src/types.ts`, add:

```ts
export interface ControlApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  token?: string;
}

export interface GatewayConfig {
  // ...existing fields...
  controlApi?: ControlApiConfig;
}

export interface ResolvedConversation {
  allowedSenders?: string[];
  surfaces: ControlSurfaceSpec[];
  /** Opt-in for outbound message injection from external processes. */
  injectionEnabled?: boolean;
}
```

2. Create `src/errors.ts`:

```ts
export class UnknownAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Unknown adapter: ${adapterId}`);
    this.name = 'UnknownAdapterError';
  }
}

export class UnknownConversationError extends Error {
  constructor(
    readonly adapterId: string,
    readonly conversationId: string
  ) {
    super(`Unknown conversation: ${adapterId}/${conversationId}`);
    this.name = 'UnknownConversationError';
  }
}

export class InjectionNotEnabledError extends Error {
  constructor(
    readonly adapterId: string,
    readonly conversationId: string
  ) {
    super(
      `Conversation ${adapterId}/${conversationId} is not an injection target ` +
        `(set "injection": { "enabled": true } in its conversation file)`
    );
    this.name = 'InjectionNotEnabledError';
  }
}
```

- **Test:** none required for pure types/errors (covered by later steps).

---

### Step 2 — Loader: `controlApi` + `injection` + relaxation
- **agent:** coder
- **depends on:** Step 1
- **File:** `drone-gateway/src/config/load.ts`

1. Add a `parseControlApi(gatewayConfig)` helper (called from `loadGatewayConfig`, result stored on `config.controlApi`):

```ts
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseControlApi(
  raw: unknown,
  warn: (msg: string) => void
): ControlApiConfig {
  const defaults: ControlApiConfig = { enabled: false, host: '127.0.0.1', port: 8090 };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('controlApi is not an object; ignoring');
    return defaults;
  }
  const bag = raw as Record<string, unknown>;

  let enabled = defaults.enabled;
  if (bag.enabled !== undefined) {
    if (typeof bag.enabled !== 'boolean') warn('controlApi.enabled must be a boolean; ignoring');
    else enabled = bag.enabled;
  }

  let host = defaults.host;
  if (bag.host !== undefined) {
    if (typeof bag.host !== 'string' || bag.host.trim() === '') warn('controlApi.host must be a non-empty string; using default');
    else host = bag.host;
  }
  if (enabled && !LOOPBACK_HOSTS.has(host)) {
    warn(`controlApi.host "${host}" is not loopback; configure controlApi.token — the API is otherwise unauthenticated`);
  }

  let port = defaults.port;
  if (bag.port !== undefined) {
    if (typeof bag.port !== 'number' || !Number.isInteger(bag.port) || bag.port < 1 || bag.port > 65535) {
      warn('controlApi.port must be an integer in 1–65535; using default');
    } else port = bag.port;
  }

  let token: string | undefined;
  if (bag.token !== undefined) {
    if (typeof bag.token !== 'string' || bag.token.trim() === '') warn('controlApi.token must be a non-empty string; ignoring');
    else token = bag.token;
  }

  return { enabled, host, port, token };
}
```

Set `controlApi: parseControlApi(gatewayConfig.controlApi, msg => logger.warn(`Config field ${msg}.`))` in the built `config` object (always present).

2. Add `parseInjection(...)` and call it in `loadAdapter`; relax the surfaces requirement. Replace the current block:

```ts
    // Read control surfaces
    const rawSurfaces = convData.controlSurfaces as unknown[];
    if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
      logger.warn({ adapterId, file, convId }, `Conversation "${convId}" has no controlSurfaces array`);
      continue;
    }

    const specs: ControlSurfaceSpec[] = [];
    for (const raw of rawSurfaces) { /* ...unchanged... */ }

    if (specs.length > 0) {
      conversations.set(convId, {
        allowedSenders: parseAllowedSenders(convData, adapterId, file),
        surfaces: specs,
      });
    }
```

with:

```ts
    const rawSurfaces = convData.controlSurfaces;
    if (rawSurfaces !== undefined && !Array.isArray(rawSurfaces)) {
      logger.warn({ adapterId, file, convId }, `Conversation "${convId}" controlSurfaces is not an array; ignoring it`);
    }
    const surfaceEntries = Array.isArray(rawSurfaces) ? rawSurfaces : [];

    const specs: ControlSurfaceSpec[] = [];
    for (const raw of surfaceEntries) { /* ...unchanged spec loop... */ }

    const injectionEnabled = parseInjection(convData, adapterId, file, convId);

    if (specs.length === 0 && !injectionEnabled) {
      logger.warn(
        { adapterId, file, convId },
        `Conversation "${convId}" has no controlSurfaces and no injection opt-in; skipping`
      );
      continue;
    }

    conversations.set(convId, {
      allowedSenders: parseAllowedSenders(convData, adapterId, file),
      surfaces: specs,
      injectionEnabled,
    });
```

and add:

```ts
function parseInjection(
  convData: Record<string, unknown>,
  adapterId: string,
  file: string,
  convId: string
): boolean {
  const raw = convData.injection;
  if (raw === undefined) return false;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn({ adapterId, file, convId }, 'injection is not an object; ignoring');
    return false;
  }
  const enabled = (raw as Record<string, unknown>).enabled;
  if (enabled === undefined) return false;
  if (typeof enabled !== 'boolean') {
    logger.warn({ adapterId, file, convId }, 'injection.enabled must be a boolean; ignoring');
    return false;
  }
  if (!enabled) return false;
  if (convId === '*') {
    logger.warn({ adapterId, file, convId }, 'injection.enabled is not allowed on the wildcard conversation; ignoring');
    return false;
  }
  return true;
}
```

3. Import `ControlApiConfig` from `../types.js`.

- **Test:** extend `test/config-load.test.ts` (see Step 11).

---

### Step 3 — Engine: injection bridge
- **agent:** coder
- **depends on:** Step 1
- **File:** `drone-gateway/src/engine.ts`

1. Extend the record type:

```ts
type InstantiatedConversation = {
  allowedSenders?: string[];
  surfaces: DroneControlSurface[];
  tail: Promise<unknown>;
  batcher?: MessageBatcher;
  /** True when this conversation opted into external-process injection. */
  injectionEnabled: boolean;
};
```

2. In `start()`, populate `injectionEnabled` (already zero-surface-safe because `surfaces` may be empty):

```ts
        const record: InstantiatedConversation = {
          allowedSenders: conv.allowedSenders,
          surfaces,
          tail: Promise.resolve(),
          injectionEnabled: conv.injectionEnabled === true,
        };
```

3. Add public methods (place near `stop()`):

```ts
  /** Adapter ids currently started. Backs GET /status. */
  listAdapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Conversations that opted into injection. Backs GET /conversations. */
  listInjectableConversations(): Array<{
    adapterId: string;
    conversationId: string;
  }> {
    const out: Array<{ adapterId: string; conversationId: string }> = [];
    for (const [adapterId, byConv] of this.controlSurfaces) {
      for (const [conversationId, conv] of byConv) {
        if (conv.injectionEnabled) out.push({ adapterId, conversationId });
      }
    }
    return out;
  }

  /**
   * Post text into a conversation from an external process. Outbound only:
   * the message is handed straight to the adapter and does NOT go through any
   * control surface or the per-conversation dispatch tail (it may interleave
   * with a live agent turn).
   */
  async injectMessage(
    adapterId: string,
    conversationId: string,
    text: string
  ): Promise<void> {
    const byConv = this.controlSurfaces.get(adapterId);
    if (!byConv) throw new UnknownAdapterError(adapterId);
    const conv = byConv.get(conversationId);
    if (!conv) throw new UnknownConversationError(adapterId, conversationId);
    if (!conv.injectionEnabled) {
      throw new InjectionNotEnabledError(adapterId, conversationId);
    }
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new UnknownAdapterError(adapterId);
    await adapter.sendMessage(conversationId, text);
  }
```

4. Import the three error classes from `./errors.js`.

- **Test:** extend `test/engine.test.ts` (Step 11).

---

### Step 4 — Control API server
- **agent:** coder
- **depends on:** Steps 1, 3
- **File:** `drone-gateway/src/control-api/server.ts`

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from '../logger.js';
import {
  UnknownAdapterError,
  UnknownConversationError,
  InjectionNotEnabledError,
} from '../errors.js';
import type { GatewayEngine } from '../engine.js';
import type { ControlApiConfig } from '../types.js';

export interface ControlApiServerOptions {
  engine: GatewayEngine;
  config: ControlApiConfig;
  version: string;
}

export class ControlApiServer {
  private app: FastifyInstance | null = null;
  private readonly opts: ControlApiServerOptions;

  constructor(opts: ControlApiServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const app = Fastify({ logger: false });
    this.app = app;
    const { token } = this.opts.config;

    if (token) {
      app.addHook('onRequest', async (req, reply) => {
        if (req.headers['authorization'] !== `Bearer ${token}`) {
          await reply.code(401).send({ ok: false, error: 'unauthorized' });
        }
      });
    }

    app.get('/status', async () => ({
      ok: true,
      version: this.opts.version,
      adapters: this.opts.engine.listAdapterIds(),
    }));

    app.get('/conversations', async () => ({
      ok: true,
      conversations: this.opts.engine.listInjectableConversations(),
    }));

    app.post('/inject', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { adapterId, conversationId, text } = body;
      if (
        typeof adapterId !== 'string' || adapterId.trim() === '' ||
        typeof conversationId !== 'string' || conversationId.trim() === '' ||
        typeof text !== 'string'
      ) {
        return reply.code(400).send({ ok: false, error: 'adapterId, conversationId and text are required' });
      }
      try {
        await this.opts.engine.injectMessage(adapterId, conversationId, text);
        return { ok: true, posted: true };
      } catch (err) {
        if (err instanceof UnknownAdapterError || err instanceof UnknownConversationError) {
          return reply.code(404).send({ ok: false, error: err.message });
        }
        if (err instanceof InjectionNotEnabledError) {
          return reply.code(403).send({ ok: false, error: err.message });
        }
        logger.error({ err }, 'Injection failed');
        return reply.code(500).send({ ok: false, error: 'injection failed' });
      }
    });

    await app.listen({ host: this.opts.config.host, port: this.opts.config.port });
    logger.info(
      `Control API listening on ${this.opts.config.host}:${this.opts.config.port}` +
        (token ? ' (Bearer token required)' : ' (loopback trust, no token)')
    );
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) await app.close();
  }
}
```

- **Note:** `app.listen` throws on `EADDRINUSE`; the caller (Step 5) turns that into exit 1.
- **Test:** Step 11.

---

### Step 5 — Daemon wiring + package manifest
- **agent:** coder
- **depends on:** Step 4
- **Files:** `drone-gateway/src/index.ts`, `drone-gateway/package.json`

1. `package.json`: add dependency `"fastify": "^5.12.5"` and the second bin:

```json
  "bin": {
    "drone-gateway": "./bin/drone-gateway",
    "drone-gateway-inject": "./bin/drone-gateway-inject"
  },
```

Then `pnpm install`.

2. `src/index.ts`: read a version, build/start the server after `engine.start()`, stop it before `engine.stop()`:

```ts
import { readFile } from 'node:fs/promises';
import { ControlApiServer } from './control-api/server.js';

async function readGatewayVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

  // ...inside main(), after engine is constructed...
  let controlApi: ControlApiServer | undefined;

  const shutdown = async () => {
    logger.info('Shutting down...');
    await controlApi?.stop();
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await engine.start();

    if (config.controlApi?.enabled) {
      controlApi = new ControlApiServer({
        engine,
        config: config.controlApi,
        version: await readGatewayVersion(),
      });
      await controlApi.start();
    }

    logger.info('Gateway started successfully');
    await new Promise(() => {});
  } catch (err) {
    logger.error(err, 'Failed to start gateway');
    await controlApi?.stop();
    await engine.stop();
    process.exit(1);
  }
```

- **Test:** `test/index.test.ts` mock may need `./control-api/server.js` added; Step 11.

---

### Step 6 — Helper parser + prefix
- **agent:** coder
- **depends on:** Step 1
- **Files:** `drone-gateway/src/inject/args.ts`, `drone-gateway/src/inject/prefix.ts`

`src/inject/prefix.ts`:

```ts
/** Interpret \\n, \\t, \\\\ in a caller-supplied --prefix. Other escapes are literal. */
export function unescapePrefix(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : `\\${c}`
  );
}

/** Prepend the prefix to the text (i.e. to its first line, with no separator). */
export function applyPrefix(prefix: string | undefined, text: string): string {
  if (!prefix) return text;
  return prefix + text;
}
```

`src/inject/args.ts` — mirror the existing hand-rolled style. Types + parser:

```ts
export interface InjectCommonOptions {
  configPath?: string;
  host?: string;
  port?: number;
  token?: string;
  adapterId: string;
  conversationId: string;
  prefix?: string;
  json: boolean;
}

export type InjectInvocation =
  | { kind: 'help' }
  | { kind: 'inject-message'; options: InjectCommonOptions; text?: string; file?: string }
  | {
      kind: 'run-agent';
      options: InjectCommonOptions;
      task?: string;
      taskFile?: string;
      persona?: string;
      workingDir?: string;
      model?: string;
      agentPath?: string;
      timeoutSeconds: number;
      noResponseSentinel: boolean;
    };

export const DEFAULT_TIMEOUT_SECONDS = 600;

export function parseInjectArgs(argv: string[]): InjectInvocation { /* ... */ }
export function usageText(): string { /* ... */ }
```

Parser rules:
- First non-flag token is the subcommand (`inject-message` | `run-agent`); `--help`/`-h` at top level (or subcommand) → `{ kind: 'help' }`; unknown subcommand → throw.
- Common flags for both: `--config <path>`, `--host <h>`, `--port <n>` (integer 1–65535 else throw), `--token <t>`, `--adapter <id>`, `--conversation <id>`, `--prefix <s>`, `--json`.
- `inject-message`: positional text **or** `--file <path|->`; exactly one (throw if neither/both).
- `run-agent`: positional task **or** `--task-file <path|->`; exactly one. Plus `--persona <id>`, `--working-dir <path>`, `--model <m>`, `--agent-path <p>`, `--timeout <seconds>` (finite ≥ 0 else throw; default 600), `--no-response-sentinel`.
- `--adapter` and `--conversation` are required for both subcommands (throw if missing).
- Unknown `--foo` → throw (same as `drone-agent`).
- Do **not** interpret `--prefix` escapes here; do it in `commands.ts`.

- **Test:** `test/inject-args.test.ts`, `test/inject-prefix.test.ts` (Step 11).

---

### Step 7 — Control API client
- **agent:** coder
- **depends on:** Step 6
- **File:** `drone-gateway/src/inject/client.ts`

```ts
export const HTTP_TIMEOUT_MS = 30_000;

export interface ControlApiClientOptions {
  host: string;
  port: number;
  token?: string;
}

export class GatewayUnreachableError extends Error { /* ...message names host:port... */ }
export class GatewayHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class ControlApiClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: ControlApiClientOptions) {
    this.baseUrl = `http://${opts.host}:${opts.port}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`;
    return h;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayUnreachableError(
        `Gateway not reachable at ${this.opts.host}:${this.opts.port} (is it running? is controlApi.enabled true?)`,
        { cause: err }
      );
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch { /* keep status */ }
      throw new GatewayHttpError(res.status, detail);
    }
    return res.json();
  }

  async status(): Promise<{ ok: boolean; version: string; adapters: string[] }> {
    return (await this.request('GET', '/status')) as { ok: boolean; version: string; adapters: string[] };
  }

  async listConversations(): Promise<Array<{ adapterId: string; conversationId: string }>> {
    const data = (await this.request('GET', '/conversations')) as {
      conversations: Array<{ adapterId: string; conversationId: string }>;
    };
    return data.conversations;
  }

  async inject(adapterId: string, conversationId: string, text: string): Promise<void> {
    await this.request('POST', '/inject', { adapterId, conversationId, text });
  }
}
```

- **Test:** `test/inject-client.test.ts` (Step 11).

---

### Step 8 — One-shot spawn
- **agent:** coder
- **depends on:** Step 6
- **File:** `drone-gateway/src/inject/spawn-once.ts`

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveDroneExecutable } from 'drone-core';

const KILL_GRACE_MS = 5_000;

export interface SpawnOnceOptions {
  task: string;
  personaId?: string;
  workingDir?: string;
  model?: string;
  agentPath?: string;
  timeoutMs: number;
}

export class SpawnOnceTimeoutError extends Error {}
export class SpawnOnceFailureError extends Error {}

/**
 * Run a single one-shot agent turn and return the final chat message.
 *
 * Uses `drone-agent --once --output-json` (runJsonMode): the kickoff event is
 * written to the child's stdin, which is then closed (runJsonMode reads stdin
 * until EOF); NDJSON events stream to stdout. The final chat message is the
 * LAST `assistantMessage` emitted. Agent logs go to stderr and are ignored.
 */
export async function spawnOnce(opts: SpawnOnceOptions): Promise<string> {
  const executable = await resolveDroneExecutable({
    commandName: opts.agentPath ?? 'drone-agent',
  });

  const args = ['--once', '--output-json'];
  if (opts.personaId) args.push('--persona', opts.personaId);
  if (opts.workingDir) args.push('--working-dir', opts.workingDir);
  if (opts.model) args.push('--model', opts.model);

  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    ...(opts.workingDir ? { cwd: opts.workingDir } : {}),
  });

  child.stdin.write(JSON.stringify({ type: 'kickoff', task: opts.task }) + '\n');
  child.stdin.end();

  let finalMessage = '';
  let lastError: string | undefined;

  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as { kind?: string; content?: string; message?: string };
      if (event.kind === 'assistantMessage' && typeof event.content === 'string') {
        finalMessage = event.content;
      } else if (event.kind === 'error' && typeof event.message === 'string') {
        lastError = event.message;
      }
    } catch { /* ignore non-JSON */ }
  });
  child.stderr.resume(); // drain

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }, opts.timeoutMs);

  const exitCode = await new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  clearTimeout(timer);
  rl.close();

  if (timedOut) {
    throw new SpawnOnceTimeoutError(`Agent exceeded --timeout (${opts.timeoutMs} ms)`);
  }
  if (exitCode !== 0) {
    throw new SpawnOnceFailureError(lastError ?? `Agent exited with code ${exitCode}`);
  }
  return finalMessage;
}
```

- **Test:** `test/inject-spawn-once.test.ts` (Step 11).

---

### Step 9 — Helper commands + CLI + bin
- **agent:** coder
- **depends on:** Steps 6, 7, 8
- **Files:** `drone-gateway/src/inject/commands.ts`, `src/inject/cli.ts`, `bin/drone-gateway-inject`

`commands.ts` (essentials):

```ts
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isNoResponse } from '../chat-format.js';
import { unescapePrefix, applyPrefix } from './prefix.js';
import { ControlApiClient, GatewayHttpError, GatewayUnreachableError } from './client.js';
import { spawnOnce, SpawnOnceFailureError, SpawnOnceTimeoutError } from './spawn-once.js';
import { parseInjectArgs, usageText, DEFAULT_TIMEOUT_SECONDS, type InjectInvocation, type InjectCommonOptions } from './args.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.drone-gateway', 'config.json');

interface ResolvedTarget { host: string; port: number; token?: string }

export async function resolveControlApi(opts: InjectCommonOptions): Promise<ResolvedTarget> {
  let fileCfg: Partial<ResolvedTarget> = {};
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as { controlApi?: Record<string, unknown> };
    const ca = raw.controlApi ?? {};
    if (typeof ca.host === 'string') fileCfg.host = ca.host;
    if (typeof ca.port === 'number') fileCfg.port = ca.port;
    if (typeof ca.token === 'string') fileCfg.token = ca.token;
  } catch { /* no config file → defaults + overrides */ }

  return {
    host: opts.host ?? fileCfg.host ?? '127.0.0.1',
    port: opts.port ?? fileCfg.port ?? 8090,
    token: opts.token ?? process.env.DRONE_GATEWAY_TOKEN ?? fileCfg.token,
  };
}

async function readText(source: { positional?: string; file?: string }): Promise<string> {
  if (source.positional !== undefined) return source.positional;
  if (source.file === '-') return readStdin();
  return readFile(source.file as string, 'utf-8');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export async function runInjectCli(argv: string[]): Promise<void> {
  let invocation: InjectInvocation;
  try {
    invocation = parseInjectArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (invocation.kind === 'help') {
    process.stdout.write(usageText() + '\n');
    return;
  }
  const target = await resolveControlApi(invocation.options);
  const client = new ControlApiClient(target);
  try {
    if (invocation.kind === 'inject-message') {
      await runInjectMessage(invocation, client);
    } else {
      await runRunAgent(invocation, client);
    }
  } catch (err) {
    if (err instanceof GatewayUnreachableError) {
      process.stderr.write(`${err.message}\n`);
    } else if (err instanceof GatewayHttpError) {
      process.stderr.write(`Gateway rejected the injection (${err.status}): ${err.message}\n`);
    } else if (err instanceof SpawnOnceTimeoutError || err instanceof SpawnOnceFailureError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

async function runInjectMessage(
  inv: Extract<InjectInvocation, { kind: 'inject-message' }>,
  client: ControlApiClient
): Promise<void> {
  const raw = await readText({ positional: inv.text, file: inv.file });
  const text = applyPrefix(unescapePrefix(inv.options.prefix ?? ''), raw);
  await client.inject(inv.options.adapterId, inv.options.conversationId, text);
  if (inv.options.json) {
    emitJson({ ok: true, injected: true, adapterId: inv.options.adapterId, conversationId: inv.options.conversationId, text });
  } else {
    process.stdout.write(`${text}\n`);
  }
}

async function runRunAgent(
  inv: Extract<InjectInvocation, { kind: 'run-agent' }>,
  client: ControlApiClient
): Promise<void> {
  const task = await readText({ positional: inv.task, file: inv.taskFile });
  const finalMessage = await spawnOnce({
    task,
    personaId: inv.persona,
    workingDir: inv.workingDir,
    model: inv.model,
    agentPath: inv.agentPath,
    timeoutMs: inv.timeoutSeconds * 1000,
  });

  if (inv.noResponseSentinel && isNoResponse(finalMessage)) {
    process.stderr.write('agent declined to respond (<<NO_RESPONSE>>); nothing injected\n');
    if (inv.options.json) emitJson({ ok: true, injected: false, suppressed: true });
    return;
  }

  if (finalMessage.trim() === '') {
    process.stderr.write('agent produced no final message; nothing injected\n');
    if (inv.options.json) emitJson({ ok: true, injected: false, suppressed: false });
    return;
  }

  const text = applyPrefix(unescapePrefix(inv.options.prefix ?? ''), finalMessage);
  await client.inject(inv.options.adapterId, inv.options.conversationId, text);
  if (inv.options.json) {
    emitJson({ ok: true, injected: true, adapterId: inv.options.adapterId, conversationId: inv.options.conversationId, result: text });
  } else {
    process.stdout.write(`${text}\n`);
  }
}
```

`src/inject/cli.ts`:

```ts
import { runInjectCli } from './commands.js';

export async function main(): Promise<void> {
  await runInjectCli(process.argv.slice(2));
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

`bin/drone-gateway-inject`:

```
#!/usr/bin/env node
import { main } from '../dist/inject/cli.js';
main();
```

Then `chmod +x bin/drone-gateway-inject`.

- **Test:** `test/inject-commands.test.ts` (Step 11).

---

### Step 10 — `CONTEXT.md`
- **agent:** coder
- **depends on:** Steps 2, 9 (final vocabulary)
- **File:** `drone-gateway/CONTEXT.md`

1. Add glossary entries (alphabetical placement as appropriate):
   - **Injection** — outbound posting of text into a conversation by an external process, bypassing control surfaces. May interleave with a live agent turn.
   - **Injection API** — the daemon's loopback HTTP control API (`POST /inject`, `GET /status`, `GET /conversations`). Disabled by default (`controlApi.enabled`).
   - **Injection Target** — a conversation whose file sets `injection: { enabled: true }`; the only conversations the API will post to. The wildcard is never a target.
   - **Agent Helper** — `drone-gateway-inject run-agent`: spawns a local one-shot `drone-agent --once --output-json`, then injects its final chat message (unless `--no-response-sentinel` matches).
   - **Message Helper** — `drone-gateway-inject inject-message`: injects a literal string; no LLM.
2. In `## Config Layout`, add under the top-level `config.json` block:

```
    controlApi?: {                    # Opt-in inbound control API for external-process
      enabled: boolean               #   injection. Disabled by default.
      host: string                   # Default 127.0.0.1 (loopback only).
      port: number                   # Default 8090.
      token?: string                 # Optional Bearer token; unset = trust loopback.
    }
```

and under a conversation file:

```
          injection?: { enabled: boolean }  # Opt this conversation into external-process
                                             # injection. Not allowed on _default_.
```

---

### Step 11 — Tests
- **agent:** tester
- **depends on:** Steps 1–9

Extend / add (Vitest; follow the package's existing patterns — `vi.mock`, `vi.waitFor`, no fixed sleeps):

1. **`test/config-load.test.ts`** (extend):
   - `controlApi` defaults present (`enabled:false`, `127.0.0.1`, `8090`) when absent.
   - Invalid `controlApi.port`/`host`/`enabled` warn-and-default.
   - Non-loopback `host` with `enabled:true` warns.
   - Conversation with `injection:{enabled:true}` and **no** surfaces loads with `injectionEnabled:true`, `surfaces:[]`.
   - Conversation with neither → skipped.
   - `injection` on `_default_` (wildcard) → ignored with warning.
2. **`test/engine.test.ts`** (extend): `injectMessage` success calls `adapter.sendMessage`; unknown adapter → `UnknownAdapterError`; unknown conversation → `UnknownConversationError`; not opted in → `InjectionNotEnabledError`; `*` → not injectable; `listAdapterIds`/`listInjectableConversations` shapes.
3. **`test/control-api-server.test.ts`** (new): start on an ephemeral port (port 0 is not allowed by validation, so use a mock engine and `app.inject`-style or a real listen on a fixed high port and close); `GET /status`; `GET /conversations`; `POST /inject` 200; 404/403 mapping; 400 on bad body; 401 when a token is configured and absent/wrong.
4. **`test/inject-args.test.ts`**, **`test/inject-prefix.test.ts`** (new): subcommand selection; required flags; exactly-one input rules; `--timeout` validation; unknown flag throws; `--help`; escape + first-line prefix semantics.
5. **`test/inject-client.test.ts`** (new): mock `fetch`; Bearer header sent when token set; 404/403 → `GatewayHttpError`; network failure → `GatewayUnreachableError`; URL composition.
6. **`test/inject-spawn-once.test.ts`** (new): mock `node:child_process` + `drone-core`; assert args `['--once','--output-json', ...]`; kickoff line written then stdin ended; last `assistantMessage` returned; non-zero exit → `SpawnOnceFailureError`; timeout → SIGTERM then SIGKILL (`SpawnOnceTimeoutError`).
7. **`test/inject-commands.test.ts`** (new): mock `ControlApiClient` + `spawnOnce`; `inject-message` injects prefixed text; `run-agent` injects the final message; `--no-response-sentinel` suppresses on sentinel and returns 0 with `suppressed:true`; empty final message → no inject, exit 0; child failure → exit 1 without injecting.

---

### Step 12 — Review
- **agent:** reviewer
- **depends on:** Steps 1–11
- **Focus:** outbound-only invariant (no surface dispatch on the inject path); the wildcard is genuinely unreachable; typed-error → HTTP status mapping is exhaustive; no `runOnTail` on the inject path (Q20); stdin closed in `spawn-once`; no leaks (timers `unref`'d, readline closed, child killed); hand-rolled parser rejects unknown flags; `CONTEXT.md` matches the implementation.

---

### Step 13 — Final validation against the plan's criteria
- **agent:** tester
- **depends on:** Step 12
- Run every item in §4 below and record results.

---

### Step 14 — Persist artifacts
- **agent:** coordinator
- Save/refresh this plan in project memory (`.drone-agent/memory/plan-gateway-external-process-injection.md`). The user's macro pulls it into the project wiki. Log any insights (Step 15). Commit the checked-in `.drone-agent` artifacts alongside the code **only if not on `main`**.

---

## 4. Validation criteria

All of the following must pass before the feature is "done":

1. **LSP:** `lsp__get_diagnostics` (and the TypeScript LSP generally) reports **zero errors and zero warnings** across the workspace — including tests.
2. **Build:** `pnpm -r run build` succeeds with zero errors.
3. **Project linting:** `pnpm run lint` succeeds with zero errors (this runs ESLint, then Prettier — re-read edited files afterward, since Prettier may reformat).
4. **Fast tests:** `pnpm run test` passes.
5. **Functional acceptance (manual, documented in the plan's follow-up notes):**
   - With `controlApi.enabled:false`, the daemon opens no port and `GET /status` is refused.
   - With `controlApi.enabled:true` and a conversation with `injection:{enabled:true}`, `drone-gateway-inject inject-message --adapter <id> --conversation <conv> "hi"` posts `hi` to the chat.
   - Posting to a conversation without the opt-in returns 403; to an unknown id returns 404.
   - `drone-gateway-inject run-agent --task "say hi"` spawns the child, injects the final chat message, exits 0.
   - `run-agent --no-response-sentinel` against a task whose output is exactly `<<NO_RESPONSE>>` injects nothing and exits 0.
   - `--prefix '⏰\t'` prefixes the first line only.
   - `--task-file -` reads the task from stdin.
   - `--timeout 1` on a slow task kills the child and exits 1 with nothing injected.
6. **No dead code.** No unused exports/variables introduced. No "step" comments. Prettier-formatted.
7. **Docs:** `drone-gateway/CONTEXT.md` reflects the shipped vocabulary and config layout.

---

## 5. Deferred / follow-ups (explicitly out of scope for this plan)

1. **Remote (coordinator-routed) spawn** for `run-agent` (needs the deferred coordinator receive path).
2. **Streaming narration** (`--narration`, default off) — inject interim `assistantMessage`s; must dedup the child's final-message echo.
3. **Inbound delivery** (inject as a user turn to a resident surface) and **conversation continuity / session resume** — a later feature; it is expected to subsume parts of this one.
4. **Reconciling `drone-gateway/docs/adr/` with the project wiki's ADRs** — the two are redundant and out of sync.
5. **Unify the hand-rolled CLI parsers** into `drone-core` if the overlap with `drone-agent`/`drone-gateway` proves substantial.
6. A config-level per-conversation prefix (if repetition of `--prefix` becomes annoying).

---

## 6. Reference — existing facts the implementer needs

- Injection today is inbound-only: `chat → engine.handleMessage → surface → SpawnBackend.sendMessage`.
- The engine holds `Map<adapterId, Map<conversationId, InstantiatedConversation>>`; the daemon holds `Map<adapterId, DroneServiceAdapter>`.
- `LocalSpawnBackend.sendMessage` writes NDJSON `{type:'chat',message,systemReminder?}` to a persistent child's stdin and waits for `turnComplete` — do **not** reuse the persistent-child machinery.
- `drone-agent --once --output-json` = `runJsonMode` (`drone-agent/src/interactive.ts`): reads `{"type":"kickoff","task":"…"}` from stdin **until EOF**, emits NDJSON to stdout (`reasoning`, `toolCall`, `toolResult`, `assistantMessage`, `error`, terminal `return`), re-emits the final reply as an `assistantMessage`, writes logs to stderr (the agent sets `logToStderr` when `--output-json`).
- `chat-format.ts` exports `NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>'` and `isNoResponse(reply)` — reuse them; do not redefine.
- `resolveDroneExecutable({ commandName })` lives in `drone-core` (`src/utils.ts`).
- Fastify `^5.12.5` is already used by `drone-beacon` and `drone-coordinator`; `drone-gateway` does not yet depend on it.
- The gateway config loader has **no `${VAR}` interpolation** (render-from-env); a `controlApi.token` is a literal.
- E2EE keys (ADR 229) live only in the daemon process — this is why the daemon, not the helper, performs the post.
