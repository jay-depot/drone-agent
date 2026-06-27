# Swarm Coordination Context

This context defines the domain language for the `drone-coordinator` and the shared session storage system.

## Language

**SwarmSession**:
A unique instance of an agent's interactional lifecycle. It is identified by a session ID and associated with a specific Persona and Beacon.
_Avoid_: Chat, Conversation

**SessionEvent**:
The atomic unit of a session's history. Every single interaction—a user's prompt, an LLM's response, a tool call, or a tool result—is recorded as a separate `SessionEvent`.
_Avoid_: Message, Row, Entry

**Turn**:
A logical grouping of one or more `SessionEvents` that form a single request-response cycle. Identified by a `correlation_id`. A turn typically starts with a `USER_TURN` and ends with a final `LLM_RESPONSE`.
_Avoid_: Cycle, Iteration

**Knowledge Distillation**:
The asynchronous process of analyzing `SessionEvents` and `Turns` to identify recurring patterns, errors, or successes, and promoting those insights into persistent Principles.
_Avoid_: Summary, Compression

**Principle**:
A distilled piece of knowledge (fact, preference, or pattern) derived from the session logs that is stored in the knowledge registry to guide future agent behavior.
_Avoid_: Memory, Rule
