---
tags:
  - decision
  - swarm
related:
  - swarm-architecture.md
  - drone-beacon.md
---

# ADR 008: Inter-Agent Messaging via WebSocket + REST

**Status**: Accepted (2026-06-24)

## Context

Agents on the same beacon needed a way to communicate. Options included: polling-only, WebSocket-only, or hybrid.

## Decision

Use WebSocket for real-time delivery with REST fallback for offline agents. Messages are stored in a `messages` table with delivery tracking.

## Rationale

- **WebSocket**: Real-time, bidirectional, efficient for active agents
- **REST fallback**: Offline agents can poll for missed messages on reconnect
- **Delivery tracking**: Explicit ACK from recipient ensures reliability
- **Direct + Channel**: Both supported (direct for task delegation, channel for events)

## Implementation

- WebSocket server at `/ws` with agent ID in query string
- REST endpoints: `POST /messages`, `GET /messages`, `GET /messages/:id`, `POST /messages/:id/read`, `GET /messages/channel/:channel`
- Messages stored in SQLite with `delivered` flag
- Cleanup job deletes delivered messages after 24 hours

## Cross-Beacon Extension

Cross-beacon messaging was later added via coordinator relay (see [009-cross-beacon-messaging](009-cross-beacon-messaging.md)).

## Consequences

- Real-time message delivery for connected agents
- Offline agents can retrieve missed messages
- Channel-based broadcast for group communication
- 24-hour retention for delivered messages

## Related

- [009-cross-beacon-messaging](009-cross-beacon-messaging.md) — Cross-beacon extension
- [drone-beacon](../../drone-beacon/) — Beacon implementation
