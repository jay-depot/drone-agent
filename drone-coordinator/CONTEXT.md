# drone-coordinator

Central hub that connects beacons for swarm-wide coordination. Maintains a registry of beacons, provides swarm-wide skills and personas, and tracks session history.

## Language

**Coordinator**:
The central hub in a swarm. Beacons register with it to enable cross-beacon coordination and access to swarm-wide resources.
_Avoid_: Server, hub, central node, master

**Beacon**:
A registered beacon that has connected to this coordinator. Tracked by ID, name, host, port, and heartbeat.
_Avoid_: Node, client, peer, agent host

**Beacon Session**:
A record of an agent session that occurred on a connected beacon. Tracks the beacon, agent ID, persona, and duration.
_Avoid_: Session record, agent history, session log

**Swarm Persona**:
A persona available across the entire swarm. Synced from coordinator to beacons.
_Avoid_: Global persona, shared persona, centralized persona

**Swarm Skill**:
A skill available across the entire swarm. Synced from coordinator to beacons.
_Avoid_: Global skill, shared skill, centralized skill

**Register Beacon**:
The act of a beacon connecting to and registering with the coordinator. Includes beacon ID, name, host, and port.
_Avoid_: Beacon connect, beacon join, beacon handshake

**Heartbeat**:
A periodic signal from a beacon to indicate it's still connected. Used to detect stale connections.
_Avoid_: Ping, keepalive, check-in
