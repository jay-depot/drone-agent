# drone-coordinator

Global hub for drone swarm coordination. The coordinator acts as the central control plane, managing beacons across machines and providing swarm-wide persona and skill definitions.

## Overview

Drone Coordinator is the cross-host control plane for managing beacons in a drone swarm. It provides:

- **Beacon Registry** - Tracks all beacons running across hosts
- **Global State** - SQLite-backed storage for swarm-wide personas, skills, insights, principles, and wiki pages
- **Heartbeat Monitoring** - Monitors beacon health via heartbeats
- **Session Tracking** - Tracks agent sessions across all beacons
- **Cross-Beacon Messaging** - Relays and broadcasts messages between beacons
- **Knowledge Registry** - Global memory and skills knowledge base
- **Swarm Sessions & Events** - FTS5-indexed session event storage
- **Agent Location Registry** - Tracks which beacon each agent is on
- **Central Authority** - Single source of truth for persona/skill definitions
- **Web UI** - Serves the drone-coordinator-ui React app for monitoring and management
- **WebSocket Pub/Sub** - Live updates for connected web UI clients

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run
pnpm start
```

## Command-Line Options

| Option                   | Default                           | Description                    |
| ------------------------ | --------------------------------- | ------------------------------ |
| `--port`                 | 3456                              | Port to listen on              |
| `--host`                 | 0.0.0.0                           | Host to bind to                |
| `--web-port`             | 8080                              | HTTP port for web UI           |
| `--web-host`             | 127.0.0.1                         | Host for web UI port           |
| `--config-dir`           | ~/.drone-coordinator              | Configuration directory        |
| `--config-file`          | -                                 | Load settings from a JSON config file (flags override file values) |
| `--db`                   | <config-dir>/drone-coordinator.db | Path to SQLite database        |
| `--https`                | true                              | Enable HTTPS server (ON unless `--no-https`) |
| `--no-https`             | -                                 | Disable HTTPS server           |
| `--rate-limit-max`       | 100                               | Max requests per IP per window |
| `--rate-limit-window-ms` | 1000                              | Rate limit window in ms        |
| `--help`                 | -                                 | Show help message              |

### Commands

| Command                                        | Description                                            |
| ---------------------------------------------- | ------------------------------------------------------ |
| `drone-coordinator serve`                      | Start the coordinator server (default)                 |
| `drone-coordinator approve-beacon <id>`        | Approve a pending beacon by its ID                     |
| `drone-coordinator list-beacons`               | List all registered beacons and their trust status     |
| `drone-coordinator --show-web-token`           | Print the current web UI access token                  |
| `drone-coordinator --generate-web-token`       | Generate a new web UI access token                     |
| `drone-coordinator --show-fingerprint`         | Print the coordinator's TLS certificate fingerprint    |

## API Endpoints

### Health

- `GET /health` - Health check

### Personas

- `POST /personas` - Create persona (coordinator-scoped)
- `GET /personas` - List all personas
- `GET /personas/:id` - Get persona
- `PUT /personas/:id` - Update persona
- `DELETE /personas/:id` - Delete persona

### Skills

- `POST /skills` - Create skill (coordinator-scoped)
- `GET /skills` - List all skills
- `GET /skills/:id` - Get skill
- `PUT /skills/:id` - Update skill
- `DELETE /skills/:id` - Delete skill

### Beacons

- `POST /beacons` - Register beacon
- `GET /beacons` - List all beacons
- `GET /beacons/:id` - Get beacon info
- `POST /beacons/:id/heartbeat` - Beacon heartbeat
- `DELETE /beacons/:id` - Remove beacon

### Beacon Trust & Approval

- `POST /beacons/trust` - Create trust entry (beacon registration with key)
- `GET /beacons/trust` - List all trust entries
- `GET /beacons/trust/:id` - Get trust entry
- `DELETE /beacons/trust/:id` - Remove trust entry
- `POST /beacons/trust/:id/confirm-fingerprint` - Record that the beacon confirmed the coordinator's TLS fingerprint (TOFU; required before approval)
- `POST /beacons/trust/:id/approve` - Approve a pending beacon by ID
- `POST /beacons/trust/:id/reject` - Reject a pending beacon

### Beacon Sessions

- `POST /beacons/:id/sessions` - Register a new agent session
- `GET /beacons/:id/sessions` - List all sessions for a beacon
- `GET /beacons/:id/sessions/:agentId` - Get specific session
- `DELETE /beacons/:id/sessions/:agentId` - End a session

### Knowledge Registry

- `POST /knowledge` - Create knowledge entry
- `GET /knowledge` - List knowledge entries (query: type)
- `GET /knowledge/:id` - Get knowledge entry
- `PUT /knowledge/:id` - Update knowledge entry
- `DELETE /knowledge/:id` - Delete knowledge entry
- `GET /knowledge/search?q=...` - Search knowledge entries
- `POST /sync/knowledge/push` - Push knowledge from beacon
- `GET /sync/knowledge/pull?type=...` - Pull knowledge to beacon

### Insights

- `POST /insights` - Create insight
- `GET /insights` - List insights (query: targetType, targetId)
- `GET /insights/:id` - Get insight
- `DELETE /insights/:id` - Delete insight

### Principles

- `POST /principles` - Create principle
- `GET /principles` - List principles (query: targetType, targetId)
- `GET /principles/:id` - Get principle
- `DELETE /principles/:id` - Delete principle

### Wiki

- `GET /wiki` - List all wiki pages
- `GET /wiki/:pageId` - Get a specific wiki page (markdown + frontmatter)
- `PUT /wiki/:pageId` - Create or update a wiki page
- `DELETE /wiki/:pageId` - Delete a wiki page
- `GET /wiki/search?q=...` - Search wiki pages
- `GET /wiki/tags` - List wiki tags with page counts
- `GET /wiki/graph` - Connected node/edge graph of the wiki (pages + tags + broken-link placeholders)
- `POST /wiki/lint` - Trigger a lint pass (health-check the wiki)

### Swarm Sessions & Events

- `POST /sync/sessions/register` - Register a swarm session
- `POST /sync/events/push` - Push session events
- `GET /sessions` - List swarm sessions (query: status, exclude, limit, offset)
- `GET /sessions/:id` - Get a session
- `GET /sessions/:id/log` · `GET /sessions/:id/transcript` - Full log / readable transcript
- `GET /sessions/:id/chat` - Trimmed chat transcript feed (keyset `before=<createdAt>:<id>`)
- `POST /sessions/:id/message` - Inject a user turn into a live session (`{ content, steer }`)
- `PATCH /sessions/:id/persona` - Set or clear a session's persona
- `POST /sessions/:id/end` - End a session (guarded; 409 on archived/already-ended)
- `POST /sessions/:id/process` · `POST /sessions/:id/processed` - Session pipeline transitions
- `POST /sessions/:id/archive` - Archive a processed session (processed → archived)
- `POST /sessions/:id/restore` - Restore an archived session (archived → processed)
- `POST /sessions/mark-stale` - Mark idle active sessions stale
- `GET /sessions/:id/events` - List events for a session
- `GET /sessions/:id/events/latest` - Get latest events for a session
- `GET /events/search?q=...` - Search events via FTS5

### Config & Secrets

- `GET /config` - List coordinator config entries (masked)
- `GET /config/distribution` - Beacon-only config distribution payload (secrets resolved)
- `GET/PUT/DELETE /config/:key` - Read/write/delete a config entry (allowlisted keys only)
- `GET /secrets` · `GET/PUT/DELETE /secrets/:name` - Stored secrets (referenced from config as `${secret:NAME}`)

### Prompt Fragments

- `GET /fragments` - List stored prompt fragments
- `PUT /fragments/:id` - Author/update the reserved `swarm-identity` (or other) fragment from the UI
- `DELETE /fragments/:id` - Delete a fragment

### Tools

- `GET /tools/default-hidden` - The default-hidden tool set (persona-gating sync)

### Agent Locations

- `POST /agents/location` - Register agent location
- `GET /agents/location` - List agent locations (query: beaconId)
- `GET /agents/location/:agentId` - Get agent location
- `DELETE /agents/location/:agentId` - Unregister agent location

### Cross-Beacon Messaging

- `POST /messages/relay` - Relay a message to an agent on another beacon
- `POST /messages/broadcast` - Broadcast a message to a channel across all beacons

### Spawn Management

- `POST /spawn` - Spawn an agent on a beacon
- `GET /spawn` - List spawns (query: status)
- `GET /spawn/:spawnId` - Get spawn status
- `DELETE /spawn/:spawnId` - Terminate a spawn

## Architecture

```
┌──────────────────┐     HTTP      ┌──────────────────┐
│  drone-beacon   │──────────────▶│ drone-coordinator │
│  (host A)       │◀─────────────│   (port 3456)    │
└──────────────────┘              └────────┬─────────┘
                                           │
