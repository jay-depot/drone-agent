---
tags:
  [
    coordinator,
    coordinator-ui,
    swarm,
    sessions,
    interactive,
    listen-mode,
    synthetic-turns,
    adr,
  ]
related:
  [
    drone-agent.md,
    drone-beacon.md,
    drone-coordinator.md,
    drone-coordinator-ui.md,
    drone-swarm-common.md,
    concepts/json-listen-mode.md,
    concepts/session-processing-pipeline.md,
    decisions/197-beacon-cwd-roots.md,
  ]
---

# Coordinator UI session launch + interactive remote chat

**Summary**: Implements the completed plan `plan-coordinator-ui-launch-interact` — a coordinator-UI launch panel for spawning interactive ("remote TUI") agent sessions on a beacon, plus real-time chat with live sessions. Inbound turn injection (the previously missing half of the streaming path) is built on a new concurrency-safe synthetic-turn API in the conversation service, a new swarm WS `userMessage` message type, an `interactive` flag on coordinator swarm sessions, and a coordinator `POST /api/sessions/:id/message` endpoint that reaches the agent over the beacon reverse channel. All UI-launched sessions are purely interactive — this is a "remote TUI session" tool, not job control.

## Context

The coordinator UI could monitor swarm sessions (live event stream, archive/restore, topology dots) but could not launch one or talk to one. Two halves were needed:

- **Outbound** (existed): agent `onConversationEvent` → `/sync/events/push` → coordinator `publishMutationEvent` → UI WS `event` → session-detail page. Live streaming already worked.
- **Inbound** (missing): the agent's swarm WS `onmessage` only pushed messages into `pendingMessages` for the agent to poll via `swarm_message get_messages` on its own schedule — no path injected a turn into the conversation loop.

Four gaps blocked the plan's interaction model B (listen-mode synthetic turns):

1. **CLI step-0 blocker** — the beacon spawner passes `--swarm --session-id <id> --beacon-host <h> --beacon-port <p>` (+ `--task`, `--working-dir`), but `parseCliArgs` threw "Unknown option" on all of them. A spawned child could never boot.
2. **No synthetic-turn API** — the conversation service (`enqueueUserMessage`, `cancelCurrentRequest`, `drainPendingMessages`) had the queue/steer machinery, but nothing exposed it to plugins; `_runtime` had `emitEvent`/`resetStuckDetectors`/`queueSystemReminder` but no `submitUserMessage`.
3. **No inbound WS message type** — the swarm plugin's `websocket.ts` handled `message`/`fragment`/`fragmentSync`/`ack`/`error` only.
4. **No session interactivity marker** — the coordinator's `swarm_sessions` table had no way to record that a session accepts user turns.

The prerequisite (beacon-advertised `spawnRoots` + `defaultSpawnRoot` on `GET /api/beacons`) landed as [197-beacon-cwd-roots](197-beacon-cwd-roots.md).

## Decision

### Interaction model B (synthetic turns), reusing model A's plumbing

Model A (message-queue, existing): a message lands in the agent's `pendingMessages`; the LLM only sees it if the agent polls on a future turn. Model B (listen-mode, new): the message is injected as a synthetic **user turn** so the agent's LLM responds immediately, like a chat. Model B is what was built — but delivered over model A's existing transport (swarm WS + coordinator relay + beacon reverse channel). The spawned interactive agent runs `--output-json` (no `--once`), keeping the process alive as a persistent listen-mode host.

### CLI step-0 blocker resolved

`--swarm` (boolean), `--session-id`, `--beacon-host`, `--beacon-port` added to `CliOptions` + `parseCliArgs`; `--task`/`--working-dir` parsed too (the spawner passes them — same throw class; `--task` is _not_ yet wired as a first turn, deferred). `--swarm` force-enables the swarm plugin (mirroring `--plugin` override semantics) and sets a dedicated `swarmSpawned` runtime flag on `_runtime` (deliberately **not** `isSubagent`). `--beacon-host`/`--beacon-port`/`--session-id` are config-defaulted overrides threaded into `createSwarmPlugin` via a new `swarmConfig` dep on `createBuiltInPlugins`.

The shared spawner (`drone-swarm-common/src/spawner.ts`) now appends `--output-json` to the spawn argv, so every beacon-spawned agent runs in interactive listen-mode.

### Concurrency-safe synthetic-turn API on the conversation service

