---
key: self-improving-swarm-architecture
tags:
  - architecture
  - self-improvement
  - swarm
  - drone-agent
  - design
created: 2026-06-24T23:31:00.513Z
updated: 2026-06-24T23:31:00.513Z
---

# Self-Improving Swarm Architecture for drone-agent

## Overview

This document describes an architecture for adding self-improving capabilities to the drone-agent system, building on patterns from Hermes Agent's continuous improvement loop, but adapted for a multi-agent swarm architecture.

## Architecture

### Components

1. **Coordinator Layer** (`drone-coordinator`)
   - Global session storage (all beacon sessions searchable)
   - Shared knowledge registry (skills, patterns, facts, preferences)
   - Swarm review task (identifies patterns across beacons)
   - Broadcast mechanism (propagates learned knowledge)

2. **Beacon Layer** (`drone-beacon`)
   - Local session storage (for offline operation)
   - Local memory (user preferences)
   - Push to coordinator on session end
   - Sync knowledge from coordinator

3. **Agent Layer** (`drone-agent`)
   - Background review fork (per-turn learning)
   - Skill creation/management
   - Memory read/write

## Data Flow

```
Agent Turn Ends
    │
    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Local Review │───▶│ Save Local  │───▶│ Update      │
│ (optional)   │    │ Session     │    │ Memory      │
└──────────────┘    └──────────────┘    └──────────────┘
         │                                │
         │         ┌─────────────────────┘
         │         ▼
         │  ┌────────────────────────┐
         │  │ Push to Coordinator    │
         │  │ (if enabled)           │
         │  └────────────────────────┘
         │         │
         ▼         ▼
┌─────────────────────────────────────────┐
│ COORDINATOR                              │
│ - Store Sessions                         │
│ - Index FTS (searchable)                │
│ - Swarm Review (identify patterns)       │
│ - Broadcast Knowledge                    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ ALL BEACONS SYNC                         │
│ - Updated skills                        │
│ - Shared patterns                       │
│ - Aggregated user preferences           │
└─────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Shared Session Storage (Coordinator)

- Add `swarm_sessions`, `swarm_messages` tables with FTS5
- Routes: POST /swarm/sessions/:beaconId, POST /swarm/messages/:sessionId, GET /swarm/search

### Phase 2: Enhanced Beacon → Coordinator Sync

- Make sync bidirectional (beacon pushes on session end)
- Store full session data or summaries

### Phase 3: Global Memory & Skills

- Extend coordinator with `knowledge` table
- Categories: skill, pattern, preference, fact
- Routes: GET/POST /knowledge, GET /knowledge/search

### Phase 4: Swarm Learning Tasks

- Coordinator runs periodic swarm review
- Identifies patterns across beacons
- Merges into shared knowledge
- Broadcasts to all beacons

### Phase 5: Config Integration

```typescript
swarm: {
  enabled: boolean,
  coordinatorUrl: string,
  shareSessions: boolean,
  shareMemory: boolean,
  shareSkills: boolean,
  localNudgeInterval: number,      // default: 10
  swarmReviewIntervalMinutes: number,
  searchableByDefault: boolean,
}
```

## Key Differences from Hermes

| Aspect   | Hermes       | Drone Swarm     |
| -------- | ------------ | --------------- |
| Learning | Single agent | All beacons     |
| Storage  | Local SQLite | Coordinator DB  |
| Search   | Local FTS5   | Global search   |
| Patterns | Per-agent    | Cross-beacon    |
| Skills   | Local        | Shared registry |

## Implementation Effort

| Component          | Changes                                              | Effort  |
| ------------------ | ---------------------------------------------------- | ------- |
| Coordinator DB     | Add swarm_sessions, swarm_messages, knowledge tables | 1 day   |
| Coordinator Routes | Add /swarm/\* routes for push/search                 | 1 day   |
| Beacon             | Push sessions to coordinator on end                  | 1 day   |
| Agent Config       | Add swarm config section                             | 0.5 day |
| Swarm Review       | Coordinator periodic task                            | 2 days  |
| Global Search      | Query all beacons sessions                           | 1 day   |

**Total**: ~6-7 days

## Key Files Reference

From Hermes (patterns to adapt):

- `agent/background_review.py` - Background review fork
- `agent/curator.py` - Periodic maintenance
- `agent/memory_manager.py` - Memory orchestration
- `agent/learn_prompt.py` - Skill creation
- `tools/session_search_tool.py` - FTS5 search
- `tools/skill_usage.py` - Skill tracking

## Integration Points

1. **Config schema**: `drone-core/src/config-schema.ts` - Add swarm config
2. **Beacon DB**: `drone-beacon/src/db.ts` - Already has memory, extend for sessions
3. **Coordinator DB**: `drone-coordinator/src/db.ts` - Add new tables
4. **Coordinator routes**: `drone-coordinator/src/routes.ts` - Add swarm endpoints
5. **Agent runtime**: `drone-agent/src/runtime/conversation-service.ts` - Hook for review

## Benefits

1. **Knowledge compounds** - What one beacon learns, all beacons know
2. **Parallel learning** - Multiple beacons learn simultaneously
3. **Cross-pollination** - Patterns from beacon A help beacon B
4. **Swarm intelligence** - Coordinator identifies patterns across entire swarm

---

_Last updated: 2025_
_Source: Analysis of Hermes Agent continuous improvement loop + drone-agent architecture_
