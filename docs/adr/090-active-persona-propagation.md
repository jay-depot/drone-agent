---
tags: [decision, swarm, persona, coordinator]
related:
  [
    modules/drone-coordinator.md,
    modules/drone-beacon.md,
    modules/drone-agent-plugins.md,
    decisions/026-persona-cli-flag-fix.md,
  ]
---

# ADR 090: Active Persona Propagation to Coordinator Swarm Sessions

**Status**: Implemented (commit `f57d0fe`)

## Problem

The active persona doesn't appear in the coordinator UI's sessions list because the swarm session is registered with the coordinator before the persona is activated.

## Root Cause

1. Swarm plugin registers agent session with beacon at `onPluginsLoaded` with `personaId: null`
2. Beacon syncs this session to coordinator with `personaId: null`
3. Persona plugin activates persona at `onSessionStart` (fires AFTER `onPluginsLoaded`)
4. Coordinator session never gets updated with the active persona ID

## Solution

Add a persona change listener in the swarm plugin that updates the coordinator swarm session when the active persona changes.

### Step 1: Coordinator Database

Added `updateSwarmSessionPersona(id, personaId)` function in `drone-coordinator/src/db/swarm-sessions.ts`.

### Step 2: Coordinator Route

Added `PATCH /sessions/:id/persona` route with body `{ personaId: string | null }` in `drone-coordinator/src/routes/swarm.ts`. Also publishes a `session.persona_changed` event via `publishMutationEvent`.

### Step 3: Beacon Coordinator Client

Added `updateSwarmSessionPersona(sessionId, personaId)` method in `drone-beacon/src/coordinator-client.ts`.

### Step 4: Beacon Agents Route

Added `PATCH /agents/:id/persona` endpoint and `updateAgentPersona()` DB function in `drone-beacon/src/routes/agents.ts` and `drone-beacon/src/db/agents.ts`.

### Step 5: Swarm Hooks

Added `updateSwarmSessionPersona(ctx, personaId)` function in `drone-agent/src/plugins/swarm/hooks.ts` that calls the beacon's PATCH endpoint.

### Step 6: Swarm Index

Subscribed to `personaCap.onPersonaChange` in `drone-agent/src/plugins/swarm/index.ts` to update coordinator when persona changes. Also calls on `onSessionStart` if persona already active.

### Step 7: Event Metadata Enhancement

Added `activePersona` field to conversation event metadata in the `onConversationEvent` hook in `drone-agent/src/plugins/swarm/hooks.ts`.

## Files Changed

- `drone-coordinator/src/db/swarm-sessions.ts` — Added `updateSwarmSessionPersona()`
- `drone-coordinator/src/routes/swarm.ts` — Added `PATCH /sessions/:id/persona`
- `drone-beacon/src/coordinator-client.ts` — Added `updateSwarmSessionPersona()`
- `drone-beacon/src/routes/agents.ts` — Added `PATCH /agents/:id/persona`
- `drone-beacon/src/db/agents.ts` — Added `updateAgentPersona()`
- `drone-agent/src/plugins/swarm/hooks.ts` — Added `updateSwarmSessionPersona()`, activePersona in metadata
- `drone-agent/src/plugins/swarm/index.ts` — Subscribed to `onPersonaChange`

## Validation

- LSP clean
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` passes (104 files, 1632 tests)
