---
tags:
  - decision
  - swarm
related:
  - self-improvement.md
  - swarm-architecture.md
---

# ADR 014: Swarm Knowledge Base (LLM Wiki)

**Status**: Accepted (2026-06-28)

## Context

The swarm needed a persistent, structured knowledge base that agents could read and write. Session logs were the raw sources, but a maintained wiki was needed for compounding knowledge.

## Decision

Implement an LLM Wiki-style knowledge base for the swarm. Wiki pages are stored as markdown files on the server filesystem with YAML frontmatter. The existing `knowledge` table is reserved for a future vector index.

## Rationale

- **LLM Wiki pattern**: Adapted from Karpathy's approach — raw sources (session logs) → maintained wiki → query/lint workflows
- **Markdown files**: Simple, inspectable, version-controllable
- **Scope enforcement**: "No linking downwards" — coordinator pages cannot link to beacon pages
- **Agent tools**: `wiki_read`, `wiki_write`, `wiki_search`, `wiki_list`, `wiki_delete`, `wiki_lint`

## Implementation

- Wiki pages stored as `.md` files on server filesystem
- YAML frontmatter: `title`, `scope`, `tags`, `sources`
- REST endpoints on both beacon and coordinator
- Beacon proxies coordinator-scoped requests
- Scope enforcement: hard (reject on write) + soft (lint flags)
- Agent tools registered in swarm plugin

## Consequences

- Persistent, compounding knowledge base for the swarm
- Scope boundaries are enforced (no downward links)
- Agent tools for full CRUD and linting
- Vector search deferred to future phase

## Related

- [[self-improvement]] — Self-improvement system
- [[swarm-architecture]] — Swarm mode
- [[decisions/013-swarm-insights-principles]] — Related swarm learning feature
