---
key: plan-coordinator-server-refactor
tags:
  - plan
  - coordinator
  - beacon
  - refactor
  - config
  - wiki
  - roadmap-3.10-prereq
created: 2026-07-03T01:13:38.965Z
updated: 2026-07-03T01:13:38.965Z
---

# Plan A — Coordinator/Beacon Server Refactor + Config-Dir + Wiki-Root

## Summary

**What:** Refactor `drone-coordinator/src/index.ts` so the API server is assembled by an exported, side-effect-free `buildApp()` function (separated from UI-serving glue and from `main()`), change the default config directories for both the coordinator and beacon to per-service home-dir paths, and anchor each service's wiki ("knowledge-base") directory under its own config dir.

**Why:**

1. **Testability (primary driver):** `index.ts` currently runs `main()` at import time and keeps `setupServer` private, so route handlers cannot be exercised via `fastify.inject()`. Extracting `buildApp()` unblocks Plan B (coordinator route test coverage, roadmap item 3.10) and makes the assembled API app — including auth middleware — directly testable.
2. **Wiki collision fix:** A coordinator host must run a co-located beacon. Neither service currently calls `setKnowledgeBaseDir()`, so both default to `wiki-storage`'s hardcoded `./knowledge-base` (relative to cwd). Run from the same directory, they write their wikis over each other. Anchoring the wiki under each service's config dir — combined with distinct default config dirs — resolves this.
3. **Sensible defaults:** `./config` (cwd-relative) is a poor default for long-running services. `~/.drone-coordinator` and `~/.drone-beacon` mirror the `~/.drone-agent` convention.

**No backward-compatibility shim is required** (single-user project; the user already overrides these paths).

**This plan is a prerequisite for Plan B (`plan-coordinator-route-tests`).**

---

## Design Decisions (settled with user)

- **`buildApp(opts?)` scope:** assembles CORS + optional auth `onRequest` hook + `registerRoutes(app)` only. WebSocket (`/ws`), `@fastify/static`, the `/` index route, and the SPA `setNotFoundHandler` fallback remain **UI-serving glue** attached inside `main()` (optionally via a thin `attachUi(app, uiDistPath)` helper). Rationale: route tests then need no UI-dist scaffolding and no websocket client, while still exercising the real auth path.
- **Entry guard:** `index.ts` exports `main` (and `buildApp`) and does NOT self-invoke at import. **Critical detail:** `bin/drone-coordinator` currently does `import '../dist/index.js'` (not run-as-argv[1]), so a naive `import.meta.url === pathToFileURL(process.argv[1])` guard would never start the server. Therefore the bin wrapper must be changed to explicitly call `main()`.
- **Wiki dir name:** keep the generic name `knowledge-base` (the wiki is only a _suggested_ use — the end user supplies the ingestion prompt and may store whatever structure they like). Path: `<configDir>/knowledge-base`.
- **Config dirs:** coordinator `~/.drone-coordinator`, beacon `~/.drone-beacon`, via `os.homedir()`.

---

## Steps

### Step 1 — [coder] Coordinator: default config dir → `~/.drone-coordinator`

File: `drone-coordinator/src/index.ts`

- Add `import os from 'node:os';` (path already imported).
- Change `const DEFAULT_CONFIG_DIR = './config';` to `const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-coordinator');`
- Verify the `--help` text and `dbPath` derivation still read correctly (they interpolate `DEFAULT_CONFIG_DIR`, so they update automatically).
  Dependencies: none.

### Step 2 — [coder] Beacon: default config dir → `~/.drone-beacon`

File: `drone-beacon/src/index.ts`

- Add `import os from 'node:os';` (currently imports `path`, `fs`).
- Change `const DEFAULT_CONFIG_DIR = './config';` to `const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-beacon');`
- Verify `--help` text and `dbPath` derivation.
  Dependencies: none.

### Step 3 — [coder] Extract `buildApp()` in the coordinator

File: `drone-coordinator/src/index.ts`

- Introduce and **export**:
  ```ts
  export async function buildApp(opts?: {
    getToken?: () => string | null;
  }): Promise<FastifyInstance> {
    const app = fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
    await app.register(fastifyCors, {
      origin: process.env.NODE_ENV === 'development' ? true : false,
    });
    if (opts?.getToken) {
      app.addHook('onRequest', createWebAuthMiddleware(opts.getToken));
    }
    await registerRoutes(app);
    return app;
  }
  ```
  NOTE: `fastify()` here creates the instance WITHOUT the `https`/TLS options — TLS stays a `main()` concern. If tests ever need the TLS-configured instance that is out of scope; route tests use plain HTTP inject.
- Refactor the existing private `setupServer(app, uiDistPath, opts)` into a UI-glue helper, e.g.:
  ```ts
  async function attachUi(
    app: FastifyInstance,
    uiDistPath: string
  ): Promise<void> {
    /* websocket /ws, fastify-static, GET '/', setNotFoundHandler */
  }
  ```
  It keeps the CORS/auth registration OUT (now in `buildApp`). The `/ws` handler, static registration, `/` route, and SPA fallback move here unchanged.
