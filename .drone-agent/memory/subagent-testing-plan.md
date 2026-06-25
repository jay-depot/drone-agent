---
key: subagent-testing-plan
tags:
  - subagent
  - testing
  - integration
  - planning
created: 2026-06-25T07:44:34.395Z
updated: 2026-06-25T07:44:34.395Z
---

# Subagent Integration Testing Plan

## Overview

Automated integration tests for the subagent dispatch system. Tests focus on the interaction between the main agent and spawned subagents, including dispatch, communication, timeout handling, and parallel execution.

---

## How Subagents Work

### Main Agent Mode
- Provides `subagent.dispatch` tool
- Spawns child `drone-agent` process with `--subagent-id`, `--output-json`, `--once` flags
- Writes task via stdin (NDJSON kickoff event)
- Collects stdout, parses NDJSON for return event
- Resolves/rejects based on exit code and return event

### Subagent Mode
- Runs with `--subagent-id` and `--once` flags
- Has `subagent.return` tool available
- Has prompt fragment instructing it to use return tool
- Outputs NDJSON return event on completion
- Exits with code 0

### Environment Variables
- `DRONE_SUBAGENT_ID` - Unique subagent identifier
- `DRONE_PERSONA` - Optional persona override

---

## Test Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Test Environment                            │
│                                                                  │
│  ┌─────────────────┐         ┌─────────────────┐               │
│  │  Main Agent     │──stdin──▶│  Subagent       │              │
│  │  (parent)      │◀─stdout─ │  (child)        │              │
│  │                 │         │  (echo LLM)     │              │
│  └────────┬────────┘         └─────────────────┘               │
│           │                                                    │
│           │ HTTP                                               │
│           ▼                                                    │
│  ┌─────────────────┐                                         │
│  │  Beacon         │  (optional, for swarm-advanced tests)    │
│  │  (optional)     │                                         │
│  └─────────────────┘                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Test Fixtures

### `test/fixtures/subagent.ts`

```typescript
/**
 * Launch a subagent and capture its output.
 * Uses echo LLM for deterministic responses.
 */
async function launchSubagent(options: {
  task: string;
  persona?: string;
  timeout?: number;
}): Promise<SubagentResult>

/**
 * Run multiple subagents in parallel and collect all results.
 */
async function launchParallelSubagents(count: number, options: {
  taskFactory: (index: number) => string;
  persona?: string;
  timeout?: number;
}): Promise<SubagentResult[]>

/**
 * Create a subagent that always times out.
 */
async function launchTimeoutSubagent(timeoutMs: number): Promise<SubagentResult>

/**
 * Create a subagent that errors.
 */
async function launchErrorSubagent(errorType: 'crash' | 'exception' | 'no-return'): Promise<SubagentResult>
```

### `test/fixtures/docker-subagent.ts`

```typescript
/**
 * Launch subagent in Docker container (for isolated testing).
 */
async function launchDockerSubagent(containerName: string, options: {
  task: string;
  image?: string;
}): Promise<SubagentResult>

/**
 * Run subagent tests in Docker with resource limits.
 */
async function withResourceLimits(limits: {
  memory?: string;
  cpu?: number;
}, fn: () => Promise<void>): Promise<void>
```

---

## Test Suites

### Suite 1: Basic Dispatch (`tests/subagent/dispatch.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `dispatch-basic` | Simple task dispatch | Subagent runs, returns result |
| `dispatch-with-persona` | Dispatch with persona | Subagent uses specified persona |
| `dispatch-output-json` | JSON output format | Valid NDJSON in stdout |
| `dispatch-once-exit` | --once flag causes exit | Process exits after task |

### Suite 2: Communication (`tests/subagent/communication.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `stdin-task-passing` | Task written to stdin | Subagent receives task |
| `return-tool-result` | Return tool sends result | Result captured by parent |
| `return-tool-error` | Return tool with error | Error captured by parent |
| `multi-line-result` | Return with newlines | Newlines preserved |

### Suite 3: Lifecycle (`tests/subagent/lifecycle.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `normal-completion` | Subagent completes normally | Exit code 0, result returned |
| `timeout-completion` | Subagent times out | Exit code not 0, timeout error |
| `forced-termination` | Parent kills subagent | Process killed, cleanup done |
| `crash-handling` | Subagent crashes | Error propagated to parent |

### Suite 4: Parallel Execution (`tests/subagent/parallel.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `parallel-basic` | Multiple subagents run | All complete, results returned |
| `parallel-isolation` | Subagents don't interfere | Each gets correct task |
| `parallel-timing` | Subagents run concurrently | Total time < sum of individual |
| `parallel-limit` | Max concurrent subagents | Queue/limit respected |

### Suite 5: Error Handling (`tests/subagent/errors.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `missing-executable` | drone-agent not found | Clear error message |
| `invalid-persona` | Unknown persona | Error or fallback behavior |
| `no-return-tool-call` | Subagent doesn't call return | Timeout or error |
| `double-return` | Subagent calls return twice | First result used |

