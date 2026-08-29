---
key: spawned-agent-llm-wiring
tags: []
created: 2026-08-29T21:59:23.400Z
updated: 2026-08-29T21:59:23.400Z
---

# Spawned agents have no working LLM wiring in the integration swarm

## Problem

`drone-beacon` spawns agents via `spawner.spawnAgent()` (drone-beacon/src/spawner.ts), which launches a real `drone-agent` process inside the beacon container. That subprocess reads the beacon container's own agent config, which does NOT wire the echo LLM — so spawned agents in the integration swarm come up without a usable LLM provider (they fail their first chat call).

The compose stack only sets `LLM_PROVIDER=echo` / `LLM_ECHO_URL` on the `dummy-agent` and `test-runner` services. The beacon container (which launches the spawned agents) gets neither, and there is no mechanism for the spawn payload's `config` to select a provider for the child process today (spawner passes `--working-dir`, not LLM env/config).

## Where it bites

- `POST /api/spawn` (coordinator, reverse channel) and beacon `POST /spawn` both succeed at the TRANSPORT level (201/202 + spawn record) regardless.
- Any integration assertion that requires the spawned agent to actually THINK (register + respond, run a turn) will fail until this is fixed.
- Current workaround for the reverse-channel tests: assert on spawn RECORDS (GET beacon /spawn) and terminate the spawned agents, never on LLM-driven behavior.

## Fix sketch (for when we pick this up)

Option A: beacon passes its own env through to spawned agents (`LLM_PROVIDER`, `LLM_ECHO_URL`) when unset in the spawned config.
Option B: `SpawnRequest.config` gains an `llm` section that spawner serializes into the spawned agent's config file.
Option C: bake a default echo config into the beacon Docker image (simplest, but cements test-only wiring into prod image).

Notes:

- The echo LLM plugin requires `--plugin echo --plugin llm` (defaultEnabled: false) per plan-integration-test-beacon-isolation Category 4.
- dummy-agent works because IT gets the env vars + a baked /root/.drone-agent/config.json in its Dockerfile.
