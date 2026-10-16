# Context Map

## Contexts

- [drone swarm](./CONTEXT.md) — Shared cross-cutting vocabulary (identity assets, scopes, promotion, swarm sessions, knowledge distillation)
- [drone-agent](./drone-agent/CONTEXT.md) — CLI worker that embodies personas and executes tasks
- [drone-core](./drone-core/CONTEXT.md) — Shared types, contracts, config defaults, token estimation
- [drone-beacon](./drone-beacon/CONTEXT.md) — Local sync hub for agents on same host or LAN
- [drone-coordinator](./drone-coordinator/CONTEXT.md) — Central hub connecting beacons for swarm-wide coordination
- [drone-gateway](./drone-gateway/CONTEXT.md) — Chat API integration layer connecting chat platforms to the drone swarm
- [mcp-swarm](./mcp-swarm/README.md) — Reference swarm extension: a beacon that declares a capability manifest and exposes swarm functions to MCP clients over stdio
- [drone-extension-ui-types](./drone-extension-ui-types/src/index.ts) — Types-only package: the coordinator UI extension-bundle contract (`PluginClientExport`, `UIRegion`, `UIExtensionApi`, `PluginClientRoute`)

## Relationships

- **drone-core → all packages**: drone-core provides shared types and contracts used by every other package
- **drone-agent ↔ drone-beacon**: Agent connects to beacon for local skills/memories; beacon spawns agents on request
- **drone-beacon ↔ drone-coordinator**: Beacon registers with coordinator; syncs skills/personas swarm-wide
- **drone-agent ↔ drone-coordinator**: Indirect via beacon — agent accesses swarm resources through beacon
- **drone-gateway ↔ drone-coordinator**: Gateway sends spawn requests and queries to coordinator's web port (8080) via HTTP with Bearer token auth
- **mcp-swarm ↔ drone-coordinator**: The reference extension registers as a beacon and declares a capability manifest; its MCP tools proxy to coordinator REST over mTLS (ADR 254)
