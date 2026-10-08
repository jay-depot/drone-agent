---
name: planning-seed-mixed-conversation-batching
description: Seed — batching in mixed-surface conversations (swarm-console + persona-assignment)
tags: [seed, drone-gateway, batching, control-surface, follow-up]
created: 2026-10-05
updated: 2026-10-05
---

# Planning seed: mixed-conversation batching

**Status:** seed only (2026-10-05), not planned. Captured during the grilling for
the gateway tagging + batching + response opt-out feature.

**Type:** seed — the shape is agreed-in-spirit; several decisions are deliberately open.

## The problem

The tagging/batching feature (gateway chat tagging + drain-on-idle batching +
multi-user response opt-out) enables batching **only for a conversation that is
an exact match and has exactly one batch-eligible surface** (a surface that
implements `handleBatch`). A conversation that composes multiple surfaces — e.g.
`[swarm-console, persona-assignment]` — is deliberately excluded in v1.

That exclusion is a punt, not a solution. In a mixed conversation the surfaces
interleave: `swarm.beacon.list` (a command that must run immediately and never
merge) and free chat text (which **should** batch). Deciding when to flush the
batch is ambiguous:

- A `swarm.` command arriving mid-batch must not be merged into a merged chat
  turn.
- But it also should not blindly flush the batch, or every command would force a
  premature flush.

## The open decisions

1. **Boundary rule.** Is the batch flushed when a message is claimed by a
   different surface? Or is each surface given its own independent buffer, so
   commands and chat text batch separately (and never merge)? The latter seems
   right, but the engine currently keys serialization + dispatch on the
   _conversation_, not the surface.
2. **Ordering.** If per-surface buffers exist, in what order do the flushes
   happen relative to one another? Arrival order must be preserved across
   surfaces (mirrors the ordered `pendingEntries` queue in the agent, ADR 215).
3. **The engine's dispatch model.** Today `MessageBatcher` sits one-per-conversation
   in the engine. Per-surface buffering may want the batcher attached to the
   `(conversation, surface)` pair, or the surface may own its own debounce.
4. **Interaction with the immediate path.** `swarm-console` commands declare
   themselves immediate (they are `handled` and never fall through). Should a
   command arriving while a chat batch is pending flush that batch first (so the
   command's output ordering is intuitive), or run in parallel?

## Relevant code (as of the tagging/batching feature)

- `drone-gateway/src/engine.ts` — `handleMessage` + `runOnTail` (per-conversation
  serialization); `InstantiatedConversation`.
- `drone-gateway/src/batcher.ts` — the new `MessageBatcher` (pending buffer +
  debounce + `flush`).
- `drone-gateway/src/surfaces/*.ts` — `handleMessage` (immediate) and the new
  optional `handleBatch` (batch-eligible).
- The agent-side analogue: the ordered `pendingEntries` queue (text + slash
  kinds) drained at two points, ADR 215 `slash-commands-during-work`.

## Why it is deferred

The real use case for batching is one persona per room. Mixed-surface
conversations (`[swarm-console, persona-assignment]`) are an advanced
configuration; shipping the simple single-surface rule first avoids encoding
boundary logic before we have a concrete case to validate it against.
