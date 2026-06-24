# drone-beacon

Local hub for drone swarm coordination. Each host in the swarm runs a beacon to manage local agent lifecycle and inter-drone communication.

## Overview

Drone Beacon is the host-local coordination layer for drone-agent when the swarm plugin is enabled. It provides:

- **Agent Lifecycle Management** - Spawn, track, and terminate drone-agent processes
- **Local State** - SQLite-backed storage for personas, skills, and memory
- **Coordinator Integration** - Syncs global personas/skills from the coordinator
- **Memory with TTL** - Key-value store with optional time-to-live for inter-agent communication

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
| `--port` | 3457 | Port to listen on |
| `--host` | 0.0.0.0 | Host to bind to |
| `--config-dir` | ./config | Configuration directory |
| `--db` | config/drone-beacon.db | Path to SQLite database |
| `--coordinator-host` | - | Coordinator host to connect to |
| `--coordinator-port` | 3456 | Coordinator port |
| `--id` | auto-generated | Beacon ID |
| `--name` | default-beacon | Beacon name |
| `--spawn-agent-path` | drone-agent | Path to drone-agent binary |
| `--spawn-timeout-ms` | 30000 | Agent connection timeout (ms) |
| `--max-concurrent-spawns` | 10 | Max concurrent spawned agents |

## API Endpoints

### Health
- `GET /health` - Health check

### Personas
- `POST /personas` - Create persona
- `GET /personas` - List all personas
- `GET /personas/:id` - Get persona
- `PUT /personas/:id` - Update persona
- `DELETE /personas/:id` - Delete persona

### Skills
- `POST /skills` - Create skill
- `GET /skills` - List all skills
- `GET /skills/:id` - Get skill
- `PUT /skills/:id` - Update skill
- `DELETE /skills/:id` - Delete skill

### Agent Sessions
- `POST /agents` - Register agent session
- `GET /agents` - List active agents
- `GET /agents/:id` - Get agent info
- `POST /agents/:id/heartbeat` - Agent heartbeat
- `DELETE /agents/:id` - Unregister agent

### Memory
- `POST /memory` - Create memory
- `GET /memory` - List memories (query: namespace, includeExpired)
- `GET /memory/:id` - Get memory by ID
- `GET /memory/key/:key` - Get memory by key (query: namespace)
- `PUT /memory/:id` - Update memory
- `DELETE /memory/:id` - Delete memory

### Spawn Management
- `POST /spawn` - Spawn new agent
- `GET /spawn` - List spawns (query: status)
- `GET /spawn/:spawnId` - Get spawn status
- `DELETE /spawn/:spawnId` - Terminate spawned agent

### Coordinator Sync
- `POST /sync` - Sync personas/skills from coordinator

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  drone-agent    │────▶│   drone-beacon   │
│  (worker)       │◀────│   (port 3457)    │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 │ HTTP
                                 ▼
                        ┌──────────────────┐
                        │ drone-coordinator│
                        │   (port 3456)    │
                        └──────────────────┘
```

## Dependencies

- **fastify** - HTTP server
- **better-sqlite3** - SQLite database
- **pino** - Logging
- **drone-core** - Shared core types