---
key: swarm_phase_1_plan
tags:
  - architecture
  - roadmap
  - swarm
created: 2026-06-23T22:43:59.156Z
updated: 2026-06-23T22:43:59.156Z
---

Phase 1: The Distributed Capability Layer. 
Goal: Implement the Fractal Resolver chain (Project > User > Beacon > Coordinator) for Personas and Skills, establishing the network communication bridge without replacing local-first persistence.

Key Deliverables:
1. swarm plugin: Implement Composite Provider for Personas/Skills.
2. drone-beacon: SQLite local hub acting as a cache and proxy for the Coordinator.
3. drone-coordinator: Minimalist global registry for swarm-wide identities and capabilities.

Success Metric: Ability to load a 'Global' persona from the Coordinator in a project with no local configuration.