### Suite 6: Integration with Swarm (`tests/subagent/swarm.test.ts`)

| Test | Description | Pass Criteria |
|------|-------------|---------------|
| `subagent-in-swarm` | Subagent connects to beacon | Registered in beacon |
| `subagent-shares-personas` | Access beacon personas | Personas available |
| `subagent-shares-memory` | Access beacon memory | Can read/write memory |

---

## Docker Configuration

### `docker/docker-compose.subagent-test.yaml`

```yaml
services:
  echo-llm:
    build:
      context: ../..
      dockerfile: docker/echo-llm.Dockerfile
    ports:
      - "3458:3458"
    networks:
      - subagent-test

  # Parent agent that will dispatch subagents
  drone-agent:
    build:
      context: ../..
      dockerfile: docker/drone-agent.Dockerfile
    environment:
      - LLM_PROVIDER=echo
      - LLM_ECHO_URL=http://echo-llm:3458
      - DRONE_CONFIG_DIR=/config
    networks:
      - subagent-test
    volumes:
      - agent-binaries:/drone-agent

  # Test runner
  subagent-test-runner:
    build:
      context: ../..
      dockerfile: docker/subagent-test-runner.Dockerfile
    environment:
      - ECHO_LLM_URL=http://echo-llm:3458
      - AGENT_PATH=/drone-agent/bin/drone-agent
    networks:
      - subagent-test
    volumes:
      - agent-binaries:/drone-agent
      - ./test-results:/results
    depends_on:
      - drone-agent

volumes:
  agent-binaries:

networks:
  subagent-test:
    driver: bridge
```

---

## File Structure

```
drone-agent/
├── test/
│   ├── fixtures/
│   │   ├── subagent.ts           # Subagent launch utilities
│   │   ├── docker-subagent.ts   # Docker-specific utilities
│   │   └── index.ts             # Re-exports
│   │
│   ├── subagent/
│   │   ├── dispatch.test.ts     # Basic dispatch tests
│   │   ├── communication.test.ts # stdin/stdout communication
│   │   ├── lifecycle.test.ts   # Completion, timeout, crash
│   │   ├── parallel.test.ts    # Concurrent execution
│   │   ├── errors.test.ts      # Error cases
│   │   └── swarm.test.ts       # Swarm integration
│   │
│   └── helpers.ts              # Existing test helpers
│
├── docker/
│   ├── subagent-test-runner/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   │
│   └── docker-compose.subagent-test.yaml
```

---

## Running Tests

### Full Subagent Test Suite

```bash
docker compose -f docker/docker-compose.subagent-test.yaml up --build --abort-on-container-exit
```

### Individual Suite

```bash
docker compose -f docker/docker-compose.subagent-test.yaml run subagent-test-runner pnpm test subagent/dispatch
```

### Local Development (no Docker)

```bash
# Start echo LLM
docker run -p 3458:3458 drone-agent-echo-llm

# Run tests
LLM_ECHO_URL=http://localhost:3458 pnpm test subagent
```

---

## Key Testing Patterns

### 1. Echo LLM for Determinism
- Subagent uses echo provider: `LLM_PROVIDER=echo`
- Response is predictable: echoes the prompt
- Easy to assert on output

### 2. Capture NDJSON Output
```typescript
// Parse stdout for NDJSON events
const events = stdout.split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

const returnEvent = events.find(e => e.kind === 'return');
expect(returnEvent.result).toBeDefined();
```

### 3. Isolated Workspaces
- Each subagent gets its own temp directory
- No file system interference between tests

### 4. Resource Limits for Timeout Tests
```typescript
// Test timeout with Docker memory limits
await withResourceLimits({ memory: '64m' }, async () => {
  // This subagent will hit memory limit
});
```

---

## Implementation Priority

| Priority | Item | Effort |
|----------|------|--------|
| 1 | `test/fixtures/subagent.ts` | Medium |
| 2 | `dispatch.test.ts` | Low |
| 3 | `communication.test.ts` | Low |
| 4 | `lifecycle.test.ts` | Medium |
| 5 | `parallel.test.ts` | Medium |
| 6 | `errors.test.ts` | Medium |
| 7 | `swarm.test.ts` | High |
| 8 | Docker setup | Medium |

---

## Principles

1. **Isolation**: Each subagent runs in its own process; tests don't interfere
2. **Determinism**: Use echo LLM; responses are predictable
3. **Complete coverage**: Test happy paths, timeouts, crashes, parallel execution
4. **Clear assertions**: Verify exact output format, exit codes, error messages
5. **Fast feedback**: Tests run in seconds, not minutes

---

## Notes

- Subagent tests are simpler than full swarm tests because they don't require multiple containers
- The main complexity is ensuring the parent can spawn the child drone-agent (path resolution)
- For CI, might need to volume-mount the built drone-agent binary

---

_Last updated: 2026-06-25_