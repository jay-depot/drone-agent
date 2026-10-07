---
tags: [decision, swarm, memory, rag, retrieval, bug-fix, conversation-events, prompt-fragment]
related: [decisions/179-swarm-memory-rag-retrieval.md, concepts/memory-pipeline.md, modules/drone-agent-plugins.md]
---

# 184: Swarm-Memory Retrieval Trigger Fix — userMessage event, not onBeforePrompt

**Status**: Implemented (2026-09-03, branch `feat/swarm-memory-rag`, commit `7008f52`)

## Context

[179-swarm-memory-rag-retrieval](179-swarm-memory-rag-retrieval.md) described the proactive READ side of
swarm memory: a `ConversationWindowTracker` maintains the tight query window from
`onConversationEvent` events, and the refresh was fired from the `onBeforePrompt`
hook. That design was defective: `onBeforePrompt` fires **before**
`sendUserMessage`, but the `userMessage` conversation event that populates the
tracker's `current.userQuery` is only emitted *inside* `sendUserMessage`
(`conversation-service.ts`). So at refresh time `current.userQuery` was always
`''`.

## Consequences of the bug

- **One-turn lag.** Retrieval always ran on the **previous completed round**
  (`prevUserQuery`/`prevSteering`/`prevResponse`), never the message the user
  just typed. The injected wiki entries were topically one turn behind.
- **No injection on the first prompt of a session.** A first message had no
  prior round, so `windowText` was empty → `inputs.length === 0` →
  `maybeRefresh` returned the empty cache. The fragment was hidden on the very
  prompt it was meant to serve.
- The stated intent in `buildQueryInputs` (current query first, never truncated)
  was effectively dead for chat input — the current query was never present.

## Decision

Single trigger: the **`userMessage` branch of the existing `onConversationEvent`
handler**, after the tracker has recorded the message. The `onBeforePrompt`
retrieval hook is removed.

```ts
registration.hooks.onConversationEvent(async event => {
  memoryTracker.onEvent(event);          // sets current.userQuery
  if (event.kind === 'userMessage') {
    void memoryRetriever.maybeRefresh(memoryTracker.assemble()).catch(() => {});
  }
});
```

**Why this is safe:** the conversation service already runs conversation-event
hooks **fire-and-forget with `.catch()`** (`conversation-service.ts`), so the
async refresh can never block the turn — the "never delay the prompt" property is
preserved without any extra orchestration. The refresh stays non-blocking;
synchronous first-render freshness was deliberately **not** pursued (out of
scope), so the first LLM call of a turn may still show the prior cache, but
entries converge to the current topic as the async refresh resolves.

## What changed / stayed

- **Removed** the `onBeforePrompt` retrieval trigger (`swarm/index.ts`).
- **Triggered** retrieval from the `userMessage` event branch.
- **Kept**: `/swarm-memory refresh` manual override; `createSwarmMemoryFragment`
  (cache-only, never the network at render); hash-debounced `maybeRefresh`;
  token-budgeted/segmented window assembly; per-document MAX-score merge.
- **Fixed a stale doc comment** in `memory-query.ts`: the first query input is
  `filterForQuery`-noise-filtered, not "verbatim".
- **Added** `test/plugins/swarm/memory-trigger.test.ts` (5 cases) asserting the
  `userMessage` event is the sole trigger, the current message appears as the
  `q` query, a first message with no prior round still retrieves, non-chat events
  never trigger a search, and the fragment renders fresh entries once the async
  refresh resolves.

## En-route hardening (commit `a560918`, same feature chain)

Two adjacent swarm-memory changes landed in the same chain (documented here for
cohesion, both now live):

- **TUI chat-log notice.** `SwarmMemoryRetriever` gained an `emitNotice` dep
  (wired to `_runtime.emitEvent({kind:'notice'})`), firing
  `[swarm.memory: found N matches]` on each real (hash-changed) refresh. Gives
  the human oversight that the current window's retrieval is happening.
- **Recall tool rename.** The fragment's recall instruction now points at
  `swarm__wiki_read` (the actual canonical tool), not `wiki_read`.

## Out of scope (unchanged, deliberate)

- Synchronous first-render freshness (refresh stays fire-and-forget).
- Non-chat turns (slash commands that don't emit `userMessage`) no longer trigger
  retrieval — the retrieval window is chat-rounds-only by design.
- Queue-drain multiple `userMessage` events in one turn (pre-existing tracker
  behavior; may cause extra hash-changed refreshes).

## Alternatives considered

- **Keep `onBeforePrompt` and add the `userMessage` trigger** — rejected: causes
  two network batches per turn (the stale one runs first, then the fresh one; the
  debounce only suppresses the second of two identical windows). No fallback
  value for chat turns.
- **Block the first render on the beacon call** — rejected: violates the "never
  delay the prompt" design and needs invasive system-prompt-build refactoring.

## Consequences

- The current user message now drives retrieval: correct topicality, no
  one-turn lag, and first-message retrieval works.
- READ-side behavior of swarm memory now matches the intent stated in
  [179-swarm-memory-rag-retrieval](179-swarm-memory-rag-retrieval.md).
- The `# Swarm Memory (wiki)` fragment provides human-visible notice lines and
  correct recall instructions.
