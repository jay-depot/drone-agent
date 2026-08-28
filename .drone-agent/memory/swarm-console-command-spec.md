---
key: swarm-console-command-spec
tags: []
created: 2026-08-14T00:39:08.525Z
updated: 2026-08-14T00:47:27.422Z
---

# Swarm Console Command Specification (v1)

## Overview

The Swarm Console provides a unified control surface for managing a distributed agent workforce. It is designed as a "Command Line Plus" interface, utilizing a dot-notation hierarchy that is compatible with terminal input, chat-service relays (Matrix, Discord, Slack), and hierarchical autocomplete in the Web UI.

## Command Syntax

**Format:** `swarm.<namespace>.<command> [args] [options]`

---

## 1. Global Namespace (`swarm.*`)

Operations handled by the Coordinator that affect the entire swarm or global asset registries.

| Command                | Syntax                                                         | Description                                                               |
| :--------------------- | :------------------------------------------------------------- | :------------------------------------------------------------------------ |
| `swarm.broadcast`      | `swarm.broadcast <message> [--all \| --beacon <id>]`           | Pushes a message to agent sessions. Defaults to all if `--all` is used.   |
| `swarm.persona.list`   | `swarm.persona.list`                                           | Lists global personas and their sync status across beacons.               |
| `swarm.persona.create` | `swarm.persona.create <id> <description> [content]`            | Seeds a new global persona.                                               |
| `swarm.persona.update` | `swarm.persona.update <id> [content]`                          | Updates a global persona definition.                                      |
| `swarm.persona.delete` | `swarm.persona.delete <id>`                                    | Removes a global persona.                                                 |
| `swarm.persona.sync`   | `swarm.persona.sync <beaconId>`                                | Forces push of global personas to a specific beacon.                      |
| `swarm.skill.list`     | `swarm.skill.list`                                             | Lists global skills and their recall conditions.                          |
| `swarm.skill.create`   | `swarm.skill.create <id> <description> [recall]`               | Seeds a new global skill.                                                 |
| `swarm.skill.update`   | `swarm.skill.update <id> [content]`                            | Updates a global skill definition.                                        |
| `swarm.skill.delete`   | `swarm.skill.delete <id>`                                      | Removes a global skill.                                                   |
| `swarm.skill.sync`     | `swarm.skill.sync <beaconId>`                                  | Forces push of global skills to a specific beacon.                        |
| `swarm.session.search` | `swarm.session.search <query> [--date <iso>] [--persona <id>]` | Finds sessions by keyword or metadata. (Hook for future semantic search). |
| `swarm.session.get`    | `swarm.session.get <sessionId>`                                | Retrieves the full log/summary of a session.                              |
| `swarm.session.delete` | `swarm.session.delete <sessionId>`                             | Purges a session from the coordinator archive.                            |
| `swarm.session.list`   | `swarm.session.list [--limit <n>]`                             | Lists recent sessions across the swarm.                                   |

---

## 2. Regional Namespace (`swarm.beacon.*`)

Operations targeting a specific Local Hub (Beacon) and its managed agents.

| Command               | Syntax                                                                     | Description                                                    |
| :-------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------- |
| `swarm.beacon.list`   | `swarm.beacon.list`                                                        | Lists all registered beacons and their current load.           |
| `swarm.beacon.spawn`  | `swarm.beacon.spawn <beaconId> --persona <id> --task <text> [--count <n>]` | Launches one or more agents on a specific beacon.              |
| `swarm.beacon.status` | `swarm.beacon.status <beaconId>`                                           | Returns beacon health and list of active agents.               |
| `swarm.beacon.kill`   | `swarm.beacon.kill <beaconId> [--persona <id>]`                            | Terminates agents on a beacon, optionally filtered by persona. |
| `swarm.beacon.policy` | `swarm.beacon.policy <beaconId> <key> <value>`                             | Updates regional constraints (e.g., `max-tokens`).             |

---

## 3. Individual Namespace (`swarm.agent.*`)

Surgical control over a specific running agent session.

| Command                 | Syntax                                                     | Description                                               |
| :---------------------- | :--------------------------------------------------------- | :-------------------------------------------------------- |
| `swarm.agent.status`    | `swarm.agent.status <agentId>`                             | Returns active persona, plugins, and current focus.       |
| `swarm.agent.focus`     | `swarm.agent.focus <agentId> <text\|clear>`                | Sets or clears the agent's "Focused/Obsessed" mode.       |
| `swarm.agent.inject`    | `swarm.agent.inject <agentId> <text> [--header\|--footer]` | Pushes a prompt fragment into the active session.         |
| `swarm.agent.persona`   | `swarm.agent.persona <agentId> <personaId>`                | Hot-swaps the active persona mid-session.                 |
| `swarm.agent.interrupt` | `swarm.agent.interrupt <agentId> <message>`                | Force-stops the tool-loop and injects a priority message. |
| `swarm.agent.terminate` | `swarm.agent.terminate <agentId>`                          | Kills the specific agent session.                         |

## Implementation Notes

- **Parser:** The system should use a token-based parser that handles positional arguments for IDs and flags for options.
- **Autocomplete:** The dot-notation hierarchy should be used to generate the autocomplete tree in the Web UI.
- **Security:** All commands must be authenticated against the coordinator's single-user identity.
