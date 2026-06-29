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

**SwarmSession**:
A unique instance of an agent's interactional lifecycle tracked on the coordinator. Identified by a session ID and associated with a specific Persona and Beacon. Distinct from the agent-local [[drone-agent/CONTEXT.md|Session]] (a CLI invocation) — a SwarmSession is the coordinator's persistent record of that invocation.
_Avoid_: Chat, Conversation

**SessionEvent**:
The atomic unit of a session's history as stored on the coordinator. Every single interaction — a user's prompt, an LLM's response, a tool call, or a tool result — is recorded as a separate `SessionEvent`. Distinct from the agent-local [[drone-agent/CONTEXT.md|Message]] (what the LLM sees) — a SessionEvent is the stored representation on the server.
_Avoid_: Message, Row, Entry

**Turn**:
A logical grouping of one or more `SessionEvents` that form a single request-response cycle. Identified by a `correlation_id`. A turn typically starts with a `USER_TURN` and ends with a final `LLM_RESPONSE`. This is the same concept as the agent-local [[drone-agent/CONTEXT.md|Turn]] — the agent views it as a round in the conversation, the coordinator stores it as grouped events.
_Avoid_: Cycle, Iteration

**Knowledge Distillation**:
The asynchronous process of analyzing `SessionEvents` and `Turns` to identify recurring patterns, errors, or successes, and promoting those insights into persistent Principles.
_Avoid_: Summary, Compression

**Principle**:
A distilled piece of knowledge (fact, preference, or pattern) derived from session logs or insights that is stored in the knowledge registry to guide future agent behavior. Managed by the [[concepts/self-improvement|self-improvement system]].
_Avoid_: Memory, Rule
