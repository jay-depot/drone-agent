---
key: fix-self-improvement-insight-race
tags:
  - bug
  - concurrency
  - self-improvement
  - plan
created: 2026-08-10T23:04:14.825Z
updated: 2026-08-10T23:04:14.825Z
---

# Plan: Fix race condition in self-improvement file storage

## Summary

The self-improvement plugin's file storage engines (recordInsight, storePrinciple, deletePrinciple in `drone-agent/src/plugins/self-improvement/file-engine.ts`) perform unsynchronized read-modify-write on JSON files. Since `drone-agent/src/runtime/conversation-service.ts` runs all tool calls in a turn via Promise.all (line 419), two `self-improvement__insight` record calls hitting the same file in one turn each read the same old contents, push to their own copy, and clobber each other — losing insights and corrupting JSON.

Fix (two layers):

1. In-process per-file mutex — serializes the read-modify-write so concurrent same-file writes can't interleave (fixes the race).
2. tmp+rename atomic write — write to .tmp then rename over target, so a crash mid-write can't truncate JSON. Needed because .drone-agent isn't always checked into VCS, so no external safety net.

Both applied to all three write sites. Dependency-free; reuse the convention already in `drone-agent/src/plugins/memory/store.ts`. Swarm/HTTP storage engines (beacon/coordinator) are OUT OF SCOPE — those go over HTTP and are separate.

## Branch

fix/self-improvement-insight-race (feature branch)

## Steps

### Step 1 — Add dependency-free per-file mutex (`src/plugins/self-improvement/io.ts`)

Keyed async mutex serializing ops sharing a key (file path). Promise chain per key + cleanup so the map doesn't leak:

```ts
const queues = new Map<string, Promise<unknown>>();
export async function withFileLock<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
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

Different files → different keys → unrelated writes still parallel; only same-file writes serialize.

### Step 2 — Add atomic JSON write helper (`src/plugins/self-improvement/io.ts`)

```ts
import { rename, writeFile } from 'node:fs/promises';
export async function writeJsonArrayAtomic<T>(
  filePath: string,
  entries: T[]
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}
```

### Step 3 — Harden recordInsight (`src/plugins/self-improvement/file-engine.ts`)

Wrap read-modify-write in withFileLock(filePath, ...) and use writeJsonArrayAtomic. Current:

```ts
await mkdir(insightsDir, { recursive: true });
const entries = await readJsonArray<DroneInsightEntry>(filePath);
entries.push({ timestamp: new Date().toISOString(), insight });
await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
return { ok: true, entryCount: entries.length };
```

### Step 4 — Harden storePrinciple (same file, same pattern)

Wrap read-modify-write in withFileLock(filePath, ...) and use writeJsonArrayAtomic.

### Step 5 — Harden deletePrinciple (same file)

Wrap in withFileLock(filePath, ...). Keep the rm(filePath) empty-list branch inside the lock (can't race a concurrent storePrinciple).

### Step 6 — Add concurrency tests (`test/self-improvement/insight-concurrency.test.ts`)

Mirror existing `test/self-improvement/setup.ts` createEngine harness. Drive via Promise.all([...]) to mirror conversation-service.

- Insights: 20 concurrent record calls, same project target → valid JSON, exactly 20 entries, all distinct insights present.
- Principles: 20 concurrent store calls, same target → valid JSON, 20 entries.
- Mixed delete + store on same principles file → valid JSON, expected count.

### Step 7 — Validate (final step)

- LSP: no new diagnostics on changed files (search config errors in log-plugin/prompt-file/terminal tests are pre-existing, unrelated).
- `pnpm -r run lint` zero errors.
- `pnpm -r run build` zero errors.
- `pnpm -r run test` passes incl. new concurrency tests.

## Validation Criteria

1. LSP passes on all changed files (no new diagnostics).
2. pnpm -r run lint — zero errors.
3. pnpm -r run build — zero errors.
4. pnpm -r run test passes, incl. insight-concurrency.test.ts.
5. Behavioral proof: concurrent record/store calls to the SAME file yield valid JSON with all entries preserved (previously lost updates / corrupted file).
6. All three write paths wrapped in per-file lock + atomic write.
7. No new runtime dependencies.

## Completion Summary (2026-08-10)

All steps implemented and validated on branch `fix/self-improvement-insight-race`.
Committed as `95c6298`.

**Implemented:**
- `withFileLock` per-key in-process mutex in `io.ts` (promise-chain + map cleanup).
- `writeJsonArrayAtomic` tmp+rename helper in `io.ts`.
- `recordInsight`, `storePrinciple`, and `deletePrinciple` in `file-engine.ts` now
  run their full read-modify-write under `withFileLock(filePath, ...)` and write
  via `writeJsonArrayAtomic`. The `rm` branch in `deletePrinciple` stays inside the
  lock so it cannot race a concurrent store.
- `test/self-improvement/insight-concurrency.test.ts`: 20 concurrent record calls
  and 20 concurrent store calls to the same file, plus a mixed store+delete test.

**Validation results (all pass):**
- LSP: no new diagnostics on changed files.
- `pnpm lint` zero errors (eslint + prettier --write; prettier reformatted the
  memory file, reverted unrelated pnpm-lock.yaml churn).
- `pnpm build` zero errors.
- `pnpm typecheck` passes.
- `pnpm test`: 1773 passed / 9 skipped.
- Self-improvement suite: 60/60 passed.
- Behavioral proof: stashing the source fix makes all 3 concurrency tests FAIL
  (lost updates + corrupted/missing JSON); restoring the fix makes them PASS.
  This confirms the tests reproduce the original race.

**Notes / scope:**
- Swarm/HTTP storage engines (beacon/coordinator) were intentionally left
  untouched — they go over HTTP and are a separate path.
- Cross-process safety (multiple drone-agent instances on the same project) was
  explicitly scoped OUT by the user; the in-process mutex covers the reported
  single-agent parallel-write race.
