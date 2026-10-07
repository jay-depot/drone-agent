---
key: plan-serialize-file-tool-writes
tags:
  - plan
  - drone-agent
  - file-plugin
  - concurrency
  - race-condition
  - bug-fix
  - apply-diff
  - file-lock
created: 2026-10-07T03:53:49.066Z
updated: 2026-10-07T03:53:49.066Z
---

# Plan: Serialize per-file `file__apply_diff` / `file__write` (parallel-patch race fix)

**Status:** ready for execution. All design decisions are settled (see "Decisions" table). Do not re-litigate them; implement as written.

## 1. Summary — what and why

**Bug.** `drone-agent/src/runtime/conversation-service.ts` executes every tool call in a single assistant turn **in parallel** via `Promise.all` (`executeToolCalls()`, the `const rawResults = await Promise.all(...)` at ~line 821). `file__apply_diff` is a **read-modify-write**: it `readFile`s the whole file, parses the patch, applies it in memory with `applyPatch`, then `writeFile`s the whole file back. When the model emits two or more `file__apply_diff` calls targeting the **same file** in one turn, they all read the same pre-state and the **last writer wins** — the other hunks are silently lost, while every call still truthfully reports `"patched": true` (the tool cannot see the lost update). `file__write` has the same shape (and its read-back verification can be corrupted by a sibling write landing between its write and its verify).

This exact bug is already documented in swarm memory (`drone-agent-concurrent-apply-diff-same-file-race`) and was observed live in ADR 227 (`docs/adr/227-skills-wizard-persona-owned-targets.md`, ~line 98) and ADR 157 (~line 121).

**Fix.** Reuse the existing per-key async mutex `withFileLock` (ADR 112, `docs/adr/112-self-improvement-file-write-race-fix.md`) — the mechanism already used to force concurrent same-file read-modify-write into series in the self-improvement plugin. Generalize it into a shared module, add a path-keyed convenience wrapper, and wrap the full read-modify-write span of `file__write` and `file__apply_diff` in it. Reads (`read`, `read_image`, `list`, `glob`) are **not** locked and stay fully parallel.

**Deferred (explicitly out of scope):** cross-process safety (two `drone-agent` processes on one repo — ADR 112 scoped this out too); a generic runtime-level "exclusive tool" / `serializeBy` field on `DroneToolDefinition` (a much larger shared-interface change; not needed here).

## 2. Decisions (settled)

