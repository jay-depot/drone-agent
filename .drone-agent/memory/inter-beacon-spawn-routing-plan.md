---
key: inter-beacon-spawn-routing-plan
tags: []
created: 2026-07-06T01:06:32.898Z
updated: 2026-07-06T01:20:13.841Z
---

# 3.9 Inter-Beacon Spawn Routing — Implementation Plan

## Summary

Add a `POST /spawn` route to the coordinator that accepts spawn requests and forwards them to a target beacon. This mirrors the existing message relay pattern in `routes/messages.ts`. The `targetBeaconId` is required (no auto-selection in this pass). The coordinator validates the beacon exists, then forwards the request to the beacon's existing `/spawn` endpoint via HTTP, returning the beacon's response to the caller.

## Files to Modify

1. **`drone-coordinator/src/types.ts`** — Add `SpawnConfig` and `SpawnRequest` types
2. **`drone-coordinator/src/routes/spawn.ts`** — New file: spawn route handler
3. **`drone-coordinator/src/routes/index.ts`** — Register the new spawn route
4. **`drone-coordinator/test/routes.test.ts`** — Add tests for the spawn route

## Step-by-Step

### Step 1: Add SpawnConfig and SpawnRequest types to coordinator types

**File:** `drone-coordinator/src/types.ts`

Add after the existing types (around line 125, before the closing of the file):

```typescript
// === Spawn Types ===

export interface SpawnConfig {
  model?: string;
  preamble?: string;
  workingDir?: string;
  env?: Record<string, string>;
}

export interface SpawnRequest {
  targetBeaconId: string;
  personaId?: string;
  task?: string;
  config?: SpawnConfig;
  spawnId?: string;
}
```

These mirror the beacon's `SpawnConfig` and `SpawnRequest` types from `drone-beacon/src/types.ts`, with the addition of `targetBeaconId`.

### Step 2: Create the spawn route handler

**File:** `drone-coordinator/src/routes/spawn.ts` (new file)

This follows the exact same pattern as `routes/messages.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';
import type { SpawnRequest } from '../types.js';

export default function spawnRoutes(app: FastifyInstance) {
  app.post<{ Body: SpawnRequest }>('/spawn', async (request, reply) => {
    const { targetBeaconId, personaId, task, config, spawnId } = request.body;

    // Validate required field
    if (!targetBeaconId) {
      return reply.code(400).send({
        error: 'targetBeaconId is required',
      });
    }

    // Look up the target beacon
    const beacon = db.getBeacon(targetBeaconId);
    if (!beacon) {
      return reply.code(404).send({
        error: 'Target beacon not found',
        code: 'BEACON_NOT_FOUND',
      });
    }

    // Forward the spawn request to the beacon
    try {
      const targetUrl = `http://${beacon.host}:${beacon.port}`;
      const response = await fetch(`${targetUrl}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId, task, config, spawnId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return reply.code(502).send({
          error: 'Failed to spawn agent on target beacon',
          details: errorText,
        });
      }

      const spawnData = (await response.json()) as Record<string, unknown>;
      return {
        ...spawnData,
        targetBeaconId,
      };
    } catch (err) {
      return reply.code(503).send({
        error: 'Target beacon unavailable',
        details: err instanceof Error ? err.message : 'Unknown error',
        code: 'BEACON_UNAVAILABLE',
      });
    }
  });
}
```

**Key design points:**

- `targetBeaconId` is required — returns 400 if missing
- Validates beacon exists in DB — returns 404 with `BEACON_NOT_FOUND` if not
- Forwards the spawn body (minus `targetBeaconId`) to `POST /spawn` on the beacon
- On beacon error, returns 502 with the beacon's error text
- On network error, returns 503 with `BEACON_UNAVAILABLE`
- On success, returns the beacon's response enriched with `targetBeaconId`
- Uses plain `fetch()` (same as message relay) — no TLS between coordinator and beacons

### Step 3: Register the new route

**File:** `drone-coordinator/src/routes/index.ts`

Add the import and registration call:

```typescript
import spawn from './spawn.js';

export async function registerRoutes(app: FastifyInstance) {
  health(app);
  personas(app);
  skills(app);
  beacons(app);
  knowledge(app);
  insights(app);
  principles(app);
  wiki(app);
  swarm(app);
  messages(app);
  spawn(app); // ← add this line
}
```

### Step 4: Add tests

**File:** `drone-coordinator/test/routes.test.ts`

Add a new `describe('Spawn Route')` block following the same pattern as the message relay tests. The tests should cover:

1. **Happy path** — Register a beacon, POST to `/spawn` with `targetBeaconId`, stub `fetch` to return a successful beacon response, assert the response includes the beacon's spawn data plus `targetBeaconId`.

2. **Missing targetBeaconId** — POST with empty body, assert 400.

3. **Beacon not found** — POST with a non-existent beacon ID, assert 404 with `BEACON_NOT_FOUND`.

4. **Beacon returns error** — Stub `fetch` to return `ok: false`, assert 502 with error details.

5. **Beacon unavailable** — Stub `fetch` to reject, assert 503 with `BEACON_UNAVAILABLE`.

## Validation Criteria

1. **LSP checks pass** — No TypeScript errors in any modified files
2. **`pnpm build` passes** — All packages compile successfully
3. **`pnpm test` passes** — All existing tests continue to pass, plus the new spawn route tests pass
4. **`pnpm lint` passes** — ESLint + Prettier checks pass
5. **Manual verification**: Start a coordinator and a beacon, register the beacon, POST to `/spawn` on the coordinator with `targetBeaconId` set to the beacon's ID, verify the spawn request is forwarded and the response is returned correctly

## Implementation Complete (2026-07-05)

All steps completed and committed in commit `5f2ca66`:

- Added `SpawnConfig` and `SpawnRequest` types to `drone-coordinator/src/types.ts`
- Created `drone-coordinator/src/routes/spawn.ts` with `POST /spawn` handler
- Registered the route in `drone-coordinator/src/routes/index.ts`
- Added 5 test cases in `drone-coordinator/test/routes.test.ts`
- All validations pass: build, 1130 tests, lint
