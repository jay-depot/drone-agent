---
key: plan-coordinator-ui-launch-interact
tags:
  - plan
  - coordinator
  - ui
  - swarm
  - sessions
  - interactive
created: 2026-09-07T23:45:09.036Z
updated: 2026-09-07T23:46:29.687Z
---

# Plan: Coordinator UI — Launch & Interact with Swarm Agent Sessions

## Feature

Build a UI in the coordinator web app to (1) launch new interactive agent sessions on a beacon and (2) interact with active sessions in real time (a "remote TUI session" tool, not job control). Replaces the existing read-only session-detail page for live sessions; stale/non-live sessions reuse the same design minus the user-input parts.

## Prerequisite (separate plan, same branch)

CWD roots (decision 8 of plan-swarm-remote-spawn-lifecycle) is NOT implemented. This plan ASSUMES the API shape: `GET /api/beacons` returns `spawnRoots: string[]` + `defaultSpawnRoot: string` per beacon. The actual decision-8 implementation is planned next.

## Decisions locked

1. **Interaction model B (synthetic turns), leaning on A's plumbing.**
   - **Model A (message-queue, exists today):** a message to an agent lands in its `pendingMessages` queue; the agent's LLM only sees it if/when the agent itself calls `swarm_message get_messages` on a future turn. The agent is not actively listening — it processes on its own schedule. This is the existing inter-agent messaging path (`/api/messages/relay` → beacon `deliverMessage` → agent WS `message` → `pendingMessages`).
   - **Model B (listen-mode synthetic turns, new):** an incoming message is injected as a synthetic _user turn_ into the agent's conversation loop, so the agent's LLM responds to it immediately (like a chat). This is the "interactive/persistent listen-mode" the remote-spawn plan deferred. We build B but reuse A's plumbing (WS delivery, coordinator relay, beacon sendToAgent).
2. Agent runtime: reuse runJsonListenMode structured output + turn loop; source turns from swarm WS. Spawned interactive agent runs `--output-json` (no `--once`).
3. Synthetic-turn API: extend `_runtime` with `submitUserMessage`/`cancelCurrentRequest`, concurrency-safe (mutex) for multiple plugins.
4. Queue vs steer: hybrid — default queue (enqueueUserMessage), explicit "Stop & Send" (cancelCurrentRequest) via split-button on send control.
5. Launch form: "New Session" button + dropdown panel (preferred) or modal. Fields: Beacon (req), Persona (opt), CWD Root (req, beacon-advertised default). All sessions interactive.
6. Interactivity: `interactive` flag on coordinator swarm_sessions, set at session registration.
7. Message delivery: new coordinator `POST /api/sessions/:id/message` {content, steer?} → beacon deliverUserMessage → agent WS `userMessage` type.
8. CWD roots API shape assumed (see Prerequisite).

## Architecture facts (verified)

- CWD roots NOT implemented — spawner accepts arbitrary workingDir (length-bounded only).
- runJsonListenMode exists in interactive.ts (stdin chat → sendUserMessage → NDJSON + turnComplete).
- Outbound streaming works: agent onConversationEvent → /sync/events/push → coordinator publishMutationEvent → UI WS event → session-detail renders live.
- Inbound does NOT exist: agent WS onmessage only pushes to pendingMessages (poll).
- Synthetic-turn API does NOT exist: conversation service not exposed to plugins. _runtime has emitEvent/resetStuckDetectors/queueSystemReminder but no submitUserMessage/cancelCurrentRequest.
- Queue/steer machinery exists: enqueueUserMessage, cancelCurrentRequest (→CANCEL_SENTINEL), drainPendingMessages (top of each loop iteration).
- _runtime type defined inline in plugin-engine.ts (not drone-core).
- CLI step-0 blocker: parseCliArgs throws on --swarm/--session-id/--beacon-host/--beacon-port (spawner passes them).
- Coordinator is stateless relay (ADR 43); spawn records live on beacon SQLite.
- Session statuses: active/stale/ended/processing/processed/archived.

## Steps

### Phase 1 — CLI step-0 blocker (spawned child must boot)

1. `drone-agent/src/cli.ts`: add `--swarm` (boolean), `--session-id`, `--beacon-host`, `--beacon-port` to CliOptions + parseCliArgs. `--swarm` enables swarm plugin + sets a `swarmSpawned` runtime flag; `--session-id` drives spawning→running registration. `--beacon-host/--beacon-port` are config-defaulted overrides (fall through to swarm config). Do NOT throw on these.
2. `drone-agent/src/index.tsx`: when `--swarm` is set, enable the swarm plugin and set `swarmSpawned` runtime option. Wire `--session-id` into the swarm plugin's sessionId.
3. `drone-agent/src/runtime/plugin-engine.ts`: add `swarmSpawned` to runtimeOptions + `_runtime` (dedicated flag, NOT isSubagent).

### Phase 2 — Synthetic-turn API on `_runtime`

