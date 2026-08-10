# Swarm Plugin

The `swarm` plugin connects to a `drone-beacon` instance to provide swarm-wide personas, skills, and config injection. It is not enabled by default.

## Capabilities

- Registers persona and skill providers at both the beacon and coordinator precedence levels
- Provides a WebSocket-based messaging channel for inter-agent communication
- Registers HTTP storage engines for swarm-scoped insights and principles
- Registers wiki and coordinator tools using the list/mount pattern (3 meta-tools: `list_tools`, `mount_tool`, `unmount_tool`)
- Pushes conversation events to the coordinator
