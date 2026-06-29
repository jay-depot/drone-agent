---
key: beacon-self-improvement-plan
tags:
  - swarm-learning
  - beacon
  - self-improvement
  - phase-3.4
created: 2026-06-29T01:37:23.464Z
updated: 2026-06-29T01:37:23.464Z
---

# Part 3: Beacon-only Self-Improvement & Knowledge Base

## Summary

The beacon is a full first-class implementation of swarm learning capabilities, not a degraded fallback. It has its own swarm knowledge base, its own insights and principles tables, and runs its own self-improvement loops. All of this works without a coordinator connected. The beacon is an intentional scope boundary — host-specific personas, skills, insights, principles, and wiki pages live on the beacon permanently and never leave unless explicitly migrated.

## Architecture

This is not a separate feature — it is the beacon's implementation of the same capabilities defined in Parts 1 and 2:

### From Part 1 (Insights & Principles)
- Beacon has its own `insights` and `principles` tables (separate from coordinator's)
- Beacon's `/insights` and `/principles` endpoints serve beacon-scoped assets
- When a coordinator is connected, `?scope=coordinator` proxies to coordinator
- When no coordinator is connected, only beacon-scoped insights/principles are available
- Beacon-scoped identity assets' self-improvement loops stay on the beacon — insights are recorded to beacon, principles are derived (agent-side by default) and stored on beacon

### From Part 2 (Knowledge Base)
- Beacon has its own wiki directory on the beacon host filesystem
- Beacon's `/wiki` endpoints serve beacon-scoped wiki pages
- When coordinator is connected, beacon also serves coordinator-scoped pages (proxied)
- Beacon wiki can link up to coordinator-scoped pages
- Coordinator wiki cannot link down to beacon-scoped pages
- Ingest and lint can run on the beacon independently

### No Coordinator Dependency

Everything works without a coordinator:
- Insight/principle storage: beacon tables
- Wiki: beacon filesystem
- Self-improvement loop: agent-side derivation, stored on beacon
- Session logs as raw sources: beacon's `event_log` table (coordinator's `swarm_events` not needed for beacon-only operation)

## What This Means for Implementation

Parts 1 and 2 already build the beacon endpoints and tables. Part 3 is the **guarantee** that:
1. The beacon implementation is complete, not stubbed
2. No endpoint requires a coordinator connection to function (coordinator proxying is additive)
3. The beacon's self-improvement data (insights, principles, wiki) is permanent, not a sync cache
4. The scope boundary is respected — beacon data stays on the beacon unless explicitly migrated

## Files

No additional files beyond what Parts 1 and 2 define. Part 3 is a design constraint on Parts 1 and 2, not a separate codebase effort. The key validation is that all beacon endpoints work correctly with no coordinator configured.

## Validation Criteria
- All LSP checks pass
- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes
- Beacon starts and all `/insights`, `/principles`, `/wiki` endpoints work with no coordinator configured
- Beacon-scoped insights/principles are stored permanently in beacon's SQLite DB
- Beacon wiki pages are stored permanently on beacon's filesystem
- Coordinator proxy paths gracefully no-op (or return empty) when no coordinator is connected