# drone swarm

Shared vocabulary for cross-cutting concepts that span all three contexts (drone-agent, drone-beacon, drone-coordinator).

## Language

**Identity Asset**:
A persona or skill — the two artifact types that define an agent's identity and capabilities. Both follow the same scope hierarchy and are subject to the same self-improvement and migration mechanisms.
_Avoid_: Profile, definition, artifact (for this specific meaning)

**Scope**:
The visibility boundary of an identity asset or other resource. Ordered by breadth: project → user → beacon → coordinator. Assets can be promoted from narrower to broader scopes.
_Avoid_: Level, tier, layer

**Local Scope**:
Project or user scope — assets that live on the agent's filesystem and whose self-improvement loops stay fully local. Never automatically pushed to any server.
_Avoid_: (none — new term)

**Swarm Scope**:
Beacon or coordinator scope — assets that live on a server (beacon or coordinator) and whose self-improvement loops run at the owning level. Conversation logs and insights always go to the owning server.
_Avoid_: (none — new term)

**Promotion**:
The act of moving an identity asset from a narrower scope to a broader scope (e.g., project → user, beacon → coordinator). Performed via the migration tool.
_Avoid_: Upgrade, escalation, sharing

**Demotion**:
The act of pulling a swarm-scoped identity asset down to a local scope (e.g., coordinator → user, beacon → project). Performed via the migration tool.
_Avoid_: Downgrade, pull-down
