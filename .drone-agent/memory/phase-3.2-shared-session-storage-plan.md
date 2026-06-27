---
key: phase-3.2-shared-session-storage-plan
tags:
  - swarm
  - planning
  - coordinator
  - session-storage
created: 2026-06-27T22:13:16.288Z
updated: 2026-06-27T22:13:16.288Z
---

# Implementation Plan: Phase 3.2 Shared Session Storage

## Overview
Implement a centralized, high-fidelity ledger of all agent interactions across the swarm. This replaces ephemeral local sessions with a permanent, searchable record used for real-time monitoring and future knowledge distillation.

## Implementation Steps

### Step 1: Coordinator Database Schema
**Agent**: Coder
**File**: `drone-coordinator/src/db.ts`
*   Create `swarm_sessions` table: `id` (PK), `persona_id`, `beacon_id`, `createdAt`, `updatedAt`, `status`.
*   Create `swarm_events` table: `id` (PK), `sessionId` (FK), `correlationId`, `type` (`USER_TURN`, `LLM_RESPONSE`, `TOOL_CALL`, `TOOL_RESULT`), `payload`, `metadata`, `createdAt`.
*   Initialize FTS5 virtual table for `swarm_events(payload)` to enable global search.

### Step 2: Coordinator Storage Engine
**Agent**: Coder
**File**: `drone-coordinator/src/storage.ts` (New)
*   Implement a simple file-based blob store for large payloads.
*   Function `storeLargePayload(sessionId, eventId, content)`: writes to disk, returns reference string.
*   Function `retrieveLargePayload(ref)`: reads from disk.

### Step 3: Coordinator API Endpoints
**Agent**: Coder
**File**: `drone-coordinator/src/routes.ts`
*   `POST /sync/sessions/register`: Create a new session entry.
*   `POST /sync/events/push`: Accepts an array of `SessionEvent` objects.
    *   Check payload size; if $> 10KB$, use the storage engine and update the payload to a reference.
*   `GET /sessions/:id/events`: List events with optional `correlationId` filter and pagination.
*   `GET /sessions/:id/events/latest`: Return the last $N$ events for a specific session.

### Step 4: Beacon Coordinator Client Updates
**Agent**: Coder
**File**: `drone-beacon/src/coordinator-client.ts`
*   Add `registerSession(sessionId, personaId)` method.
*   Add `pushEvents(events: SessionEvent[])` method.

### Step 5: Agent Swarm Plugin Integration
**Agent**: Coder
**File**: `drone-agent/src/plugins/swarm/index.ts`
*   Update the conversation loop to generate a `correlationId` (UUID) at the start of every new user turn.
*   Implement a "Push-through" mechanism: Every time the `conversation-service` produces a message or a tool result, the swarm plugin immediately calls the beacon's sync endpoint, which forwards it to the coordinator.

### Step 6: Validation & Testing
**Agent**: Tester
*   **Functional Test**: Start an agent, perform a tool-heavy task, and verify that the `swarm_events` table contains a complete, ordered trace with matching `correlationId`s.
*   **Large Payload Test**: Run a tool that returns a massive string and verify it is offloaded to the filesystem and the DB contains the reference.
*   **FTS Test**: Use the coordinator's search endpoint to find a specific string inside a `TOOL_RESULT` payload.
*   **LSP/Lint**: Ensure all new types in `drone-core` are correctly exported and type-checked.

## Validation Criteria
- [ ] `pnpm typecheck` passes across all packages.
- [ ] `pnpm run lint` and LSP are clean.
- [ ] All `drone-coordinator` tests pass.
- [ ] All `drone-beacon` tests pass.
- [ ] Verified that `SESSIONS` $\rightarrow$ `EVENTS` relationship is maintained via Foreign Keys.
- [ ] Verified that events for a single turn share the same `correlationId`.
- [ ] Verified that payloads $> 10KB$ are stored on disk and not in the main SQLite table.