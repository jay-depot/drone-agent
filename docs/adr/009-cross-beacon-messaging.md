---
tags:
  - decision
  - swarm
related:
  - swarm-architecture.md
  - drone-coordinator.md
---

# ADR 009: Cross-Beacon Messaging via Coordinator Relay

**Status**: Accepted (2026-06-28)

## Context

Phase 2 messaging worked only for agents on the same beacon. Agents on different beacons needed a way to communicate.

## Decision

Route cross-beacon messages through the coordinator as a relay hub. The coordinator maintains an `agent_locations` table to track which beacon each agent is on.

## Rationale

- **Central routing**: Coordinator already knows all beacons, making it the natural relay point
- **Simplicity**: No need for direct beacon-to-beacon connections or NAT traversal
- **Observability**: Coordinator can log all cross-beacon traffic
- **Gradual adoption**: Works with existing beacon infrastructure

## Implementation

- `agent_locations` table on coordinator: `agent_id`, `beacon_id`, `persona_id`, timestamps
- `POST /messages/relay` on coordinator: looks up recipient beacon, forwards message
- Beacon registers/unregisters agent locations on connect/disconnect
- Beacon's `POST /messages` accepts `fromBeaconId` for relayed messages

## Consequences

- Agents on different beacons can communicate
- Coordinator tracks all agent locations
- Graceful degradation if coordinator is down (messages queue locally)
- Direct beacon-to-beacon communication deferred as future optimization

## Related

- [008-inter-agent-messaging](008-inter-agent-messaging.md) — Local messaging
- [drone-coordinator](../../drone-coordinator/) — Coordinator implementation
