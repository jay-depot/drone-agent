---
key: coordinator-ui-active-persona-bug-fix-plan
tags:
  []
created: 2026-07-28T18:07:52.321Z
updated: 2026-07-28T19:10:54.706Z
---

# Coordinator UI - Active Persona Bug Fix Plan

## Problem Summary
The active persona doesn't appear in the coordinator UI's sessions list because the swarm session is registered with the coordinator before the persona is activated.

## Root Cause
1. Swarm plugin registers agent session with beacon at `onPluginsLoaded` with `personaId: null`
2. Beacon syncs this session to coordinator with `personaId: null`
3. Persona plugin activates persona at `onSessionStart` (fires AFTER `onPluginsLoaded`)
4. Coordinator session never gets updated with the active persona ID

## Solution
Add a persona change listener in the swarm plugin that updates the coordinator swarm session when the active persona changes.

## Files to Modify (in order)

### Step 1: Coordinator Database (`drone-coordinator/src/db/swarm-sessions.ts`)
Add `updateSwarmSessionPersona(id: string, personaId: string | null): SwarmSession | undefined` function

### Step 2: Coordinator Route (`drone-coordinator/src/routes/swarm.ts`)
Add `PATCH /sessions/:id/persona` route with body `{ personaId: string | null }`

### Step 3: Beacon Coordinator Client (`drone-beacon/src/coordinator-client.ts`)
Add `updateSwarmSessionPersona(sessionId: string, personaId: string | null): Promise<void>` method

### Step 4: Beacon Agents Route (`drone-beacon/src/routes/agents.ts`)
Add `PATCH /agents/:id/persona` endpoint and DB update function

### Step 5: Swarm Hooks (`drone-agent/src/plugins/swarm/hooks.ts`)
Add `updateSwarmSessionPersona(ctx: SwarmContext, personaId: string | null): Promise<void>` function

### Step 6: Swarm Index (`drone-agent/src/plugins/swarm/index.ts`)
Subscribe to `personaCap.onPersonaChange` and call update function; also call on `onSessionStart` if persona already active

### Step 7 (Enhancement): Swarm Hooks (`drone-agent/src/plugins/swarm/hooks.ts`)
Add `activePersona` field to event metadata in `onConversationEvent` hook

## Implementation Complete (2026-07-28)
All 7 steps implemented and validated:
- LSP: clean (no errors)
- Build: passes
- Lint: passes
- Tests: 104 files, 1632 tests all pass
- Committed as f57d0fe on branch `feature/web-ui-management-console`

## Validation Criteria
- [x] LSP passes
- [x] `pnpm -r run build` passes
- [x] `pnpm -r run lint` passes
- [x] `pnpm -r run test` passes
- [ ] Manual test: Start coordinator → beacon → agent with `--plugin swarm` and `activePersona` in config → verify persona shows in coordinator UI sessions list
- [ ] Manual test: Switch persona during session → verify coordinator UI updates
- [ ] Manual test: Check session events have `activePersona` in metadata