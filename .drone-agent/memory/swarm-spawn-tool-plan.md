---
key: swarm-spawn-tool-plan
tags:
  []
created: 2026-07-06T01:11:20.670Z
updated: 2026-07-06T01:15:14.300Z
---

# Swarm Spawn & Info Tools — Implementation Plan

## Summary

Add a full set of LLM-facing tools to the swarm plugin for remote agent lifecycle management, plus the coordinator proxy routes they depend on. This gives agents the ability to discover swarm topology, spawn agents on remote beacons, and check/terminate their status.

## Part A: Coordinator Proxy Routes

These new routes on the coordinator forward spawn-related requests to the target beacon, mirroring the `POST /spawn` pattern from plan 1.

### Files to Modify

| File | Action |
|------|--------|
| `drone-coordinator/src/routes/spawn.ts` | Add `GET /spawn/:beaconId`, `GET /spawn/:beaconId/:spawnId`, `DELETE /spawn/:beaconId/:spawnId` |

### Routes

**`GET /spawn/:beaconId`** — List spawns on a beacon
- Looks up beacon via `db.getBeacon(beaconId)` → 404 `BEACON_NOT_FOUND` if missing
- Forwards `GET /spawn?status=...` to the beacon
- Returns the beacon's response (array of spawn records)
- Error handling: 502 on beacon error, 503 on network error

**`GET /spawn/:beaconId/:spawnId`** — Get spawn status
- Same beacon lookup + forward pattern
- Forwards `GET /spawn/:spawnId` to the beacon
- Returns the beacon's response (spawn record with status, agentId, exitCode, error, timestamps)

**`DELETE /spawn/:beaconId/:spawnId`** — Terminate a spawned agent
- Same beacon lookup + forward pattern
- Forwards `DELETE /spawn/:spawnId` to the beacon
- Returns the beacon's response

### Code Pattern (example for GET /spawn/:beaconId)

```typescript
app.get<{ Params: { beaconId: string }; Querystring: { status?: string } }>(
  '/spawn/:beaconId',
  async (request, reply) => {
    const beacon = db.getBeacon(request.params.beaconId);
    if (!beacon) {
      return reply.code(404).send({ error: 'Beacon not found', code: 'BEACON_NOT_FOUND' });
    }
    try {
      const query = request.query.status ? `?status=${request.query.status}` : '';
      const response = await fetch(`http://${beacon.host}:${beacon.port}/spawn${query}`);
      if (!response.ok) {
        return reply.code(502).send({ error: 'Beacon error', details: await response.text() });
      }
      return response.json();
    } catch (err) {
      return reply.code(503).send({ error: 'Beacon unavailable', code: 'BEACON_UNAVAILABLE' });
    }
  }
);
```

## Part B: LLM Tools (Swarm Plugin)

### Files to Modify

| File | Action |
|------|--------|
| `drone-agent/src/plugins/swarm/index.ts` | Add `coordinatorUrl` to `SwarmConfig`, add 6 new tool definitions |

### Config Change

Add `coordinatorUrl` to `SwarmConfig`:

```typescript
export interface SwarmConfig {
  beaconHost?: string;
  beaconPort?: number;
  beaconUseHttps?: boolean;
  coordinatorUrl?: string;
  sessionId?: string;
}
```

Read it from user config in `register()`:

```typescript
const coordinatorUrl =
  userSwarmConfig.coordinatorUrl ?? config.coordinatorUrl;
```

### Tool: `swarm__list_beacons`

- Calls `GET /beacons` on the coordinator
- Returns list of beacons with id, name, host, port, trust status
- No required parameters

### Tool: `swarm__list_agents`

- Calls `GET /agents/location` on the coordinator
- Optional `beaconId` parameter to filter agents on a specific beacon
- Returns list of agent locations (agentId, beaconId, personaId, connectedAt, lastHeartbeat)

### Tool: `swarm__spawn`

- Calls `POST /spawn` on the coordinator (from plan 1)
- Parameters: `targetBeaconId` (required), `personaId?`, `task?`, `config?`, `spawnId?`
- Returns spawn result with `spawnId`, `agentId`, `status`, `targetBeaconId`

### Tool: `swarm__get_spawn`

- Calls `GET /spawn/:beaconId/:spawnId` on the coordinator
- Parameters: `beaconId` (required), `spawnId` (required)
- Returns spawn status record

### Tool: `swarm__list_spawns`

- Calls `GET /spawn/:beaconId` on the coordinator
- Parameters: `beaconId` (required), `status?` (optional filter: spawning/running/failed/terminated)
- Returns array of spawn records

### Tool: `swarm__terminate_spawn`

- Calls `DELETE /spawn/:beaconId/:spawnId` on the coordinator
- Parameters: `beaconId` (required), `spawnId` (required)
- Returns success/failure

### Error Handling Pattern (shared across all tools)

```typescript
if (!coordinatorUrl) {
  return JSON.stringify({
    success: false,
    error: 'coordinatorUrl not configured. Set swarm.coordinatorUrl in your config.',
  });
}
try {
  const response = await fetch(`${coordinatorUrl}${path}`, { ... });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    return JSON.stringify({ success: false, error: `Coordinator returned ${response.status}`, details: body });
  }
  const data = await response.json();
  return JSON.stringify({ success: true, ...data });
} catch (err) {
  return JSON.stringify({ success: false, error: 'Failed to reach coordinator', details: err.message });
}
```

## Part C: Tests

### Coordinator Tests (`drone-coordinator/test/routes.test.ts`)

Add a `describe('Spawn Route')` block covering all 4 routes:

- `POST /spawn` — happy path, missing targetBeaconId, beacon not found, beacon error, beacon unreachable
- `GET /spawn/:beaconId` — happy path, beacon not found, beacon error, beacon unreachable
- `GET /spawn/:beaconId/:spawnId` — happy path, beacon not found, spawn not found
- `DELETE /spawn/:beaconId/:spawnId` — happy path, beacon not found, spawn not found

All use `vi.stubGlobal('fetch', ...)` pattern from the existing message relay tests.

### Swarm Plugin Tests (`drone-agent/test/swarm-spawn.test.ts`)

New test file covering all 6 tools:

- Each tool: happy path, missing coordinatorUrl, coordinator error, coordinator unreachable

## Validation Criteria

1. **LSP checks pass** — No TypeScript errors
2. **`pnpm build` passes** — All packages compile
3. **`pnpm test` passes** — All existing + new tests pass
4. **`pnpm lint` passes** — ESLint + Prettier checks pass
5. **Manual verification**: Configure `coordinatorUrl`, start coordinator + beacon, use the tools to list beacons, spawn an agent, check its status, list spawns, and terminate it
