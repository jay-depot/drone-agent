---
key: plan-coordinator-route-tests
tags:
  - plan
  - coordinator
  - tests
  - roadmap-3.10
  - fastify-inject
created: 2026-07-03T01:14:47.947Z
updated: 2026-07-03T01:14:47.947Z
---

# Plan B — Coordinator Route Test Coverage (roadmap 3.10)

## Summary

**What:** Add HTTP route-level (integration) test coverage for the `drone-coordinator` Fastify routes using the exported `buildApp()` (from Plan A) and `app.inject()`. Covers every route file in `drone-coordinator/src/routes/`.

**Why:** Roadmap item 3.10 ("Coordinator Test Coverage"). The coordinator currently has strong **DB-layer** coverage (`db.test.ts` ~76 tests, `knowledge.test.ts` 13, `storage.test.ts` 11 — 100 passing) but **zero route-level tests** — no test constructs the Fastify app or exercises request validation, status codes, the coordinator-proxy/relay behavior, or error paths. This plan closes that gap. (Note: the roadmap's 3.10 description is stale — it claims "1 test file"; reality is 3 files / 100 tests, all DB/storage. Update the roadmap as part of this work.)

**Depends on:** Plan A (`plan-coordinator-server-refactor`) — specifically the exported `buildApp()` and the `main()` self-invoke guard. Do not start until Plan A's validation is green.

---

## Design Decisions (settled with user)

- **Harness:** tests build the real assembled API app via `buildApp()` and drive it with `app.inject()` (no ports bound; consistent with the single-fork vitest pool). Fully-assembled route layer incl. CORS; auth tested where relevant.
- **`messages.ts` fetch:** stub `global.fetch` with `vi.fn()`; assert **observable behavior only** (status codes, `delivered`/`deliveredCount`), NOT `fetch` call internals — those routes are slated to drop raw `fetch` later, and behavior-focused tests survive that refactor.
- **wiki tests:** set a per-test temp `knowledge-base` dir via `setKnowledgeBaseDir()` (module-level state in `drone-swarm-common/wiki-storage`), cleaned up in `afterEach`.
- **Bug policy:** write tests against the *intended* contract. If a test exposes a small, clearly-correct route bug (e.g. route ordering, wrong status code), fix it in-scope and note it. Anything ambiguous or larger → log a `self-improvement__insight` and leave code unchanged.

---

## Shared Harness

### Step 0 — [coder] Add a shared route-test helper
File: `drone-coordinator/test/helpers/server.ts` (new)
- Export a factory that returns a ready, injectable app bound to a fresh temp DB + storage + wiki dir:
  ```ts
  import { mkdtemp, rm } from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  import type { FastifyInstance } from 'fastify';
  import { initDatabase, closeDatabase } from '../../src/db.js';
  import { initStorage } from '../../src/storage.js';
  import { setKnowledgeBaseDir } from 'drone-swarm-common/wiki-storage';
  import { buildApp } from '../../src/index.js';

  export interface TestCtx { app: FastifyInstance; dir: string; }

  export async function makeApp(
    opts?: { getToken?: () => string | null }
  ): Promise<TestCtx> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-coord-routes-'));
    initDatabase(path.join(dir, 'test.db'));
    initStorage(dir);
    setKnowledgeBaseDir(path.join(dir, 'knowledge-base'));
    const app = await buildApp(opts);
    await app.ready();
    return { app, dir };
  }

  export async function teardownApp(ctx: TestCtx): Promise<void> {
    await ctx.app.close();
    closeDatabase();
    await rm(ctx.dir, { recursive: true, force: true });
  }
  ```
- NOTE: because vitest uses a single fork and `db.ts`/`storage.ts`/`wiki-storage` hold module-level singletons, tests must NOT run in parallel against different DBs within one file's lifetime — use `beforeEach`/`afterEach` (make + teardown) per test, matching the existing `db.test.ts` pattern.
Dependencies: Plan A (buildApp export).

---

## Per-Route Test Files (all use the harness; `app.inject()` for requests)

### Step 1 — [coder] `test/routes/health.test.ts`
- `GET /health` → 200, body `{ status: 'ok', timestamp: <number> }`.

### Step 2 — [coder] `test/routes/personas.test.ts`
- `POST /personas` → 201 + created persona.
- `GET /personas` → array incl. created.
- `GET /personas/:id` → 200 hit; 404 miss.
- `PUT /personas/:id` → 200 update; 404 miss.
- `DELETE /personas/:id` → `{ success: true }`; 404 miss.

### Step 3 — [coder] `test/routes/skills.test.ts`
- Mirror personas: POST 201, GET list, GET one (200/404), PUT (200/404), DELETE (success/404).

### Step 4 — [coder] `test/routes/beacons.test.ts` (largest)
- `POST /beacons` **without** publicKey → 201 registers plain beacon.
- `POST /beacons` **with** publicKey → 201, body `{ status, approvalToken? }`; also registers in beacons table (verify via `GET /beacons`).
- `POST /beacons` public-key mismatch on re-register → 403 (register once, re-register same id with different key).
- `GET /beacons` → array with `trustStatus`/`publicKey` merge fields.
- `GET /beacons/:id` → 200 merged; 404 when neither beacon nor trust exists.
- `POST /beacons/trust` → 201 `{ status, approvalToken? }`; mismatch → 403.
- `GET /beacons/trust/:id` → 200 (pending includes token); 404 miss.
- `GET /beacons/trust` → array.
- `DELETE /beacons/trust/:id` → success; 404 miss.
- `POST /beacons/approve` → missing token 400; invalid token 404; valid token → `{ success: true, beacon }` (seed a pending trust to get a real token).
- `POST /beacons/trust/:id/reject` → success; 404 miss.
- Beacon sessions: `POST /beacons/:id/sessions` (201 when beacon exists; 404 when not), `GET /beacons/:id/sessions` (list; 404 no beacon), `GET /beacons/:id/sessions/:agentId` (200/404), `DELETE .../:agentId` (200/404).

### Step 5 — [coder] `test/routes/knowledge.test.ts` (route-level; complements existing db-level knowledge.test.ts)
- POST 201; GET list (with `?type` filter); GET one (200/404); PUT (200/404); DELETE (success/404).
- `GET /knowledge/search?q=` (hits) and without `q` (falls back to list); with `?type`.
- `POST /sync/knowledge/push` → 200 upsert; `GET /sync/knowledge/pull?since=&type=` filtering.
- NOTE confirm route registration order doesn't let `/knowledge/:id` shadow `/knowledge/search` — pin with a test.

### Step 6 — [coder] `test/routes/insights.test.ts`
- `POST /insights` → 400 when missing any of targetType/targetId/insight; 201 on valid.
- `GET /insights` (+ `?targetType&targetId` filters); `GET /insights/:id` (200/404); `DELETE /insights/:id` (success/404).

### Step 7 — [coder] `test/routes/principles.test.ts`
- Mirror insights: POST 400/201, GET list+filters, GET one 200/404, DELETE success/404.

### Step 8 — [coder] `test/routes/wiki.test.ts`
- Uses the harness temp `knowledge-base`.
- `PUT /wiki/:pageId` → 400 when missing title/content; 200 on valid write (assert returned page).
- `GET /wiki` → list incl. written page.
- `GET /wiki/:pageId` → 200 hit; 404 miss.
- `GET /wiki/search?q=` → results; empty `q` → `[]`.
- `POST /wiki/lint` → lint result shape.
- `DELETE /wiki/:pageId` → success; 404 miss.
- **Route-ordering check:** explicitly assert `GET /wiki/search` is NOT shadowed by `GET /wiki/:pageId` (write a page named e.g. `search`? No — instead assert `/wiki/search?q=foo` returns search results, not a 404 page-lookup). If shadowed, apply the bug policy (reorder route registration in `wiki.ts`).

### Step 9 — [coder] `test/routes/swarm.test.ts` (largest route file)
- Swarm sessions: `POST /sync/sessions/register` (400 missing id/beaconId; 201 valid); `DELETE /sync/sessions/:id` (200 ended; 404 miss).
- Events push: `POST /sync/events/push` (400 empty/omitted array; 201 with count); include one **large payload** event to exercise the `isLargePayload` → blob storage branch (assert it still returns 201 and later resolves).
- `GET /sessions/:id/events` (404 no session; 200 list; `?correlationId/limit/offset`).
- `GET /sessions/:id/events/latest` (404/200, `?limit`).
- `GET /events/search?q=` (400 missing q; results otherwise).
- Session pipeline: `GET /sessions` (list + count, `?status/sortBy/...`), `GET /sessions/:id/log` (404/200; blob payloads resolved back), `POST /sessions/:id/process` (404 miss; 409 wrong-state; 200 valid transition — seed via register + push), `POST /sessions/:id/processed` (404/409/200).
- Tool defs: `POST /sync/tools/push` (400 empty; 201 count), `GET /tools/default-hidden` (shape `{ tools: string[] }`).
- Agent locations: `POST /agents/location` (400 missing; 201), `GET /agents/location/:agentId` (404/200 with beaconHost/Port), `POST /agents/location/:agentId/heartbeat` (404/success), `DELETE /agents/location/:agentId` (404/success), `GET /agents/location` (all; `?beaconId` filter).

### Step 10 — [coder] `test/routes/messages.test.ts` (stub `global.fetch`)
- Setup: `const realFetch = global.fetch; afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });`
- `POST /messages/relay`:
  - missing any field → 400 (no fetch needed).
  - unknown target agent → 404 `AGENT_NOT_FOUND` (register nothing).
  - agent location exists but beacon missing → 503 `BEACON_NOT_FOUND` (register agent location w/ beaconId that has no beacon row).
  - happy path: register beacon + agent location, stub `fetch` → `{ ok: true, json: async () => ({ id: 'm1' }) }` → 200 `{ success: true, messageId: 'm1', delivered: true }`.
  - target beacon returns non-ok: stub `{ ok: false, text: async () => 'err' }` → 502.
  - fetch throws: stub to reject → 503 `BEACON_UNAVAILABLE`.
- `POST /messages/broadcast`:
  - missing field → 400.
  - with N beacons registered, stub `fetch` (mix ok/throw) → assert `{ success: true, deliveredCount, totalBeacons }` reflects only ok deliveries.
- Assert only on response bodies/status (behavior), not on how `fetch` was called (future-proof against the planned `fetch` removal).

### Step 11 — [coder] `test/routes/auth.test.ts` (auth middleware path)
- Build app WITH a token: `makeApp({ getToken: () => 'secret' })`.
- Local request (default inject IP is 127.0.0.1 → `isLocalRequest` true) to a protected route → passes (no 401).
- Simulate a **non-local** request: `app.inject({ method: 'GET', url: '/personas', remoteAddress: '8.8.8.8' })` (verify `remoteAddress` maps to `req.ip`; if inject doesn't set `req.ip` from `remoteAddress`, use a `headers: { 'x-forwarded-for' }` approach only if `trustProxy` is enabled — otherwise document that non-local simulation requires `remoteAddress` support and adjust). Expected: no token header → 401; correct `Authorization: Bearer secret` → passes.
- NOTE: if reliably forcing a non-local `req.ip` via inject proves impractical, fall back to a focused unit test of `createWebAuthMiddleware`/`isLocalRequest` in `web-auth.ts` instead, and log an insight about inject IP limitations.

### Step 12 — [coder] Update roadmap memory
- Edit the `roadmap` project memory item 3.10 to reflect: DB/storage coverage already substantial (100 tests); this effort adds full route/integration coverage via `buildApp()` + `inject()`. Mark 3.10 complete (or near-complete) once tests land.

### Step 13 — [tester] Run validation criteria (final step)
Run the full validation suite and confirm green.

---

## Validation Criteria

1. **LSP diagnostics clean** for all new test files and any route files touched by bug fixes.
2. **`pnpm typecheck`** passes across the workspace.
3. **`pnpm lint`** (ESLint + Prettier) passes — the project's "linting" process.
4. **`pnpm test`** passes, now including all new `drone-coordinator/test/routes/*.test.ts` files; no regressions in existing tests.
5. Every route file in `drone-coordinator/src/routes/` (health, personas, skills, beacons, knowledge, insights, principles, wiki, swarm, messages) has at least happy-path + primary error-path (400/404/409/403/503 as applicable) coverage.
6. `messages` tests pass without binding ports (fetch stubbed) and assert only observable behavior.
7. Any route bug discovered is either fixed in-scope (small/clear) or logged as an insight (ambiguous/large), per the bug policy.
8. Roadmap 3.10 memory updated.
