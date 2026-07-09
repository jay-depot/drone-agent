# drone-beacon

Local hub for drone swarm coordination. Each host in the swarm runs a beacon to manage local agent lifecycle and inter-drone communication.

## Overview

Drone Beacon is the host-local coordination layer for drone-agent when the swarm plugin is enabled. It provides:

- **Agent Lifecycle Management** - Spawn, track, and terminate drone-agent processes
- **Local State** - SQLite-backed storage for personas, skills, and memory
- **Coordinator Integration** - Syncs global personas/skills from the coordinator
- **Memory with TTL** - Key-value store with optional time-to-live for inter-agent communication
- **WebSocket Support** - Real-time communication with connected agents
- **Message Passing** - Agent-to-agent and channel-based messaging
- **Self-Improvement** - Beacon-scoped insights and principles tables
- **Knowledge Base** - LLM Wiki-style markdown pages on the beacon filesystem

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

| Option                    | Default                | Description                                      |
| ------------------------- | ---------------------- | ------------------------------------------------ |
| `--port`                  | 3457                   | Port to listen on                                |
| `--host`                  | 0.0.0.0                | Host to bind to                                  |
| `--config-dir`            | ~/.drone-beacon        | Configuration directory                          |
| `--db`                    | <config-dir>/drone-beacon.db | Path to SQLite database                    |
| `--coordinator-host`      | -                      | Coordinator host to connect to                   |
| `--coordinator-port`      | 3458                   | Coordinator port (defaults to beacon port + 1)   |
| `--coordinator-https`     | false                  | Use HTTPS for coordinator connection             |
| `--https`                 | false                  | Enable HTTPS server (or set BEACON_HTTPS env)   |
| `--no-https`              | -                      | Disable HTTPS server (default)                   |
| `--id`                    | auto-generated         | Beacon ID                                        |
| `--name`                  | default-beacon         | Beacon name                                      |
| `--spawn-agent-path`      | drone-agent            | Path to drone-agent binary                       |
| `--spawn-timeout-ms`      | 30000                  | Agent connection timeout (ms)                    |
| `--max-concurrent-spawns` | 10                     | Max concurrent spawned agents                    |
| `--sync-interval-minutes` | 5                      | Interval for periodic coordinator sync (minutes) |
| `--help`                  | -                      | Show help message                                |

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

### Messages

- `POST /messages` - Send a message (REST)
- `GET /messages` - List messages for an agent (query: agentId, unreadOnly)
- `GET /messages/:id` - Get single message
- `POST /messages/:id/read` - Mark message as read
- `GET /messages/channel/:channel` - List messages in a channel

### Spawn Management

- `POST /spawn` - Spawn new agent
- `GET /spawn` - List spawns (query: status)
- `GET /spawn/:spawnId` - Get spawn status
- `DELETE /spawn/:spawnId` - Terminate spawned agent

### Coordinator Sync

- `POST /sync` - Sync personas/skills from coordinator

### Config

- `GET /config` - List all config overrides
- `GET /config/:key` - Get specific config value
- `POST /config` - Set a config override
- `PUT /config/:key` - Update config override
- `DELETE /config/:key` - Remove config override

### Event Logs

- `GET /events` - List event logs (query: agentId, eventType, since, limit)
- `GET /events/:id` - Get specific event log

### Insights

- `POST /insights` - Create insight (query: ?scope=coordinator to proxy to coordinator)
- `GET /insights` - List insights (query: targetType, targetId, scope)
- `GET /insights/:id` - Get insight
- `DELETE /insights/:id` - Delete insight

### Principles

- `POST /principles` - Create principle (query: ?scope=coordinator to proxy to coordinator)
- `GET /principles` - List principles (query: targetType, targetId, scope)
- `GET /principles/:id` - Get principle
- `DELETE /principles/:id` - Delete principle

### Wiki

- `GET /wiki` - List all wiki pages (beacon + coordinator, scope-tagged)
- `GET /wiki/:pageId` - Get a specific wiki page (markdown + frontmatter)
- `PUT /wiki/:pageId` - Create or update a wiki page (query: ?scope=coordinator to proxy)
- `DELETE /wiki/:pageId` - Delete a wiki page (query: ?scope=coordinator to proxy)
- `GET /wiki/search?q=...` - Search wiki pages
- `POST /wiki/lint` - Trigger a lint pass (health-check the wiki)

### WebSocket

Agents can connect via WebSocket for real-time communication. The WebSocket endpoint is at `/ws`:

```
ws://<host>:<port>/ws
```

Upon connection, agents should send a registration message:

```json
{
  "type": "register",
  "agentId": "agent-xxx",
  "personaId": "optional-persona-id"
}
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  drone-agent    │────▶│   drone-beacon   │
│  (worker)       │◀────│   (port 3457)    │
└────────┬────────┘     └────────┬─────────┘
         │ WebSocket              │
         └────────────────────────┼─────────┘
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
- **@fastify/websocket** - WebSocket support
- **better-sqlite3** - SQLite database
- **pino** - Logging
- **drone-core** - Shared core types
- **drone-swarm-common** - Shared TLS and wiki storage utilities