4. `drone-agent/src/runtime/conversation-service.ts`: add a concurrency-safe submit path. Wrap `sendUserMessage`/`enqueueUserMessage`/`cancelCurrentRequest` behind a mutex so multiple plugins can call concurrently. `submitUserMessage(content)`: if a turn is in flight → enqueueUserMessage; else → sendUserMessage. `cancelCurrentRequest()`: soft-cancel (existing).
5. `drone-agent/src/runtime/plugin-engine.ts`: extend `_runtime` with `submitUserMessage(content): Promise<string>` and `cancelCurrentRequest(): void`. Use a mutable ref (like resetStuckDetectorsRef) so the closure reads the conversation service at call time.
6. `drone-agent/src/index.tsx`: wire the conversation service into the `_runtime` ref after creation.

### Phase 3 — Swarm plugin listen-mode wiring

7. `drone-agent/src/plugins/swarm/websocket.ts`: handle a new WS message type `userMessage` (distinct from `message`). On receipt, call `_runtime.submitUserMessage(content)` instead of pushing to pendingMessages.
8. `drone-agent/src/plugins/swarm/index.ts`: when `swarmSpawned` is set, register the swarm session with `interactive: true` (see Phase 4). Ensure the spawned agent runs the listen loop (no `--once`).

### Phase 4 — Coordinator `interactive` flag

9. `drone-coordinator/src/db/init.ts`: add `interactive INTEGER NOT NULL DEFAULT 0` column to `swarm_sessions` (idempotent migration).
10. `drone-coordinator/src/db/swarm-sessions.ts`: add `interactive` to SwarmSession type, createSwarmSession, getSwarmSession, listSwarmSessions, row mapping.
11. `drone-coordinator/src/routes/swarm.ts`: `/sync/sessions/register` accepts `interactive?: boolean`; store it. `/sessions` list returns it.
12. `drone-beacon/src/routes/sync.ts`: `/sync/sessions/register` proxy passes `interactive` through.
13. `drone-beacon/src/coordinator-client.ts`: `registerSwarmSession` accepts + forwards `interactive`.

### Phase 5 — Coordinator message endpoint

14. `drone-coordinator/src/routes/swarm.ts` (or messages.ts): add `POST /api/sessions/:id/message` with `{ content: string, steer?: boolean }`. Look up session → beaconId → sendBeaconCommand('deliverUserMessage', { toAgentId, content, steer }). Return 404 if session/beacon not found, 503 if beacon unavailable.
15. `drone-coordinator/src/beacon-ws.ts`: no change needed (sendBeaconCommand generic). Add `deliverUserMessage` command handling on beacon side.
16. `drone-beacon/src/coordinator-ws.ts`: handle `deliverUserMessage` command → call a new `handleDeliverUserMessage` in message-handlers.ts.
17. `drone-beacon/src/routes/message-handlers.ts`: add `handleDeliverUserMessage({ toAgentId, content, steer })` → wsServer.sendToAgent(toAgentId, { type: 'userMessage', payload: { content, steer } }).

### Phase 6 — UI: launch panel

18. `drone-coordinator-ui/src/lib/types.ts`: add `spawnRoots: string[]` + `defaultSpawnRoot: string` to Beacon type.
19. `drone-coordinator-ui/src/pages/sessions.tsx`: add "New Session" button + dropdown panel (or Dialog fallback). Fields: Beacon (select from connected beacons), Persona (optional select from /api/personas), CWD Root (select from selected beacon's spawnRoots, default = defaultSpawnRoot). On submit → POST /api/spawn { targetBeaconId, personaId, config: { workingDir } }.
20. `drone-coordinator-ui/src/pages/sessions.tsx`: after spawn, navigate to the new session detail page.

### Phase 7 — UI: session detail chat

21. `drone-coordinator-ui/src/pages/session-detail.tsx`: detect live+interactive (status === 'active' && interactive). If live+interactive, render a chat input at the bottom: textarea + Send button + split-button "Stop & Send". On Send → POST /api/sessions/:id/message { content }. On Stop & Send → POST { content, steer: true }.
22. For non-live sessions (stale/ended/processing/processed/archived), render the same event log WITHOUT the input box.
23. `drone-coordinator-ui/src/lib/types.ts`: add `interactive?: boolean` to SwarmSession.

### Phase 8 — Tests + validation

24. Unit tests for: CLI parsing of new flags; _runtime submitUserMessage concurrency (mutex); swarm WS userMessage handling; coordinator /message endpoint; beacon deliverUserMessage; UI launch panel + chat input.
25. LSP must pass; `pnpm -r run lint` and `pnpm -r run build` pass; `pnpm -r run test` (fast suite) passes.

## Validation criteria

- LSP diagnostics clean (typescript connected).
- `pnpm -r run lint` and `pnpm -r run build` pass with zero errors.
- `pnpm -r run test` (fast suite) passes.
- New code covered by unit tests.
- A spawned interactive agent boots (CLI step-0 blocker resolved), registers with interactive:true, and a UI-injected message becomes a turn whose reply streams back to the UI.
- Non-live sessions render read-only (no input box).
