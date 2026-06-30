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

| Option         | Default                            | Description             |
| -------------- | ---------------------------------- | ----------------------- |
| `--port`       | 3456                               | Port to listen on       |
| `--host`       | 0.0.0.0                            | Host to bind to         |
| `--config-dir` | ./config                           | Configuration directory |
| `--db`         | config/drone-coordinator.db        | Path to SQLite database |
| `--https`      | false (or `COORDINATOR_HTTPS` env) | Enable HTTPS server     |
| `--no-https`   | -                                  | Disable HTTPS server    |

### Commands

| Command                               | Description                                  |
| ------------------------------------- | -------------------------------------------- |
| `drone-coordinator serve`             | Start the coordinator server (default)       |
| `drone-coordinator --approve <token>` | Approve a pending beacon by token            |
| `drone-coordinator list-beacons`      | List all registered beacons and trust status |

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
- `POST /beacons/approve` - Approve a beacon (by token)
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
- `POST /wiki/lint` - Trigger a lint pass (health-check the wiki)

### Swarm Sessions & Events

- `POST /sync/sessions/register` - Register a swarm session
- `POST /sync/events/push` - Push session events
- `GET /sessions/:id/events` - List events for a session
- `GET /sessions/:id/events/latest` - Get latest events for a session
- `GET /events/search?q=...` - Search events via FTS5

### Agent Locations

- `POST /agents/location` - Register agent location
- `GET /agents/location` - List agent locations (query: beaconId)
- `GET /agents/location/:agentId` - Get agent location
- `DELETE /agents/location/:agentId` - Unregister agent location

### Cross-Beacon Messaging

- `POST /messages/relay` - Relay a message to an agent on another beacon
- `POST /messages/broadcast` - Broadcast a message to a channel across all beacons

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
3. Coordinator stores the pending trust entry and returns a token
4. An admin approves the beacon: `drone-coordinator --approve <token>`
5. Beacon polls for approval status, then connects securely

## Dependencies

- **fastify** - HTTP server
- **better-sqlite3** - SQLite database
- **pino** - Logging
- **drone-core** - Shared core types
