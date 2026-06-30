---
key: test-suite-plan-beacon-coordinator
tags:
  - plan
  - test-suite
  - beacon
  - coordinator
  - 3.10
created: 2026-06-30T00:52:42.778Z
updated: 2026-06-30T00:52:42.778Z
---

# Plan: 3.10 — Test Suite for drone-beacon and drone-coordinator

## Summary

The `drone-beacon` and `drone-coordinator` packages currently have minimal to no test coverage. The coordinator has a single test file (`knowledge.test.ts`) covering the knowledge CRUD database functions. The beacon has zero tests. This plan adds comprehensive test suites for both packages, following the existing patterns established in the monorepo (vitest, temp directory isolation, direct DB function testing, and route-level testing via Fastify's `inject`).

## Why This Matters

- **Correctness:** The swarm infrastructure (beacon + coordinator) is the backbone of multi-agent coordination. Bugs here affect all agents.
- **Regression protection:** As the roadmap progresses (3.7–3.9, Phase 4+), changes to the swarm layer need a safety net.
- **Development velocity:** Tests enable faster iteration — changes can be validated without manual server restarts.

---

## Step 1: Update Root Vitest Config to Include Both Packages

**File:** `vitest.config.ts`

Add `drone-beacon/test/**/*.test.ts` and `drone-coordinator/test/**/*.test.ts` to the `include` array.

```typescript
// In the test.include array, add:
'drone-beacon/test/**/*.test.ts',
'drone-coordinator/test/**/*.test.ts',
```

**Dependencies:** None
**Assigned to:** coder

---

## Step 2: Add vitest devDependencies to Both Packages (if needed)

**Files:** `drone-beacon/package.json`, `drone-coordinator/package.json`

Verify that `pnpm test` works in each package directory. The root has vitest, but each package may need it in devDependencies for direct invocation.

**Dependencies:** Step 1
**Assigned to:** coder

---

## Step 3: Create Shared Test Utilities

**File:** `drone-beacon/test/setup.ts` and `drone-coordinator/test/setup.ts`

Create shared test helpers for database setup/teardown, following the pattern in `knowledge.test.ts`:

```typescript
// drone-beacon/test/setup.ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '../src/db.js';

let dbPath = '';

export async function setupDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-beacon-test-'));
  const dbFile = path.join(dir, 'test.db');
  initDatabase(dbFile);
  dbPath = dbFile;
  return dbFile;
}

export async function teardownDb(): Promise<void> {
  closeDatabase();
  if (dbPath) {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
  }
  dbPath = '';
}
```

Same pattern for coordinator with `drone-coordinator-test-` prefix.

**Dependencies:** Step 1
**Assigned to:** coder

---

## Step 4: Coordinator — Database Layer Tests

**File:** `drone-coordinator/test/db.test.ts`

Covers all database functions not yet tested:

### 4a. Persona CRUD
- `createPersona` — creates with correct fields, scope='coordinator'
- `getPersona` — returns persona by id, returns undefined for missing
- `listPersonas` — returns all personas
- `updatePersona` — updates fields, preserves createdAt, returns undefined for missing
- `deletePersona` — deletes and returns true, returns false for missing

### 4b. Skill CRUD
- Same pattern as personas (create, get, list, update, delete)

### 4c. Beacon CRUD
- `registerBeacon` — creates beacon record
- `getBeacon` — returns by id, undefined for missing
- `listBeacons` — returns all
- `heartbeatBeacon` — updates lastHeartbeat
- `deleteBeacon` — deletes and returns boolean

### 4d. Beacon Trust
- `registerBeaconTrust` — creates trust record, auto-approves localhost, generates token for remote
- `registerBeaconTrust` — re-register with matching public key updates connection info
- `registerBeaconTrust` — re-register with mismatched public key throws error
- `getBeaconTrust` — returns by beaconId
- `listBeaconTrust` — returns all
- `approveBeacon` — approves pending beacon by token, returns null for invalid token
- `rejectBeacon` — rejects beacon
- `deleteBeaconTrust` — deletes

### 4e. Beacon Session CRUD
- `createBeaconSession` — creates session linked to beacon
- `getBeaconSession` — returns active session by beacon+agent
- `listBeaconSessions` — lists sessions for a beacon
- `endBeaconSession` — sets disconnectedAt and durationMs
- `deleteBeaconSession` — deletes

### 4f. Swarm Session & Events
- `createSwarmSession` — creates with status 'active'
- `getSwarmSession` — returns by id
- `updateSwarmSessionStatus` — updates status
- `createSwarmEvent` — creates event linked to session
- `getSwarmEvents` — lists events with optional correlationId/limit/offset
- `getLatestSwarmEvents` — returns most recent N events
- `searchSwarmEvents` — FTS5 search on payload

### 4g. Agent Location
- `registerAgentLocation` — registers agent on beacon
- `getAgentLocation` — returns by agentId
- `updateAgentLocationHeartbeat` — updates timestamp
- `unregisterAgentLocation` — removes
- `listAgentLocationsByBeacon` — lists by beacon
- `listAllAgentLocations` — lists all

### 4h. Insight & Principle CRUD
- `createInsight` / `listInsights` / `getInsight` / `deleteInsight`
- `createPrinciple` / `listPrinciples` / `getPrinciple` / `deletePrinciple`

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 5: Coordinator — Route Tests

**File:** `drone-coordinator/test/routes.test.ts`

Test Fastify route handlers using `inject` method.

### 5a. Health Route
- `GET /health` returns `{ status: 'ok', timestamp: number }`

### 5b. Persona Routes
- `POST /personas` — creates persona, returns 201
- `GET /personas` — lists personas
- `GET /personas/:id` — returns persona or 404
- `PUT /personas/:id` — updates persona or 404
- `DELETE /personas/:id` — deletes or 404

### 5c. Skill Routes
- Same pattern as personas

### 5d. Beacon Routes
- `POST /beacons` — registers beacon (with and without publicKey)
- `GET /beacons` — lists beacons with trust status
- `GET /beacons/:id` — returns beacon+trust or 404
- `POST /beacons/trust` — registers trust
- `GET /beacons/trust` — lists trust records
- `GET /beacons/trust/:id` — returns trust status
- `DELETE /beacons/trust/:id` — deletes trust
- `POST /beacons/approve` — approves by token
- `POST /beacons/trust/:id/reject` — rejects
- `POST /beacons/:id/sessions` — creates session
- `GET /beacons/:id/sessions` — lists sessions
- `GET /beacons/:id/sessions/:agentId` — gets session
- `DELETE /beacons/:id/sessions/:agentId` — ends session

### 5e. Knowledge Routes
- `POST /knowledge` — creates knowledge
- `GET /knowledge` — lists (with optional type filter)
- `GET /knowledge/:id` — gets or 404
- `PUT /knowledge/:id` — updates or 404
- `DELETE /knowledge/:id` — deletes or 404
- `GET /knowledge/search` — searches (with q and type params)
- `POST /sync/knowledge/push` — upserts knowledge
- `GET /sync/knowledge/pull` — pulls knowledge (with optional since/type)

### 5f. Swarm Routes
- `POST /sync/sessions/register` — registers session
- `POST /sync/events/push` — pushes events (including large payload test)
- `GET /sessions/:id/events` — gets events
- `GET /sessions/:id/events/latest` — gets latest events
- `GET /events/search` — FTS5 search
- `POST /agents/location` — registers location
- `GET /agents/location/:agentId` — gets location
- `POST /agents/location/:agentId/heartbeat` — heartbeat
- `DELETE /agents/location/:agentId` — unregisters
- `GET /agents/location` — lists (with optional beaconId filter)

### 5g. Message Routes
- `POST /messages/relay` — relays message (test with mock fetch for target beacon)
- `POST /messages/broadcast` — broadcasts to all beacons

### 5h. Insight & Principle Routes
- CRUD for both, including validation (400 on missing required fields)

### 5i. Wiki Routes
- CRUD for wiki pages (uses filesystem, needs temp dir for knowledge-base)
- `GET /wiki/search` — search
- `POST /wiki/lint` — lint

**Note:** For routes that make outbound HTTP calls, mock `globalThis.fetch` using the pattern from `migration.test.ts`.

**Dependencies:** Step 3, Step 4
**Assigned to:** coder

---

## Step 6: Coordinator — Storage Layer Tests

**File:** `drone-coordinator/test/storage.test.ts`

- `initStorage` — creates blob directory
- `isLargePayload` — returns true for payloads > 10KB
- `storeLargePayload` — stores blob and returns reference string
- `retrieveLargePayload` — retrieves by reference, returns null for invalid ref
- `deleteSessionBlobs` — removes session directory
- Edge cases: empty payload, exact threshold, special characters

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 7: Coordinator — TLS Tests

**File:** `drone-coordinator/test/tls.test.ts`

- `loadOrCreateTlsIdentity` — generates new cert when files don't exist
- `loadOrCreateTlsIdentity` — loads existing cert from disk
- `calculateCertFingerprint` — returns correct SHA-256 fingerprint
- `getTlsOptions` — returns cert and key as Buffers

**Note:** Use `vi.spyOn` to mock `execSync` if openssl is not available in CI.

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 8: Beacon — Database Layer Tests

**File:** `drone-beacon/test/db.test.ts`

### 8a. Persona CRUD (with scope)
- `createPersona` — creates with 'local' scope
- `getPersona` / `listPersonas` / `listLocalPersonas`
- `updatePersona` / `deletePersona`
- `upsertPersonaFromCoordinator` — upserts with 'coordinator' scope

### 8b. Skill CRUD (with scope)
- Same pattern as personas, plus `upsertSkillFromCoordinator`

### 8c. Agent Session CRUD
- `registerAgent` — creates session
- `getAgent` / `listAgents`
- `updateAgentActivity` — updates lastActivity
- `unregisterAgent` — deletes

### 8d. Memory CRUD
- `createMemory` — creates with TTL support
- `getMemory` / `getMemoryByKey` / `listMemories` (with namespace/expired filters)
- `updateMemory` / `deleteMemory`
- `cleanupExpiredMemories` — removes expired entries
- `isMemoryExpired` — checks TTL

### 8e. Message CRUD
- `createMessage` — creates with from/to/channel
- `getMessage` / `listMessagesForAgent` / `listMessagesByChannel`
- `markMessageDelivered` / `cleanupOldMessages`

### 8f. Spawn CRUD
- `createSpawn` — creates spawn record
- `getSpawn` / `listSpawns` (with status filter)
- `updateSpawnStatus` — updates with various status transitions
- `deleteSpawn` / `getSpawnByAgentId`

### 8g. Beacon Config CRUD
- `createBeaconConfig` / `getBeaconConfig` / `listBeaconConfig`
- `updateBeaconConfig` / `deleteBeaconConfig`

### 8h. Event Log CRUD
- `createEventLog` — creates with event type
- `getEventLog` / `listEventLogs` (with agentId/eventType/since/limit filters)
- `cleanupOldEventLogs`

### 8i. Knowledge Cache
- `cacheKnowledge` / `getCachedKnowledge` / `listCachedKnowledge`
- `clearKnowledgeCache` / `replaceKnowledgeCache`

### 8j. Insight & Principle CRUD
- Same pattern as coordinator

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 9: Beacon — Route Tests

**File:** `drone-beacon/test/routes.test.ts`

### 9a. Health Route
- `GET /health`

### 9b. Persona Routes
- CRUD with coordinator sync (mock the coordinator client)

### 9c. Skill Routes
- CRUD with coordinator sync

### 9d. Agent Routes
- `POST /agents` — registers agent, updates spawn record if exists
- `GET /agents` / `GET /agents/:id`
- `POST /agents/:id/heartbeat`
- `DELETE /agents/:id` — unregisters, syncs session end

### 9e. Memory Routes
- CRUD with namespace/expired filters
- `GET /memory/key/:key` — by key with JSON parsing

### 9f. Message Routes
- `POST /messages` — send (with validation for sender/recipient)
- `GET /messages` — list for agent
- `GET /messages/:id` / `POST /messages/:id/read`
- `GET /messages/channel/:channel`

### 9g. Spawn Routes
- `POST /spawn` — spawn agent (mock spawner)
- `GET /spawn` / `GET /spawn/:spawnId`
- `DELETE /spawn/:spawnId` — terminate

### 9h. Config Routes
- CRUD for beacon config overrides

### 9i. Event Routes
- `GET /events` / `GET /events/:id`

### 9j. Insight & Principle Routes
- CRUD with coordinator proxy (mock the proxy)

### 9k. Wiki Routes
- CRUD with coordinator proxy
- `GET /wiki/search` / `POST /wiki/lint`

### 9l. Sync Route
- `POST /sync` — triggers coordinator sync

**Dependencies:** Step 3, Step 8
**Assigned to:** coder

---

## Step 10: Beacon — Identity Tests

**File:** `drone-beacon/test/identity.test.ts`

- `generateIdentity` — generates Ed25519 keypair with correct structure
- `loadOrCreateIdentity` — loads existing from disk
- `loadOrCreateIdentity` — generates new when file missing
- `getSigningKey` — returns valid KeyObject

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 11: Beacon — TLS Tests

**File:** `drone-beacon/test/tls.test.ts`

Same pattern as coordinator TLS tests (Step 7).

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 12: Beacon — Wiki Storage Tests

**File:** `drone-beacon/test/wiki-storage.test.ts`

- `writePage` / `readPage` / `deletePage` / `listPages`
- `searchPages` — title, tag, and content matching
- `lintPages` — broken links, downward links, orphans
- Downward link enforcement on write
- Path traversal prevention

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 13: Coordinator — Wiki Storage Tests

**File:** `drone-coordinator/test/wiki-storage.test.ts`

Same pattern as Step 12, but for the coordinator's copy of wiki-storage.ts.

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 14: Beacon — WebSocket Server Tests

**File:** `drone-beacon/test/ws-server.test.ts`

- `isLocalConnection` — various IP patterns (127.0.0.1, ::1, 192.168.x.x, 10.x.x.x, public IPs)
- `isAgentConnected` / `getConnectedAgents` / `getConnection`
- `sendToAgent` / `sendToChannel`
- Message handling: direct message, channel broadcast, subscribe/unsubscribe, ping/pong, ack
- Error handling: missing agentId, invalid message format

**Dependencies:** Step 3, Step 8
**Assigned to:** coder

---

## Step 15: Beacon — Coordinator Client Tests

**File:** `drone-beacon/test/coordinator-client.test.ts`

- `createCoordinatorClient` — returns client with all methods
- `createCoordinatorFetch` — creates fetch wrapper
- `registerBeacon` / `pollForApproval` / `heartbeat`
- `fetchPersonas` / `fetchSkills` — marks results with coordinator scope
- Session management: `registerSession` / `endSession`
- Agent location: `registerAgentLocation` / `updateAgentLocationHeartbeat` / `unregisterAgentLocation`
- `relayMessage` — cross-beacon message relay
- Knowledge push/pull/search
- Swarm session: `registerSwarmSession` / `pushEvents`

Use `vi.fn()` to mock `globalThis.fetch` or the internal HTTP module.

**Dependencies:** Step 3
**Assigned to:** coder

---

## Step 16: Run Tests and Fix Issues

Run `pnpm test` from the root and fix any failures:
- TypeScript compilation issues
- Import path resolution
- Test logic errors
- Edge cases discovered during testing

**Dependencies:** All prior steps
**Assigned to:** coder

---

## Step 17: Validation Criteria

Before marking complete, verify:
1. **All LSP checks pass** — no TypeScript errors in any test files
2. **`pnpm test` passes** — all existing tests + new tests pass
3. **`pnpm typecheck` passes** — no type errors in beacon or coordinator packages
4. **Coverage baseline established** — run `pnpm test:coverage` and note coverage percentages
5. **No flaky tests** — run the full suite twice to check for non-deterministic failures
6. **Test files follow project conventions** — temp directory isolation, `beforeEach`/`afterEach` cleanup, descriptive test names

**Assigned to:** reviewer

---

## Execution Order

```
Step 1  (vitest config) ──────┐
                              ├── Step 3 (shared setup) ──┐
Step 2  (dependencies) ──────┘                            │
                                                          ├── Step 4  (coordinator db tests) ──┐
                                                          ├── Step 6  (coordinator storage)  ──┤
                                                          ├── Step 7  (coordinator tls)      ──┤
                                                          │                                     ├── Step 5  (coordinator routes) ──┐
                                                          ├── Step 8  (beacon db tests)       ──┤                                     │
                                                          ├── Step 10 (beacon identity)      ──┤                                     │
                                                          ├── Step 11 (beacon tls)           ──┤                                     │
                                                          ├── Step 12 (beacon wiki)          ──┤                                     │
                                                          ├── Step 14 (beacon ws-server)     ──┤                                     │
                                                          ├── Step 15 (beacon coordinator-client) ──┤                              │
                                                          │                                     ├── Step 9  (beacon routes)    ──┤
                                                          ├── Step 13 (coordinator wiki)      ──┤                                     │
                                                          │                                     ├── Step 16 (run & fix) ◄──────────┘
                                                          │                                     │
                                                          └─────────────────────────────────────┘
                                                                                              │
                                                                                              ▼
                                                                                        Step 17 (validate)
```

**Parallelizable groups:**
- Steps 4, 6, 7 (coordinator non-route) can be done in parallel
- Steps 8, 10, 11, 12, 14, 15 (beacon non-route) can be done in parallel
- Steps 5 and 9 (route tests) depend on their respective db tests
- Steps 12 and 13 (wiki) can be done in parallel