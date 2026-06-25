---
key: drone-swarm-plugin-for-alice
tags:
  - plugin
  - swarm
  - alice
  - design
  - hypothetical
created: 2026-06-25T01:02:06.847Z
updated: 2026-06-25T01:02:06.847Z
---

# Drone Swarm Plugin for ALICE

## Concept

ALICE as the Brain + Voice + Orchestrator, spawning drone-agents as remote workers.

```
ALICE (orchestrator) → drone-agents (workers on remote machines)
```

## Architecture

- Plugin ID: `drone-swarm` (or `locutus`, `queen-bee` - see naming notes)
- Dependencies: `agents`, `web-ui`, `memory`
- Reuses ALICE's existing `agents` plugin for lifecycle management
- Spawns drone-agents via SSH or local spawn, registers as independent agents

## Tools to Register

| Tool | Description |
|------|-------------|
| `drone.spawn` | Spawn a new drone-agent worker on remote machine |
| `drone.list` | List all active drone instances |
| `drone.send` | Send a message to a running drone |
| `drone.terminate` | Kill a drone instance |

## Parameters for `drone.spawn`

- `host` (string): Target host (localhost, hostname, or IP)
- `port` (number): Beacon port on target (default 3457)
- `task` (string): Task description for the drone
- `persona` (string, optional): Persona to load
- `name` (string, optional): Friendly name
- `workingDir` (string, optional): Working directory on remote

## Key Integration Points

1. **Reuse `agents` plugin**: Register drones as independent agents in AgentSystem
   - Gets pause/resume/suspend for free
   - Web UI monitoring included
   - Checkpointing via MikroORM

2. **Voice hooks**: Intercept voice commands like "check the NAS" and auto-spawn

3. **Web UI dashboard**: React component for fleet monitoring

4. **Beacon relay**: For streaming results back to ALICE (depends on drone-side support)

## Killer Feature: "Ambient Remote Hands"

Voice-driven remote execution:
1. User: "Hey ALICE, check the NAS logs"
2. ALICE spawns drone on NAS
3. Drone runs diagnostics
4. Drone reports back
5. ALICE speaks result

## Naming Options

- `drone-swarm` - straightforward
- `locutus` - Borg reference (the collective mind)
- `queen-bee` - bee colony analogy (queen coordinates the swarm)
- `hive-mind` - similar to locutus

## What's Needed to Build

| Component | Effort |
|-----------|--------|
| SSH/spawn logic | Medium |
| Tool implementations | Small |
| Beacon relay | Medium |
| Web UI dashboard | Medium |
| Voice command hooks | Small |
| Integration with agents plugin | Small |

## Complementary Strengths

| ALICE Has | drone Adds |
|-----------|-------------|
| Voice I/O | Remote execution |
| 66+ plugins | Minimal tool-focused agents |
| MikroORM DB | Worker checkpointing |
| Web UI (local) | Fleet monitoring |
| Ambient/long-running | Spawn-on-demand workers |
| Personality system | Per-task personas |
| Gmail/Calendar | Can spawn drones on those machines |

---

*Last updated: 2025 (hypothetical design)*