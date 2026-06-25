---
key: integration-testing-plan
tags:
  - integration-testing
  - swarm
  - testing
  - docker
  - planning
created: 2026-06-25T07:39:57.310Z
updated: 2026-06-25T07:39:57.310Z
---

# Swarm Integration Testing Plan

## Overview

Automated integration tests for the drone swarm, leveraging Docker containers for isolation and deterministic testing. Tests focus on **swarm flows** - the interactions between agent, beacon, and coordinator - rather than local functionality (which is already well-covered by dogfooding).

---

## Testing Philosophy

1. **Docker-first**: Tests run in containers for automatic cleanup
2. **Deterministic**: Use the echo LLM provider and dummy plugins
3. **Swarm flows**: Test interactions between components, not internal logic
4. **Reusable fixtures**: Shared utilities across all test suites

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    test-swarm Docker Compose                    │
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌─────────┐  │
│  │echo-llm  │    │coordinator│    │ beacon   │    │ dummy   │  │
│  │(existing)│    │(existing) │    │(existing)│    │agent    │  │
│  └────┬─────┘    └─────┬─────┘    └────┬─────┘    └────┬────┘  │
│       │                │                │               │        │
│       └────────────────┴────────────────┴───────────────┘        │
│                              │                                     │
│                    ┌─────────┴─────────┐                          │
│                    │  test-runner      │                          │
│                    │  (this plan)      │                          │
│                    └───────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Dummy Agent Container

A minimal agent container that:
- Connects to beacon via `swarm` plugin
- Accepts commands via HTTP or file-based trigger
- Reports tool calls, messages, session state for verification
- Uses the `echo` LLM provider

**Purpose**: Replace `drone-agent` container in test compose for controlled testing

### 2. Dummy Tool Plugin

A test plugin that tracks tool invocations:

```typescript
// Usage in tests
const toolTracker = createToolTracker();

// Configure expectations
toolTracker.expectCall('file.read', { path: '/some/path' });
toolTracker.expectNever('git.commit');

// Agent runs...
const calls = toolTracker.getCalls();
expect(calls).toContainMatchingCall('file.read');
```

**Capabilities:**
- `expectCall(tool, matchers)` - Expect at least one call
- `expectNever(tool)` - Expect no calls
- `expectCallCount(tool, count)` - Expect exact count
- `getCalls()` - Retrieve all calls
- `getCallHistory()` - Full call log with timestamps

### 3. Test Fixtures Library

Shared utilities (`test/fixtures/index.ts`):

```typescript
// Container lifecycle
async function startTestEnvironment(): Promise<TestEnvironment>;
async function stopTestEnvironment(env: TestEnvironment): Promise<void>;

// HTTP utilities
async function waitForService(url: string, maxAttempts?: number): Promise<boolean>;
async function request<T>(url: string, options: RequestOptions): Promise<T>;

// Swarm utilities  
async function registerAgent(beaconUrl: string, agentId: string): Promise<void>;
async function createPersona(beaconUrl: string, persona: CreatePersonaRequest): Promise<Persona>;
async function sendMessage(from: string, to: string, body: object): Promise<void>;

// Assertions
expectAgentRegistered(agentId: string): void;
expectPersonaSynced(personaId: string): void;
expectMessageDelivered(messageId: string): void;
```

---

## Test Suites

### Suite 1: Agent ↔ Beacon (`tests/agent-beacon.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `agent-registers` | Agent starts, connects to beacon | Agent appears in `/agents` |
| `agent-fetches-personas` | Agent loads personas from beacon | Beacon returns personas, agent uses them |
| `agent-fetches-skills` | Agent loads skills from beacon | Skills appear in agent's tool list |
| `heartbeat-keeps-alive` | Agent sends heartbeat | `/agents/:id` shows recent activity |
| `agent-cleanup` | Agent shuts down cleanly | Agent removed from `/agents` |

### Suite 2: Inter-Agent Communication (`tests/inter-agent.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `send-message-to-agent` | Agent A sends message to Agent B | Recipient sees message in `/messages` |
| `channel-message` | Agent posts to channel | All agents in channel receive |
| `websocket-delivery` | Message delivered via WebSocket | Real-time delivery confirmed |
| `message-delivery-status` | Read receipts work | `/messages/:id` shows delivered |

### Suite 3: Agent Spawning (`tests/spawn.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `spawn-agent-via-api` | POST `/spawn` spawns agent | New agent registers |
| `spawn-with-persona` | Spawn with specific persona | Agent has correct persona |
| `spawn-task-execution` | Agent receives task prompt | Agent's first message is task |
| `terminate-spawn` | DELETE `/spawn/:id` stops agent | Agent disconnects, process ends |

### Suite 4: Beacon ↔ Coordinator Sync (`tests/coordinator-sync.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `persona-push-to-coordinator` | Beacon pushes persona | Coordinator has the persona |
| `skill-push-to-coordinator` | Beacon pushes skill | Coordinator has the skill |
| `sync-pull-from-coordinator` | Beacon pulls assets | New assets appear in beacon |
| `bi-directional-sync` | Create in beacon, verify in coordinator | Assets in both places |

### Suite 5: Full Swarm Flows (`tests/e2e-swarm.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `full-agent-lifecycle` | Start → connect → work → disconnect | All state transitions work |
| `multi-agent-coordination` | Two agents, message exchange | Both participate in swarm |
| `swarm-memory-across-agents` | Agent A stores, Agent B retrieves | Memory is shared |
| `persona-propagation` | Create persona, agents see it | All connected agents have it |