┌──────────────────┐                       │
│  drone-beacon   │───────────────────────┘
│  (host B)       │
└──────────────────┘

Cross-beacon messaging:
Agent A (Beacon 1) → POST /messages/relay → Coordinator → Beacon 2 → Agent B
```

## Beacon Trust & Approval Flow

1. Beacon starts and generates an Ed25519 keypair
2. Beacon sends a trust request to the coordinator with its public key
3. Coordinator stores a pending trust entry keyed by beacon ID. A new beacon starts `pending` unless it registered over a loopback socket or the deployment opted into `autoApproveBeacons`. A re-registration presenting a *different* public key is rejected as a possible spoofing attempt.
4. The beacon confirms the coordinator's own TLS fingerprint (`POST /beacons/trust/:id/confirm-fingerprint`) — the coordinator-side half of the TOFU exchange. A loopback beacon is treated as confirmed at registration.
5. An admin approves the beacon by ID: `drone-coordinator approve-beacon <id>` (the UI's Approve gate stays disabled until the fingerprint is confirmed)
6. Beacon polls for approval status, then connects securely — the mTLS and reverse-channel gates only pass `approved` beacons

## Dependencies

- **fastify** - HTTP server
- **@fastify/static** - Static file serving for web UI
- **@fastify/cors** - CORS support
- **@fastify/rate-limit** - Per-IP rate limiting
- **@fastify/websocket** - WebSocket support
- **better-sqlite3** - SQLite database
- **drone-coordinator-ui** - The React web UI served by the coordinator
- **pino** - Logging
- **drone-core** - Shared core types
- **drone-swarm-common** - Shared TLS and wiki storage utilities
