---
key: integration-testing-plan
tags:
  - integration-testing
  - completed
created: 2026-06-25T07:39:57.310Z
updated: 2026-06-25T08:12:12.566Z
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

## Implementation Status: ✅ COMPLETED

The following have been implemented:

### ✅ Test Fixtures Library
- `drone-agent/test/fixtures/index.ts` - Main exports
- `drone-agent/test/fixtures/docker.ts` - Container management
- `drone-agent/test/fixtures/swarm.ts` - Swarm utilities
- `drone-agent/test/fixtures/http.ts` - HTTP client utilities
- `drone-agent/test/fixtures/assertions.ts` - Custom assertions

### ✅ Docker Configuration
- `docker/docker-compose.integration-test.yaml` - Full swarm compose
- `docker/dummy-agent/` - Minimal agent for testing
- `docker/test-runner/` - Test orchestrator

### ✅ Test Suites
- `drone-agent/test/agent-beacon.test.ts` - Agent ↔ Beacon tests
- `drone-agent/test/inter-agent.test.ts` - Inter-agent communication
- `drone-agent/test/spawn.test.ts` - Agent spawning
- `drone-agent/test/coordinator-sync.test.ts` - Beacon ↔ Coordinator sync
- `drone-agent/test/e2e-swarm.test.ts` - Full swarm E2E flows

### ✅ CI
- `.github/workflows/integration-test.yml` - GitHub Actions workflow

---

## Running Tests

```bash
# Build all test images
docker compose -f docker/docker-compose.integration-test.yaml build

# Run all integration tests
docker compose -f docker/docker-compose.integration-test.yaml up --abort-on-container-exit

# View results
docker compose -f docker/docker-compose.integration-test.yaml logs test-runner
```

---

_Last updated: 2026-06-25_