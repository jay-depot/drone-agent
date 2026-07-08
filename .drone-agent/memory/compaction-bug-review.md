---
key: compaction-bug-review
tags:
  - bug
  - compaction
  - concurrency
created: 2026-07-08T02:15:00.000Z
updated: 2026-07-08T02:15:00.000Z
---

I've traced the whole path. The unit tests pass; the plugin logic is sound **in isolation**.
The bug is in how it's wired into the real runtime, and it's a real "nothing ever compacts,
ever" kind of bug. Here's what I found.

## The smoking gun: `compactionInFlight` is permanently stuck `true`

Look at `maybeCompact` (compaction/index.ts:101-103):

```ts
const turns = sessionManager.getTurns();
if (turns.length === 0) {
  return; // ← bails WITHOUT resetting compactionInFlight
}
```

And the hook body (compaction/index.ts:300-318):

```ts
const hookBody = async (): Promise<void> => {
  if (!config.enabled) return;
  if (context.compactionInFlight.value) return;   // ← guard
  context.compactionInFlight.value = true;        // ← latched ON
  ...
  await maybeCompact({ context, baseSystemMessages, fragmentMessages });
};
```

The `turns.length === 0` early-return inside `maybeCompact` does **not** reset
`context.compactionInFlight.value`. So:

1. Every shell (interactive loop, `index.tsx` chat/TUI/JSON, `tui/app.tsx`) fires
   `onBeforePrompt` **before** `sendUserMessage` (index.tsx:291, interactive.ts:111,
   app.tsx:391, etc.).
2. On the very first message/session, `sessionManager.getTurns()` is empty (the user message
   isn't appended until `sendUserMessage` runs).
3. `hookBody` sets `compactionInFlight = true`, `maybeCompact` hits `turns.length === 0`,
   returns early, and the flag stays `true`.
4. From that point on, **both** `onBeforePrompt` and `onAfterToolCall` bail at the guard `if
(context.compactionInFlight.value) return;` — forever. Compaction is dead for the rest of the
   session.

That's your "no sign compaction is ever triggered." It's latched off on the first prompt and
never recovers. The "things are just being dropped" you observe is the _safety-trim_ path in
the conversation service (`ensureSafeBudget`) doing a dumb drop — compaction never gets a
chance to summarize.

## Why the test suite doesn't catch it

The test `resets compactionInFlight after the empty-turns early return`
(compaction.test.ts:~690) is **bogus**. After running `runBeforePrompt(capture)` once on an
empty session, it builds a _brand-new plugin and a brand-new capture_
(`smallPlugin`/`smallCapture`) for the second call — which has its own fresh
`compactionInFlight: { value: false }`. It never actually exercises the lock state persisting
across calls on the same instance. So the test passes and the real bug survives. That's a
test that validates nothing about the failure mode.

## Secondary issues (not the cause, but worth fixing)

- **The guard itself is the wrong shape.** Latching a single mutable `compactionInFlight`
  flag that's reset only on the "happy path" exits is fragile. The `turns.length === 0` return
  is one of several early returns that skip the reset; the only resets are the summary-purge
  return, the `sliceSize <= 0` return, and the end of the function. Every new early-exit path
  is a new way to permanently brick compaction. This should be a `try/finally` in `hookBody`
  that always resets the flag.

- **`onBeforePrompt` is the wrong trigger anyway.** It fires before turns exist by design
  (message appended inside `sendUserMessage`). Even with the lock fixed, `onBeforePrompt` can
  never see the _current_ user message's contribution — only history. The real workhorse is
  supposed to be `onAfterToolCall` (which, per the conversation-service comment, fires _after_
  tool results are appended). The lock bug kills both, but the `onBeforePrompt` registration is
  still structurally near-useless for the first message of any exchange.

- **Fallback context-window math is a footgun but not the bug.** `fallbackContextWindow`
  (compaction/index.ts:113-129) derives a window from `(system+fragment tokens) /
(softThreshold/100)`. If the Ollama probe resolves (it `GET /api/show` and reads
  `general.context_length` — ollama.ts:146-176, real probes for llama3.1 return 32768+,
  qwen/large models 131072+), `resolveContextWindow` returns the real number and compaction
  thresholds become sane. But you never reach that code because of the lock. So the fallback is
  fine; the gate never opens.

## What needs to happen

1. **Reset `compactionInFlight` on every exit path of `maybeCompact`, or (better) wrap
   `hookBody` in try/finally** so the flag is always cleared. This is the actual fix.
2. **Fix or delete the misleading test** — make it reuse the _same_ capture/plugin instance
   across the empty-then-nonempty calls so it actually verifies the lock releases.
3. Consider whether `onBeforePrompt` should even be registered, or whether `onAfterToolCall`
   (the documented mid-loop trigger) is sufficient. As written, `onBeforePrompt` only ever sees
   pre-current-message state and is redundant with the lock risk.

Want me to apply the fix (try/finally reset + corrected test)? That's a clean, contained
change to `compaction/index.ts` and `compaction.test.ts`.