---

## Docker Compose Configuration

### `docker/docker-compose.integration-test.yaml`

```yaml
services:
  # Echo LLM - deterministic responses
  echo-llm:
    build:
      context: ..
      dockerfile: docker/echo-llm.Dockerfile
    ports:
      - "3458:3458"
    networks:
      - test-swarm

  # Coordinator
  drone-coordinator:
    build:
      context: ..
      dockerfile: docker/drone-coordinator.Dockerfile
    ports:
      - "3456:3456"
    environment:
      - DB_PATH=/data/coordinator.db
    networks:
      - test-swarm

  # Beacon
  drone-beacon:
    build:
      context: ..
      dockerfile: docker/drone-beacon.Dockerfile
    ports:
      - "3457:3457"
    environment:
      - COORDINATOR_HOST=drone-coordinator
      - COORDINATOR_PORT=3456
      - DB_PATH=/data/beacon.db
    networks:
      - test-swarm
    depends_on:
      - drone-coordinator

  # Dummy Agent - controlled testing agent
  dummy-agent:
    build:
      context: ..
      dockerfile: docker/dummy-agent.Dockerfile
    environment:
      - BEACON_HOST=drone-beacon
      - BEACON_PORT=3457
      - LLM_ECHO_URL=http://echo-llm:3458
    networks:
      - test-swarm
    depends_on:
      - drone-beacon

  # Test Runner
  test-runner:
    build:
      context: ..
      dockerfile: docker/test-runner.Dockerfile
    environment:
      - COORDINATOR_URL=http://drone-coordinator:3456
      - BEACON_URL=http://drone-beacon:3457
      - AGENT_URL=http://dummy-agent:3459
      - ECHO_LLM_URL=http://echo-llm:3458
    networks:
      - test-swarm
    depends_on:
      - drone-beacon
    volumes:
      - ./test-results:/results

networks:
  test-swarm:
    driver: bridge
```

---

## File Structure

```
drone-agent/
├── test/
│   ├── fixtures/
│   │   ├── index.ts           # Main exports
│   │   ├── docker.ts          # Container management
│   │   ├── swarm.ts           # Swarm utilities
│   │   └── assertions.ts      # Custom assertions
│   ├── agent-beacon.test.ts
│   ├── inter-agent.test.ts
│   ├── spawn.test.ts
│   ├── coordinator-sync.test.ts
│   └── e2e-swarm.test.ts
│
├── docker/
│   ├── dummy-agent.Dockerfile
│   ├── dummy-agent/
│   │   ├── src/
│   │   │   └── index.ts       # Minimal agent for testing
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── test-runner.Dockerfile
│   ├── test-runner/
│   │   ├── src/
│   │   │   └── index.ts       # Test orchestrator
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── docker-compose.integration-test.yaml
│
drone-beacon/
└── test/
    └── api.test.ts            # Beacon API tests (no docker needed - real HTTP)

drone-coordinator/
└── test/
    └── api.test.ts            # Coordinator API tests (no docker needed)
```

---

## Running Tests

### Full Integration Suite

```bash
# Build all test images
docker compose -f docker/docker-compose.integration-test.yaml build

# Run all integration tests
docker compose -f docker/docker-compose.integration-test.yaml up --abort-on-container-exit

# View results
docker compose -f docker/docker-compose.integration-test.yaml logs test-runner
```

### Individual Suites

```bash
# Run specific test file inside container
docker compose -f docker/docker-compose.integration-test.yaml exec test-runner pnpm test agent-beacon

# Run with vitest filtering
docker compose -f docker/docker-compose.integration-test.yaml exec test-runner pnpm test -- --grep "agent-registers"
```

### Local Development (without Docker)

```bash
# Start services manually
docker compose -f docker/docker-compose.integration-test.yaml up -d echo-llm drone-coordinator drone-beacon

# Run tests against local services
COORDINATOR_URL=http://localhost:3456 BEACON_URL=http://localhost:3457 pnpm test
```

---

## CI Integration

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build images
        run: docker compose -f docker/docker-compose.integration-test.yaml build
      
      - name: Run tests
        run: docker compose -f docker/docker-compose.integration-test.yaml up --abort-on-container-exit
      
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/
```

---

## Implementation Priority

| Priority | Item | Effort |
|----------|------|--------|
| 1 | `test/fixtures/` utilities | Medium |
| 2 | `dummy-agent` Docker build | Medium |
| 3 | `docker-compose.integration-test.yaml` | Low |
| 4 | `tests/agent-beacon.test.ts` | Low |
| 5 | `tests/inter-agent.test.ts` | Medium |
| 6 | `tests/spawn.test.ts` | Medium |
| 7 | `tests/coordinator-sync.test.ts` | Medium |
| 8 | `tests/e2e-swarm.test.ts` | High |
| 9 | CI workflow | Low |

---

## Principles

1. **Isolation**: Each test is independent; tests can run in any order
2. **Determinism**: Use echo LLM and mock data; no flaky external dependencies
3. **Cleanup**: Docker handles cleanup; tests don't leave state
4. **Fast feedback**: Smoke tests run first; long tests run last
5. **Debuggability**: Include verbose logging; expose test state on failure

---

_Last updated: 2026-06-25_