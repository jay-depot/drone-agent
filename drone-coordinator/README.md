# drone-coordinator

Global hub for drone swarm coordination. The coordinator acts as the central control plane, managing beacons across machines and providing swarm-wide persona and skill definitions.

## Overview

Drone Coordinator is the cross-host control plane for managing beacons in a drone swarm. It provides:

- **Beacon Registry** - Tracks all beacons running across hosts
- **Global State** - SQLite-backed storage for swarm-wide personas and skills
- **Heartbeat Monitoring** - Monitors beacon health via heartbeats
- **Session Tracking** - Tracks agent sessions across all beacons
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

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 3456 | Port to listen on |
| `--host` | 0.0.0.0 | Host to bind to |
| `--config-dir` | ./config | Configuration directory |
| `--db` | config/drone-coordinator.db | Path to SQLite database |

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

### Beacon Sessions
- `POST /beacons/:id/sessions` - Register a new agent session
- `GET /beacons/:id/sessions` - List all sessions for a beacon
- `GET /beacons/:id/sessions/:agentId` - Get specific session
- `DELETE /beacons/:id/sessions/:agentId` - End a session

## Architecture

```
┌──────────────────┐     HTTP      ┌──────────────────┐
│  drone-beacon   │──────────────▶│   drone-coordinator│
│  (host A)       │◀─────────────│   (port 3456)    │
└──────────────────┘              └────────┬─────────┘
                                           │
┌──────────────────┐                       │
│  drone-beacon   │───────────────────────┘
│  (host B)       │
└──────────────────┘
```

## Dependencies

- **fastify** - HTTP server
- **better-sqlite3** - SQLite database
- **pino** - Logging
- **drone-core** - Shared core types