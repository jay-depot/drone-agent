---
tags:
  - decision
  - swarm
related:
  - swarm-architecture.md
---

# ADR 004: Single-User Swarm Design

**Status**: Accepted (2026-06-18)

## Context

The swarm architecture needed to define its user model. Options included: multi-user with permissions, single-user with trust, or something in between.

## Decision

The swarm is designed for a single human user. All agents in the swarm work for the same user.

## Rationale

- **Simplified security**: No need for multi-user authentication, authorization, or isolation
- **Simplified coordination**: Agents can freely share state and communicate without permission checks
- **Focused scope**: The project is a coding agent platform, not a general-purpose multi-user system
- **Extensibility**: Multi-user coordination can be handled by an MCP server on top of the swarm

## Consequences

- No multi-user authentication or authorization
- Agents trust each other implicitly
- Cross-beacon coordination is about capability routing, not access control
- For multi-user scenarios, set up separate swarms connected via MCP

## Related

- [[swarm-architecture]] — Swarm mode