| # | Decision |
|---|----------|
| D1 | Reuse the existing `withFileLock` keyed promise-chain mutex. |
| D2 | Lock **both** `apply_diff` and `write`, keyed by resolved absolute path. |
| D3 | Extract `withFileLock` to a **new** `drone-agent/src/shared/file-lock.ts`; repoint the self-improvement call sites' import directly at the new module; **delete** the old definition from `self-improvement/io.ts` (no re-export — exactly one home). |
| D4 | Lock key = `path.resolve(input.path.trim()).toLowerCase()`. **No** runtime case-sensitivity probe, **no** `realpath`/symlink resolution. Helper exports both `withFileLock(key, task)` (raw key) and `withPathLock(filePath, task)` (resolves + lower-cases). |
| D5 | **Always on.** No config field, no toggle. |
| D6 | **In-process only** (matches ADR 112). |
| D7 | New dedicated concurrency test file (do not add to the huge `file.test.ts`). |
| D8 | Split the 1168-line `test/file.test.ts` into a new `test/file/` directory (mirrors the `test/self-improvement/` precedent). Split is a **separate commit before the fix**. Then **delete** `test/file.test.ts`. |
| D9 | Write `docs/adr/237-serialize-file-tool-writes.md` + add the row to `docs/adr/index.md`. |
| D10 | Wrap the **entire** read-modify-write span in each tool (including `file__write`'s verify read-back). Reads take no lock. |
| D11 | Tool-site lock (inside the `execute` bodies), **not** a generic runtime mechanism. |
| D12 | **Silent** — no notice/observability emitted on lock contention. |

## 3. Exact implementation steps (ordered)

> Follow in order. Steps 1–3 are the pure test-refactor commit; steps 4–8 are the fix. Run the per-step checks noted; run the full validation (§5) at the end.

### Step 0 — Read the target files first (no edits)
Read, in full, before touching anything:
- `drone-agent/src/plugins/self-improvement/io.ts`
- `drone-agent/src/plugins/self-improvement/file-engine.ts` (import block + the 4 `withFileLock` sites: lines ~49, ~135, ~173, ~264)
- `drone-agent/src/plugins/file.ts` (the `write` and `apply_diff` `execute` bodies)
- `drone-agent/test/file.test.ts` (all 1168 lines)
- `drone-agent/test/self-improvement/setup.ts` (the split precedent's shared-setup shape)

### Step 1 — Create the `test/file/` shared setup
**New file:** `drone-agent/test/file/setup.ts`
Move, verbatim, from `test/file.test.ts`:
- The imports block (lines ~1–16).
- `makeHunk()` (lines ~25–30) — export it.
- `captureRegistration()` (lines ~31–103) — export it **and** export an explicit return type so the split files can import it cleanly. Keep the exact registration mock (all hooks stubbed, `toToolResultContent` wrapper).
Also export the `PatchHunk`/`ChangeZoneLine` re-imports if the split files need them, or import them directly in each file.

### Step 2 — Split `test/file.test.ts` into topic files
Create four files in `drone-agent/test/file/`, moving the describes verbatim (adjust only imports to pull helpers from `./setup.js`):

| New file | Moves these `describe` blocks (original line ranges) |
|---|---|
| `file-plugin.test.ts` | `enhanceFsError` (105–171); `file plugin — read_image structured result` (172–239); `file plugin — error surfacing` (240–307); `file plugin — read/write round trip` (308–347) |
| `apply-diff.test.ts` | `file__apply_diff — round-trip integration` (861–1168) |
| `patch-applier.test.ts` | `applyPatch — basic operations` (348–483); `… fuzzy matching` (484–566); `… error handling` (567–656); `… multiple hunks` (657–747); `… edge cases` (748–800); `… lineHint tie-breaking` (801–823); `… interleaved context` (824–860) |
| `concurrency.test.ts` | **new** — two empty placeholder `describe` blocks are NOT needed; create this file in Step 3. |

Each file: self-contained imports (`vitest`, `node:fs/promises`, `node:os`, `node:path`, `drone-core`, `../src/plugins/file.js`, and `./setup.js`).

Then **delete** `drone-agent/test/file.test.ts`.

**Check after Step 2:** `pnpm --filter drone-agent test` (or root `pnpm test`) — the suite must be green with the same test count as before the split (no behavior change, just relocation).

### Step 2b — Commit the split on its own
Commit message, e.g.: `refactor(test): split file.test.ts into test/file/ topic files`. This is a separate, revertable commit **before** any fix (so the new concurrency test can be shown failing pre-fix and passing post-fix).

### Step 3 — Write the failing concurrency regression tests (RED)
**New/complete file:** `drone-agent/test/file/concurrency.test.ts`

Two top-level `describe` blocks:

**(A) `withFileLock / withPathLock (shared/file-lock)`** — unit tests for the helper:
```ts
import { describe, expect, it } from 'vitest';
import { withFileLock, withPathLock } from '../src/shared/file-lock.js';

describe('withFileLock / withPathLock', () => {
  it('serializes same-key tasks and never overlaps them', async () => {
    let active = 0;
    let maxActive = 0;
    const task = () => withFileLock('key-a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);           // serialized
  });

  it('lets different keys run in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const task = (key: string) => withFileLock(key, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([task('k1'), task('k2')]);
    expect(maxActive).toBe(2);           // not serialized across keys
  });

  it('releases the key when a task throws', async () => {
    await expect(withFileLock('k', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(withFileLock('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('withPathLock collapses case variants and dot-segments of one path', async () => {
    const order: string[] = [];
    await Promise.all([
      withPathLock('/tmp/A/../a.ts',  async () => { order.push('first');  await new Promise(r => setTimeout(r, 5)); order.push('first-done'); }),
      withPathLock('/tmp/a.TS',       async () => { order.push('second'); }),
    ]);
    // serialized ⇒ no interleaving
    expect(order).toEqual(['first', 'first-done', 'second']);
  });
});
```

**(B) `file tools — same-path serialization`** — integration regression tests via the real plugin tools (use `captureRegistration()` from `./setup.js`, then `filePlugin.register(registration)`):
```ts
it('preserves every concurrent apply_diff to the same file', async () => {
  const { registration, tools } = captureRegistration();
  await filePlugin.register(registration);
  const applyDiff = tools.get('apply_diff')!;

  const target = path.join(tmpdir(), `drone-agent-race-${Date.now()}.txt`);
  await writeFile(target, 'START\nEND\n', 'utf-8');
  try {
    const N = 6;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        applyDiff({
          path: target,
          patch: `@@ -1,2 +1,3 @@\n START\n+item_${i}\n END`,
        })
      )
    );
    const content = await readFile(target, 'utf-8');
    for (let i = 0; i < N; i++) expect(content).toContain(`item_${i}`);  // ALL edits survive
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(target).catch(() => {});
  }
});

it('leaves concurrent same-path writes with verified: true (no read-back race)', async () => {
  const { registration, tools } = captureRegistration();
  await filePlugin.register(registration);
  const write = tools.get('write')!;

  const target = path.join(tmpdir(), `drone-agent-wrace-${Date.now()}.txt`);
  await writeFile(target, 'seed\n', 'utf-8');
  try {
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        write({ path: target, content: `payload_${i}\n` })
      )
    );
    for (const r of results) expect(JSON.parse(r).verified).toBe(true);
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(target).catch(() => {});
  }
});

it('still runs concurrent apply_diff to DIFFERENT files in parallel', async () => {
  // no accidental global lock: N distinct paths should overlap
  // (assert via a maxActive-style counter is not possible through tools; instead
  //  assert all N succeed and both files contain their own edit)
});

it('serializes a concurrent write + apply_diff on the same path without corruption', async () => {
  // launch a write and several apply_diffs of the same path; assert the file is
  // valid (one coherent version) and every call that reported success is visible
});
```
**Check after Step 3 — this is the RED gate:** with the fix **not yet applied**, the first two tests must **fail** (the same-file `apply_diff` batch loses edits; the write batch yields `verified:false`). Confirm they fail, then proceed. (Mirror ADR 112's "stash the fix → tests fail → restore → tests pass" proof.)

### Step 4 — Create the shared lock module (GREEN)
**New file:** `drone-agent/src/shared/file-lock.ts`
```ts
import path from 'node:path';

/**
 * Per-key promise chains that serialize operations sharing the same key.
 * Different keys run in parallel; only same-key operations queue up, so
 * concurrent read-modify-write cycles on the same resource cannot interleave.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Serialize async operations that share the same key (e.g. a file path).
 */
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

/**
 * Serialize async operations that share the same file, keyed by the resolved
 * absolute path, lower-cased so case-variant spellings collapse on
 * case-insensitive filesystems. On case-sensitive filesystems this only
 * over-serializes the rare pair of paths differing solely by case — it can
 * lose parallelism, never correctness.
 */
export function withPathLock<T>(
  filePath: string,
  task: () => Promise<T>
): Promise<T> {
  return withFileLock(path.resolve(filePath).toLowerCase(), task);
}
```

### Step 5 — Move `withFileLock` out of the self-improvement plugin
**Edit `drone-agent/src/plugins/self-improvement/io.ts`:**
- Delete the `const queues = new Map<string, Promise<unknown>>()` line, its `/** Per-key promise chains … */` comment, and the `withFileLock` function.
- Keep `writeJsonArrayAtomic`, `readJsonArray`, `scanJsonDir` (unchanged). Keep the `rename` import (still used by `writeJsonArrayAtomic`).
- If `path` is now unused in `io.ts`, drop the `import path from 'node:path'` too (it is still used by `scanJsonDir`, so likely keep).

**Edit `drone-agent/src/plugins/self-improvement/file-engine.ts`:**
- Remove `withFileLock` from the `from './io.js'` import block (line ~17).
- Add `import { withFileLock } from '../../shared/file-lock.js';`
- The four call sites (lines ~49, ~135, ~173, ~264) are unchanged.

**Check after Step 5:** typecheck + self-improvement suite green. `insight-concurrency.test.ts` must still pass (it exercises the same mutex via the plugin).

### Step 6 — Lock the `file__write` execute body
**Edit `drone-agent/src/plugins/file.ts`:** add `import { withPathLock } from '../shared/file-lock.js';`

Wrap the whole body **after** the arg validation and `filePath` resolution, i.e. the write + verify + result return:
```ts
const filePath = path.resolve(input.path.trim());
return withPathLock(filePath, async () => {
  try {
    await writeFile(filePath, input.content, 'utf-8');
  } catch (err) {
    throw enhanceFsError('file__write', filePath, err);
  }

  // Verify the write by reading back and comparing.
  let verified = true;
  let verificationError: string | undefined;
  try {
    const written = await readFile(filePath, 'utf-8');
    if (written !== input.content) {
      verified = false;
      verificationError = `Content mismatch: wrote ${input.content.length} bytes but read back ${written.length} bytes`;
    }
  } catch (err) {
    verified = false;
    verificationError = `Could not verify: ${err instanceof Error ? err.message : String(err)}`;
  }

  return JSON.stringify(
    { path: filePath, written: true, verified, verificationError },
    null,
    2
  );
});
```
(Arg validation stays **outside** the lock so a bad call does not occupy a queue slot.)

### Step 7 — Lock the `file__apply_diff` execute body
**Edit `drone-agent/src/plugins/file.ts`:** wrap everything after `const filePath = path.resolve(input.path.trim());` in `withPathLock(filePath, async () => { … })` — that is, **inside** the lock: `readFile` → `content.split('\n')` → `parseUnifiedDiff` → the empty-hunks throw → `applyPatch` → the diff-hunk build → `renderDiffV2` → the conditional `writeFile` → the partial-failure throw → the success `JSON.stringify` return. Do not lock the two arg-validation throws (they precede `filePath`).

Keep the existing `enhanceFsError('file__apply_diff', …)` wrapping on the read and the write. Every throw path propagates out of the lock and releases the key via `withFileLock`'s `finally`.

Apply the same pattern for both tools so a `write` and an `apply_diff` on the same path mutually serialize (they share the same key namespace).

**Check after Step 7:** the Step-3 concurrency tests now pass (GREEN).

### Step 8 — ADR
**New file:** `docs/adr/237-serialize-file-tool-writes.md` — frontmatter `tags: [decision, file-plugin, concurrency, race-condition, bug-fix]`, `related: [112-self-improvement-file-write-race-fix.md, 227-skills-wizard-persona-owned-targets.md, 157-runtime-truth-context-windows.md]`. Content must cover:
- **Context:** the parallel `Promise.all` tool loop + `apply_diff`'s read-modify-write; the silent lost-update (`patched:true` on every call, only the last write survives); the `file__write` verify-race.
- **Decision:** reuse ADR 112's `withFileLock`; extract it to `src/shared/file-lock.ts` (112's helper *home* moves; 112's decision stays valid — say so explicitly); add `withPathLock` (resolve + lower-case, no probe/realpath); lock both mutating file tools over the full RMW span; reads unlocked; always-on; in-process only; silent; tool-site (not a generic runtime `serializeBy`).
- **Consequences:** same-path same-turn edits now serialize (slight latency), different files stay parallel; concurrent same-file patches no longer lose hunks; `verified:false` read-back races eliminated; cross-process and a generic exclusive-tool field remain out of scope.
- **Tests:** name the new files and the RED/GREEN proof (fix stashed ⇒ the same-file tests fail; restored ⇒ pass).
- **Validation:** record the actual LSP/build/lint/test results from §5.

**Edit `docs/adr/index.md`:** append a `| [237-serialize-file-tool-writes](237-serialize-file-tool-writes.md) | <one-line summary> |` row.

### Step 9 — Commit
Commit the fix + ADR (the test split from Step 2b is its own earlier commit). Since this is a feature branch and `.drone-agent/` contents (this plan memory, any insights) are intentionally version-controlled, include them in a final commit **after** logging insights (per AGENTS.md). Do not commit memories/insights to `main`.

## 4. Files touched

**New**
- `drone-agent/src/shared/file-lock.ts`
- `drone-agent/test/file/setup.ts`
- `drone-agent/test/file/file-plugin.test.ts`
- `drone-agent/test/file/apply-diff.test.ts`
- `drone-agent/test/file/patch-applier.test.ts`
- `drone-agent/test/file/concurrency.test.ts`
- `docs/adr/237-serialize-file-tool-writes.md`

**Modified**
- `drone-agent/src/plugins/file.ts` (wrap two execute bodies; add import)
- `drone-agent/src/plugins/self-improvement/io.ts` (remove `withFileLock` + `queues`)
- `drone-agent/src/plugins/self-improvement/file-engine.ts` (repoint import)
- `docs/adr/index.md` (add 237 row)

**Deleted**
- `drone-agent/test/file.test.ts`

## 5. Validation criteria (the plan's final step MUST check all of these)

Run, in order, from the repo root:

1. **LSP clean** — `lsp.get_diagnostics` for every touched `.ts` file (and the workspace) reports **zero errors/warnings**. No exceptions for test files or files "not part of the change".
2. **Typecheck** — `pnpm typecheck` exits 0.
3. **Build** — `pnpm -r run build` exits 0. (Required because `drone-core` types are resolved from `dist/` by dependents; run this before trusting LSP in dependent packages if any core type were touched — none are touched here, but run it anyway per the standard.)
4. **Lint** — `pnpm run lint` exits 0 (ESLint then Prettier). **After it runs, re-read every touched file before further edits**, because Prettier reformats. Ensure the new files match project style (no stray comments, no dead code, no single-word step comments).
5. **Fast test suite** — `pnpm run test` exits 0 with **zero failures**; confirm the split preserved the original test count and that `test/file/concurrency.test.ts` contributes the new tests.
6. **Regression proof (RED→GREEN)** — with the source fix reverted/stashed, the same-file concurrency tests in `test/file/concurrency.test.ts` **fail**; with the fix applied, they **pass**. Record both observations in the ADR.
7. **Behavioral check** — after the fix, issue 3 `file__apply_diff` calls to one file in a single turn (or a scripted equivalent) and verify with `git diff --stat` / a re-read that **all three** edits are present (the pre-fix symptom was only one).
8. **No config surface added** — confirm no new `drone-core` config type/schema/default/allowlist entry was introduced (D5).
9. **Single home for the mutex** — `grep -rn "withFileLock" drone-agent/src` shows the definition only in `src/shared/file-lock.ts` and imports at the self-improvement + file call sites; no re-export remains in `self-improvement/io.ts`.

All nine must pass before the plan is "done".

## 6. References
- `docs/adr/112-self-improvement-file-write-race-fix.md` — origin of `withFileLock` (the reuse target).
- `docs/adr/227-skills-wizard-persona-owned-targets.md` (~L98) and `docs/adr/157-runtime-truth-context-windows.md` (~L121) — live observations of the same-file patch race.
- Swarm wiki `drone-agent-concurrent-apply-diff-same-file-race` — the bug write-up.
- Swarm wiki `drone-agent-tool-call-serialization-mechanisms` — the full inventory of serialization mechanisms (and the confirmed absence of a generic exclusive-tool concept).
- Swarm wiki `drone-agent-file-apply-diff-tool-internals` — the apply_diff read→patch→write internals + result contract.
- `test/self-improvement/` — the test-split precedent (session `agent-1783380256406`).

---

## Completion Summary (implemented 2026-10-07, branch `fix/apply-diff-concurrency`)

**Status: COMPLETE — all 12 decisions implemented, all 9 validation criteria pass.**

Commits:
- `dc290c79` — `refactor(test): split file.test.ts into test/file/ topic files` (Step 2b, pre-fix).
- `751cafad` — `fix(file): serialize per-file apply_diff/write to stop parallel patch race (#237)`.

### What was done
- **Extracted** `withFileLock` from `plugins/self-improvement/io.ts` to the new
  `src/shared/file-lock.ts` (no re-export; one home). Repointed
  `self-improvement/file-engine.ts` to the shared module. Added `withPathLock(filePath, task)`
  keyed on `path.resolve(filePath).toLowerCase()`.
- **Wrapped** the full read-modify-write span of `file__write` (write → verify read-back)
  and `file__apply_diff` (read → parse → `applyPatch` → write) in `withPathLock`. Reads
  (`read`/`read_image`/`list`/`glob`) stay unlocked. Always-on, in-process, silent, tool-site.
- **Split** the 1168-line `test/file.test.ts` into `test/file/`: `setup.ts`,
  `file-plugin.test.ts` (14), `patch-applier.test.ts` (21), `apply-diff.test.ts` (8) —
  43 tests preserved verbatim.
- **Added** `test/file/concurrency.test.ts` (8 tests): helper unit tests (`maxActive`
  serialization, throw-releases-key, `withPathLock` normalization) + integration
  regressions (6 concurrent same-file `apply_diff` all survive; 8 concurrent `write` all
  `verified: true`; different files independent; mixed `write`+`apply_diff` coherent).
- **Wrote** `docs/adr/237-serialize-file-tool-writes.md` + index row.

### Validation results
1. LSP clean on every touched file + workspace.
2. `pnpm typecheck` exit 0. 3. `pnpm -r run build` exit 0 (8 packages).
4. `pnpm run lint` exit 0. 5. `pnpm run test` — **3680 passed / 14 skipped / 0 failed**
   (271 files; `test/file/` contributes 51).
6. RED→GREEN proof recorded in the ADR (pre-fix the same-file tests fail: only the last
   `apply_diff` survives; `verified:false` for concurrent writes).
7. Behavioral check: 3 parallel same-file `apply_diff` → all 3 hunks present, all report
   `patched:true`.
8. No new config surface. 9. Single home for `withFileLock`.

### Plan deviations (documented in the ADR)
- **Step ordering:** the plan put the concurrency test file (Step 3) before the shared helper
  module (Step 4), but the test imports the helper. The module was created first; the RED gate
  was observed with the helper present and the tools unwrapped. Net effect identical.
- **Prettier churn:** `pnpm run lint` reformats repo-wide and reformatted 218 unrelated files
  (all ADRs, READMEs, `pnpm-lock.yaml`) — a pre-existing repo-hygiene drift (the tree was
  git-clean but not Prettier-clean at session start; `docs/adr/index.md` fails `prettier
  --check` at HEAD too). The unrelated churn was reverted so the commit is scoped to the plan's
  files; only my own files were kept.
- **Pre-existing flake:** `test/self-improvement/` intermittently fails under full-suite
  file-parallelism (`ENOENT`/`ENOTEMPTY` on `Date.now()`-named temp dirs + `process.chdir`),
  varying 3–10 failures run to run. It fails identically with this change stashed → not caused
  by the lock move. The full fast suite passed cleanly on the validation run.