- Ensure the WebSocket `getToken` gating logic that lived in `setupServer` still has access to a token provider. Simplest approach: pass `opts?.getToken` into `attachUi` as well, OR register the `/ws` handler in `main()` where both `app`/`webApp` and their token providers are in scope. Keep behavior identical to today.
  Dependencies: none (structural).

### Step 4 — [coder] Rewire `main()` to use `buildApp` + `attachUi`; guard self-invoke

File: `drone-coordinator/src/index.ts`

- In `main()`, after `initDatabase` / `seedDefaults` / `initStorage` / `initWebToken` / TLS setup:
  - Primary server: `const app = await buildApp();` then, if `config.useHttps`, note that TLS requires constructing the fastify instance with `https` options. Because `buildApp` constructs its own instance, handle TLS one of two ways (pick the lower-risk one during implementation and note it in the PR):
    - **(preferred)** Give `buildApp` an optional `opts.https?: { cert: Buffer; key: Buffer }` param and pass it through to the `fastify({...})` constructor. This keeps a single construction path.
    - (fallback) Keep the TLS-configured primary `app` constructed in `main()` and factor the _assembly_ (CORS+auth+routes) into a separate `assembleApi(app, opts)` that both `buildApp` and `main` call. If chosen, `buildApp` becomes `const app = fastify(...); await assembleApi(app, opts); return app;`.
  - Web server: `const webApp = await buildApp({ getToken: () => getWebToken() });`
  - Call `await attachUi(app, uiDistPath);` and `await attachUi(webApp, uiDistPath);` (attach ws with the appropriate token provider for `webApp`).
- Remove the module-bottom `main();` call. Replace with an entry guard OR leave `main` un-invoked and rely on the bin wrapper (Step 5). Recommended explicit guard for safety when run directly via node:
  ```ts
  import { pathToFileURL } from 'node:url';
  const invokedDirectly =
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  if (invokedDirectly) void main();
  ```
- Keep `export`s: `buildApp`, `main` (and the subcommand handlers stay module-private; they are only called from `main`).
  Dependencies: Step 3.

### Step 5 — [coder] Update `bin/drone-coordinator` to call `main()`

File: `drone-coordinator/bin/drone-coordinator`

- Change from:
  ```js
  #!/usr/bin/env node
  import '../dist/index.js';
  ```
  to:
  ```js
  #!/usr/bin/env node
  import { main } from '../dist/index.js';
  main();
  ```
- Rationale: the entry guard in Step 4 evaluates false when the module is `import`-ed by the wrapper (the wrapper, not `dist/index.js`, is `process.argv[1]`), so the server would never start otherwise.
  Dependencies: Step 4.

### Step 6 — [coder] Anchor coordinator wiki under config dir

File: `drone-coordinator/src/index.ts` (inside `main()`, near `initStorage(config.configDir)`)

- Add import: `import { setKnowledgeBaseDir } from 'drone-swarm-common/wiki-storage';`
- Add call (before routes serve traffic, alongside `initStorage`):
  ```ts
  setKnowledgeBaseDir(path.join(config.configDir, 'knowledge-base'));
  ```
  Dependencies: Step 1 (uses `config.configDir`).

### Step 7 — [coder] Anchor beacon wiki under config dir

File: `drone-beacon/src/index.ts` (inside `main()`, after `fs.mkdirSync(config.configDir, ...)` / `initDatabase`)

- Add import: `import { setKnowledgeBaseDir } from 'drone-swarm-common/wiki-storage';`
- Add call:
  ```ts
  setKnowledgeBaseDir(path.join(config.configDir, 'knowledge-base'));
  ```
  Dependencies: Step 2.

### Step 8 — [tester/coder] Verify no existing tests depend on old defaults

- Search beacon + coordinator tests (and `coordinator-client.test.ts`) for assumptions about `./config`, `./knowledge-base`, or import-time server startup.
- The `db`/`storage`/`knowledge` coordinator tests init their own temp dirs and should be unaffected. Confirm.
- If any test imported `index.ts` for a side effect, update it to import `buildApp`/`main` explicitly.
  Dependencies: Steps 1–7.

### Step 9 — [tester] Run validation criteria (final step)

Run the full validation suite (see below) and confirm all green.
Dependencies: Steps 1–8.

---

## Validation Criteria

1. **LSP diagnostics clean** for all touched files (`drone-coordinator/src/index.ts`, `drone-beacon/src/index.ts`, `drone-coordinator/bin/drone-coordinator`) — no new errors/warnings.
2. **`pnpm typecheck`** passes across the workspace.
3. **`pnpm lint`** (ESLint + Prettier) passes — this is the project's "linting" process.
4. **`pnpm test`** passes (no regressions from the refactor / default-dir changes).
5. **`pnpm build`** succeeds (confirms `bin` + `dist` wiring is intact).
6. **Manual smoke (documented, optional):** starting the coordinator with no `--config-dir` creates `~/.drone-coordinator/` (db + `knowledge-base/` + blobs), and the beacon creates `~/.drone-beacon/`; a co-located run no longer shares one `knowledge-base`.
7. `buildApp` is exported and importable from `drone-coordinator/src/index.ts` without triggering `main()` / port binding (verified structurally; Plan B depends on this).
