# drone-gateway

Standalone service that connects chat platforms to the drone swarm. Receives messages from chat platforms (Matrix, Telegram, Slack), routes them through control surfaces, and sends responses back. Acts as the bridge between human conversation and agent coordination.

## Language

**Gateway**:
The standalone service itself. Loads config, initializes service adapters, runs the message routing loop, and communicates with the coordinator.
_Avoid_: Bridge, relay, proxy, chat bot

**Service Adapter**:
A platform integration (Matrix, Telegram, Slack). Each adapter knows how to connect to that platform's API, authenticate, and translate between platform-specific message formats and the gateway's internal format.
_Avoid_: Connector, driver, integration, channel

**Control Surface**:
A configuration that maps a chat conversation (room, DM, channel) to a behavior. A control surface is attached to a service adapter. Multiple control surfaces can be attached to the same adapter, and they are evaluated in order until one handles the message.
_Avoid_: Handler, rule, mapping, route

**Persona Assignment**:
A control surface that routes all messages in a conversation to a specific persona. The gateway spawns an agent with that persona on the configured beacon, sends the message as a task, and returns the response.
_Avoid_: Persona router, persona mapper, persona binding

**Swarm Console**:
A control surface that exposes coordinator commands (spawn, status, terminate, list beacons, etc.) as chat-accessible commands. Users type commands like `!spawn`, `!status`, `!beacons`, `!terminate` to manage the swarm from chat.
_Avoid_: Admin console, swarm shell, command surface

**Mention Router**:
A control surface that watches for `!persona` mentions in a conversation and routes those messages to the specified persona. Falls through (unhandled) if no mention is detected, allowing other control surfaces to process the message.
_Avoid_: Mention handler, persona mention, dispatch surface

**Adapter Message**:
The internal message format used by the gateway. Contains the adapter ID, conversation ID, message text, and optional sender information. Service adapters translate platform-specific messages into this format.
_Avoid_: Gateway message, internal message, envelope

**Coordinator Client**:
The HTTP client used by the gateway to communicate with the coordinator's web port (8080). Uses Bearer token authentication. Provides methods for spawning agents, listing beacons, and managing spawns.
_Avoid_: Coordinator API, coordinator proxy, coordinator connector
