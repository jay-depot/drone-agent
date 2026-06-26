# drone-beacon

Local sync hub that coordinates agents on the same host or LAN. Provides local skills, memories, and can spawn agents on behalf of connected clients.

## Language

**Beacon**:
A local sync hub running on a host. Agents connect to it for local skills/memories. Beacons can connect to a coordinator for swarm-wide features.
_Avoid_: Server, hub, node, daemon

**Agent Session**:
A registered connection from an agent to the beacon. Has an ID and tracks the agent's persona (if any) and last activity.
_Avoid_: Agent connection, client session, worker registration

**Spawn Record**:
A request to spawn a new agent, tracked through its lifecycle. Transitions: spawning → running → terminated (or failed).
_Avoid_: Spawn request, agent spawn, process launch

**Memory**:
Key-value storage for inter-session state. Supports namespaces for isolation and TTL for expiration.
_Avoid_: State, cache, key-value store

**Message**:
Inter-agent communication. Can be direct (to a specific agent) or broadcast (to a channel).
_Avoid_: Inter-agent message, packet, notification

**Event Log**:
Append-only audit trail for beacon activity (agent connections, persona changes, skill updates, etc.).
_Avoid_: Audit log, activity log, event stream

**Beacon Config**:
Configuration scoped to this beacon. Can be local (default) or swarm-synchronized via coordinator.
_Avoid_: Local config, beacon settings

**Local Persona**:
A persona stored locally on this beacon. Scoped to 'local' to distinguish from swarm-wide personas.
_Avoid_: Beacon persona, resident persona

**Local Skill**:
A skill stored locally on this beacon. Scoped to 'local' to distinguish from swarm-wide skills.
_Avoid_: Beacon skill, resident skill

**Spawn Config**:
Configuration for spawning a new agent (model, preamble, working directory, environment variables).
_Avoid_: Agent config, spawn options, launch config
