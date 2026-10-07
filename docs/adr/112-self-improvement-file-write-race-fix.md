---
tags: [decision, self-improvement, concurrency, bug-fix]
related: [concepts/self-improvement.md, modules/drone-agent-plugins.md, flows/tool-call-loop.md]
---

# ADR 112: Serialize Self-Improvement File Writes (Race Fix)

**Status**: Implemented (commit `95c6298`, 2026-08-10, branch `fix/self-improvement-insight-race`)

## Context

The self-improvement plugin's file storage engines (`recordInsight`, `storePrinciple`, `deletePrinciple` in `drone-agent/src/plugins/self-improvement/file-engine.ts`) performed **unsynchronized read-modify-write** on JSON files:

```ts
const entries = await readJsonArray<DroneInsightEntry>(filePath);  // read
entries.push({ timestamp, insight });                              // modify
await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8'); // write
```

Meanwhile, `drone-agent/src/runtime/conversation-service.ts` executes **all tool calls in a single assistant turn in parallel** via `Promise.all` (line ~419). When the LLM emitted multiple `self-improvement__insight`/`self-improvement__principle` calls targeting the **same file** in one turn, two or more calls each read the same old contents, pushed to their own in-memory copy, and clobbered each other on write. This produced:

- **Lost updates** — last-writer-wins, so only one insight survived
- **Corrupted JSON** — concurrent `writeFile` calls interleaved partial bytes

The same bug existed in `storePrinciple` and `deletePrinciple`.

## Decision

Apply two layers of protection to all three write sites:

### 1. In-process per-file mutex (`withFileLock`)

Added a dependency-free, keyed async mutex in `io.ts` that serializes operations sharing the same key (the file path). Different files use different keys, so unrelated writes still run in parallel — only same-file writes serialize:

```ts
const queues = new Map<string, Promise<unknown>>();
export async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}
```

The full read-modify-write cycle runs inside the lock, so concurrent same-file operations cannot interleave.

### 2. Atomic write (`writeJsonArrayAtomic`)

Added a tmp+rename helper so a crash mid-write cannot leave a truncated JSON file:

```ts
export async function writeJsonArrayAtomic<T>(filePath: string, entries: T[]): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}
```

This matters because `.drone-agent` is **not always checked into VCS** — there's no external safety net for these files, so the atomic write is the only protection against crash-truncation.

### Scope

- **Swarm/HTTP storage engines** (beacon/coordinator) were intentionally left untouched — they go over HTTP and are a separate path.
- **Cross-process safety** (multiple `drone-agent` instances on the same project) was explicitly scoped out; the in-process mutex covers the reported single-agent parallel-write race.

## Consequences

### Positive

- Concurrent `record`/`store`/`delete` calls to the same file no longer lose entries or corrupt JSON
- The atomic write protects against crash-truncation even when `.drone-agent` isn't in VCS
- No new runtime dependencies (both helpers are hand-rolled)

### Neutral

- Same-file writes are now serialized (slightly slower for the same-file case), but unrelated files still write in parallel

## Tests

`test/self-improvement/insight-concurrency.test.ts` (new file):

- 20 concurrent `record` calls to the same project file → valid JSON, exactly 20 entries, all distinct insights present
- 20 concurrent `store` calls to the same project file → valid JSON, 20 entries
- Mixed `store` + `delete` on the same principles file → valid JSON, expected count

**Behavioral proof**: stashing the source fix makes all 3 concurrency tests FAIL (lost updates + corrupted/missing JSON); restoring the fix makes them PASS — confirming both the diagnosis and that the tests guard the regression.

## Related

- [[concepts/self-improvement]] — The insight/principle system this hardens
- [[modules/drone-agent-plugins]] — The self-improvement plugin
- [[flows/tool-call-loop]] — Where tool calls run in parallel via `Promise.all`