`ConversationService.submitUserMessage(content): Promise<string>` — serialized through a promise-chain mutex so multiple plugins can call concurrently without interleaving queue-vs-send decisions:

- **Turn in flight** → `enqueueUserMessage(content)`; returns `''` (the queued message is drained at the top of the current loop iteration or the next `sendUserMessage` call).
- **No turn in flight** → `sendUserMessage(content)`; resolves with the final assistant reply.

Plus `isTurnInFlight(): boolean`. En-route: the returned object literal needed a named self-reference (`const service: ConversationService = { … }; return service;`) so `submitUserMessage` can call `sendUserMessage`.

`_runtime` gains `submitUserMessage`/`cancelCurrentRequest`, wired through **mutable host refs** (`submitUserMessageRef`/`cancelCurrentRequestRef` in `index.tsx`) read at call time — the same pattern as `resetStuckDetectorsRef` — because the conversation service is created after the engine.

### Swarm WS `userMessage` message type

A new WS message type distinct from inter-agent `message`: `{ type: 'userMessage', payload: { content, steer? } }`. The swarm plugin handler calls `_runtime.submitUserMessage(content)`; when `steer === true` ("Stop & Send"), `_runtime.cancelCurrentRequest()` fires first to soft-cancel the in-flight turn (the next loop iteration sees the cancel sentinel, then drains the queue). The spawned agent runs `runSwarmListenMode` (`interactive.ts`): a global conversation-event listener streams NDJSON (assistantMessage/reasoning/toolCall/toolResult/error, `roundComplete` → `turnComplete`) so the beacon/coordinator can observe the turn stream; the keepalive promise resolves on SIGTERM/SIGINT (matching `terminateAgent`'s SIGTERM) so `main()` proceeds to `onShutdown` and exits cleanly.

### `interactive` flag on coordinator swarm sessions

`swarm_sessions.interactive INTEGER NOT NULL DEFAULT 0` (idempotent migration) + `SwarmSession.interactive` threaded through create/get/list/stale row mappings. The swarm plugin's `registerSwarmSession` forwards `interactive` (true when `swarmSpawned`) via the beacon's `/sync/sessions/register` proxy and the coordinator client — set at session registration, not derived later.

### Coordinator message endpoint

`POST /api/sessions/:id/message` with `{ content: string, steer?: boolean }`: 400 on missing/empty content; 404 if session not found; 503 `BEACON_NOT_FOUND`/`BEACON_UNAVAILABLE`; on success sends `deliverUserMessage` down the beacon's reverse channel. Beacon side: `handleDeliverUserMessage({ toAgentId, content, steer })` (400 validation, 404 `AGENT_NOT_CONNECTED`, send via `wsServer.sendToAgent` as a `userMessage` WS message) dispatched as a new `deliverUserMessage` case in the beacon's reverse-channel command handler (`coordinator-ws.ts`) — mirroring the existing `deliverMessage` shape.

### UI: launch panel + session chat

- **Sessions page** — a "New Session" toggle button opens a dropdown launch panel: Beacon (required, connected beacons only), Persona (optional, from `/api/personas`), CWD Root (required, from the selected beacon's advertised `spawnRoots`, seeded with its `defaultSpawnRoot`). Submit → `POST /api/spawn { targetBeaconId, personaId?, config: { workingDir } }` → navigate to the new session's detail page. (A native `<select>` panel, not a modal — no select component exists in the UI kit.)
- **Session detail** — the page fetches session metadata; when `status === 'active' && interactive === true` it renders a chat input: textarea + **Send** (default queue-or-send) and **Stop & Send** (steer) buttons. Enter submits; Shift+Enter is a newline. Non-live sessions (stale/ended/processing/processed/archived) render the same event log read-only. The header badge shows "● Live — Interactive" for live interactive sessions, otherwise the actual status.

## Implementation

- `drone-agent/src/cli.ts` — new `CliOptions` fields + parse branches + `DRONE_SESSION_ID` env fallback.
- `drone-agent/src/index.tsx` — `--swarm` plugin enable, `swarmSpawned` runtime option, submit/cancel refs wired to the conversation service, swarm dispatch → `runSwarmListenMode`.
- `drone-agent/src/runtime/conversation-service.ts` — `submitUserMessage` + `isTurnInFlight` + `turnInFlight` flag (set/cleared in `sendUserMessage`'s try/finally) + `submitChain` mutex; `const service` self-reference.
- `drone-agent/src/runtime/plugin-engine.ts` — `swarmSpawned` runtime option + `_runtime` field; `submitUserMessage`/`cancelCurrentRequest` engine options → `_runtime` closure.
- `drone-agent/src/plugins/index.ts` — `swarmConfig` dep threaded into `createSwarmPlugin`.
- `drone-agent/src/plugins/swarm/websocket.ts` — `userMessage` handler.
- `drone-agent/src/plugins/swarm/hooks.ts` + `index.ts` — `registerSwarmSession(ctx, interactive)`.
- `drone-agent/src/interactive.ts` — `runSwarmListenMode`.
- `drone-swarm-common/src/spawner.ts` — `--output-json` in spawn argv.
- `drone-beacon/src/routes/message-handlers.ts` — `handleDeliverUserMessage`.
- `drone-beacon/src/coordinator-ws.ts` — `deliverUserMessage` command case.
- `drone-beacon/src/routes/sync.ts` + `coordinator-client.ts` — `interactive` passthrough.
- `drone-coordinator/src/db/init.ts` + `swarm-sessions.ts` — `interactive` column + mapping.
- `drone-coordinator/src/routes/swarm.ts` — `POST /sessions/:id/message` + `interactive` on register.
- `drone-coordinator-ui/src/lib/types.ts` — `spawnRoots`/`defaultSpawnRoot` on `Beacon`, `interactive?` on `SwarmSession`.
- `drone-coordinator-ui/src/pages/sessions.tsx` — `NewSessionPanel`.
- `drone-coordinator-ui/src/pages/session-detail.tsx` — chat input + status badge.

## Tests

- `drone-agent/test/cli-swarm-flags.test.ts` (new, 9) — parses all spawner flags, boolean `--swarm`, port validation (non-numeric/negative rejected), `DRONE_SESSION_ID` env fallback, and a full-spawner-argv step-0 regression.
- `drone-agent/test/submit-user-message.test.ts` (new, 4) — immediate send returns the reply; queue-while-in-flight returns `''` and drains next turn; concurrent submissions serialize (both get real replies, never interleaved); a failing submission doesn't poison the chain.
- `drone-coordinator/test/beacon-ws.test.ts` — fixed the pre-existing LSP error (fake ws lacked a `handlers` prop).
- `drone-coordinator/test/transcript.test.ts` — fixture gains `interactive: false`.

Validation: LSP clean, `pnpm typecheck`, `pnpm -r run build`, `pnpm lint` (eslint + prettier), fast suite 2805 passed / 14 skipped.

## Key Points

- **Inbound path completes the loop** — outbound event streaming existed; turn injection (queue-or-steer) is the new half, delivered over the same transports.
- **Queue vs steer is explicit** — default Send queues behind an in-flight turn; Stop & Send soft-cancels first. Both are one endpoint flag (`steer`).
- **Concurrency-safe by construction** — the promise-chain mutex makes the queue-vs-send decision atomic across plugins; a failed submission never blocks subsequent ones.
- **`swarmSpawned` ≠ `isSubagent`** — a dedicated runtime flag; session registration (`interactive: true`) keys off it.
- **All UI-launched sessions are interactive** — job control (fire-and-forget task runs) is a separate future pass.
- **Plan gaps found en route** — the spawner also passes `--task`/`--working-dir` (plan listed only four flags), and `runJsonListenMode` is stdin-driven so a WS-sourced `runSwarmListenMode` was needed instead of reuse.

## Related

- `plan-coordinator-ui-launch-interact` — the completed plan (project memory) this ADR ingests
- [197-beacon-cwd-roots](197-beacon-cwd-roots.md) — the spawnRoots prerequisite this UI consumes
- [012-agent-spawn](012-agent-spawn.md) — beacon agent spawn
- [190-coordinator-session-archive](190-coordinator-session-archive.md) — session statuses the detail page gates on
- json-listen-mode — the NDJSON protocol this listen-mode streams
- session-processing-pipeline — session lifecycle (`active` gates the chat input)
- [drone-agent](../../drone-agent/) · [drone-beacon](../../drone-beacon/) · [drone-coordinator](../../drone-coordinator/) · [drone-coordinator-ui](../../drone-coordinator-ui/) — the four modules touched
