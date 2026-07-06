# ADR 001: Gateway Architecture

**Status:** Accepted

**Context:** The drone swarm needs a way to receive messages from chat platforms (Matrix, Telegram, Slack) and route them to agents in the swarm. This requires a standalone service that can maintain persistent connections to chat platforms, translate between platform-specific message formats and internal formats, and manage agent lifecycle.

## Decision 1: Standalone Service (Not a Plugin)

**Decision:** The gateway is a standalone service (`drone-gateway` package) rather than a plugin within `drone-agent`.

**Rationale:**

- Chat platform connections are long-lived and must survive agent restarts. If the gateway were a plugin inside `drone-agent`, restarting the agent would disconnect all chat sessions.
- The gateway needs to manage multiple concurrent agent processes (one per conversation). Running these as child processes of a dedicated service is cleaner than nesting them inside an agent process.
- The gateway has different resource requirements (network I/O for chat APIs, process management) than the agent (LLM inference, tool execution).
- A standalone service can be deployed on the coordinator's host, close to the swarm control plane, while agents can run anywhere.

**Alternatives considered:**

- Plugin inside `drone-agent`: Rejected for the reasons above.
- Part of `drone-coordinator`: Rejected because the coordinator is a control plane, not a message relay. The gateway needs its own lifecycle and configuration.

## Decision 2: Spawn Backend Abstraction

**Decision:** The gateway uses a pluggable `SpawnBackend` interface with two implementations: `LocalSpawnBackend` and `CoordinatorSpawnBackend`.

**Rationale:**

- During development and single-host deployments, `LocalSpawnBackend` spawns `drone-agent` processes directly on the host. This is simple, has no external dependencies, and works offline.
- For multi-host deployments, `CoordinatorSpawnBackend` delegates to the coordinator's web port, which routes spawn requests to the appropriate beacon. This enables the gateway to launch agents on any host in the swarm.
- The interface is minimal (spawn, send message, terminate) and can be extended for future backends (e.g., Kubernetes, Docker).

**Alternatives considered:**

- Single hardcoded spawn mechanism: Rejected because it would couple the gateway to a specific deployment model.
- Always delegate to coordinator: Rejected because it adds latency and a dependency for simple local setups.

## Decision 3: NDJSON for Local Agent Communication

**Decision:** The `LocalSpawnBackend` communicates with `drone-agent` processes via NDJSON (newline-delimited JSON) over stdin/stdout.

**Rationale:**

- `drone-agent` already supports `--output-json` mode, which reads `chat` events from stdin and emits NDJSON events (including `assistantMessage`, `turnComplete`, `toolCall`, `error`) to stdout.
- NDJSON is simple, streamable, and requires no additional dependencies (no HTTP server, no WebSocket, no message queue).
- The `turnComplete` event provides a natural boundary for the gateway to know when the agent has finished processing a message and is ready for the next one.
- stdin/stdout communication is the most portable inter-process communication mechanism available.

**Alternatives considered:**

- HTTP API on the agent: Rejected because it would require the agent to run an HTTP server, adding complexity and a port management problem.
- Unix sockets: Rejected because they're less portable (Windows compatibility) and add complexity without benefit over stdin/stdout.

## Decision 4: Control Surfaces Evaluated in Order (First-Match Wins)

**Decision:** When a message arrives from a service adapter, it is passed to each control surface in the order they are configured. The first surface that returns `{ handled: true }` wins, and its response (if any) is sent back via the adapter.

**Rationale:**

- This allows composing multiple behaviors in a single conversation. For example, a `mention-router` surface can be configured before a `persona-assignment` surface: if the message contains `!coder ...`, the mention router handles it; otherwise, the persona assignment surface handles it as a normal message.
- The ordering is explicit in the config, making the behavior predictable and debuggable.
- This pattern is simple to implement and reason about, avoiding the complexity of priority-based or rule-based dispatch systems.

**Alternatives considered:**

- Priority-based dispatch: Rejected because explicit ordering is simpler and more predictable.
- Regex-based routing: Rejected because it's less flexible and harder to configure.
- All surfaces process every message: Rejected because it would cause duplicate responses.

## Decision 5: Gateway Talks to Coordinator's Web Port

**Decision:** The gateway communicates with the coordinator's web port (port 8080 by default) using HTTP with optional Bearer token authentication.

**Rationale:**

- The coordinator's web port is already the control plane API. Using it avoids duplicating the API surface on a separate port.
- The coordinator already has routes for spawn management (`POST /spawn`, `GET /spawn/:beaconId`, etc.) and message relay (`POST /messages`), which the gateway needs.
- Bearer token authentication is already supported by the coordinator, providing a simple security mechanism.
- The gateway is expected to run on the same host as the coordinator (or on a trusted network), so the coordinator's local-only enforcement applies.

**Alternatives considered:**

- Talk to the beacon directly: Rejected because the beacon is a local-only service and may not be reachable from the gateway's host. The coordinator provides a unified API across all beacons.
- Dedicated gateway port on the coordinator: Rejected because it would duplicate the existing API surface.

## Consequences

- The gateway is a separate deployable unit with its own config file and lifecycle.
- New chat platform integrations require implementing the `DroneServiceAdapter` interface.
- New control surface types require implementing the `DroneControlSurface` interface and registering them in `createControlSurface()`.
- The gateway can be deployed in two modes: local (spawns agents on the same host) or coordinator (delegates to the coordinator).
- The gateway has no adapter implementations yet — these will be added in follow-up phases (4.2 Matrix, 4.6 Telegram, 4.7 Slack).
