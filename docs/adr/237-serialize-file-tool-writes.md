---
tags: [decision, file-plugin, concurrency, race-condition, bug-fix]
related:
  [
    112-self-improvement-file-write-race-fix.md,
    227-skills-wizard-persona-owned-targets.md,
    157-runtime-truth-context-windows.md,
  ]
---

# ADR 237: Serialize Per-File `file__apply_diff` / `file__write` Writes

**Status**: Implemented (2026-10-07, branch `fix/apply-diff-concurrency`)

## Context

`drone-agent/src/runtime/conversation-service.ts` executes every tool call in a
single assistant turn **in parallel** via `Promise.all` (`executeToolCalls()`).
`file__apply_diff` is a **read-modify-write**: it `readFile`s the whole file,
parses the patch, applies it in memory with `applyPatch`, then `writeFile`s the
whole file back. When the model emits two or more `file__apply_diff` calls
targeting the **same file** in one turn, they all read the same pre-state and the
**last writer wins** — the other hunks are silently lost, while every call still
truthfully reports `"patched": true`. The tool cannot see the lost update.

`file__write` has the same shape, and its read-back **verification** can be
corrupted by a sibling write landing between its write and its verify (yielding a
spurious `verified: false`).

The race was already recorded in swarm memory
(`drone-agent-concurrent-apply-diff-same-file-race`) and observed live in
[227-skills-wizard-persona-owned-targets](227-skills-wizard-persona-owned-targets.md)
(one truncated `skills/index.ts`, restored from git) and noted in
[157-runtime-truth-context-windows](157-runtime-truth-context-windows.md)
("parallel same-file patches race (last-writer-wins silent revert)").

The project already had a mechanism for exactly this class of bug:
[112-self-improvement-file-write-race-fix](112-self-improvement-file-write-race-fix.md)
introduced `withFileLock` — a dependency-free, **per-key** async promise-chain
mutex — to serialize the self-improvement plugin's same-file read-modify-write.

## Decision

Reuse and generalize `withFileLock`, and apply it to the file plugin's two
mutating tools.

1. **Extract the helper.** `withFileLock` moves out of the self-improvement
   plugin's private `io.ts` into **`drone-agent/src/shared/file-lock.ts`**. The
   self-improvement call sites (`file-engine.ts`) import it from the new shared
   module; there is **no re-export** in `io.ts`, so there is exactly one home.
   ADR 112's decision remains valid — only the helper's location changes.
2. **Add a path-keyed wrapper.** The shared module also exports
   `withPathLock(filePath, task)`, which keys on
   `path.resolve(filePath).toLowerCase()`. Lower-casing collapses case-variant
   spellings on case-insensitive filesystems; on case-sensitive filesystems it
   only over-serializes the rare pair of paths differing solely by case — it can
   lose parallelism, never correctness. No runtime case-sensitivity probe and no
   `realpath`/symlink resolution (the extra machinery would not pay for itself,
   and `realpath` fails for a file `write` is about to create).
3. **Lock both mutating tools.** `file__apply_diff` and `file__write` wrap their
   **entire** read-modify-write span in `withPathLock` — for `write` that
   includes the verification read-back; for `apply_diff` it spans
   `readFile` → `parseUnifiedDiff` → `applyPatch` → `writeFile`. Locking only the
   write would not help: each call would still compute its patch against a stale
   read. Both tools share one key namespace, so a `write` and an `apply_diff` on
   one path also serialize against each other.
4. **Reads stay unlocked.** `file__read`, `file__read_image`, `file__list`, and
   `file__glob` take no lock and remain fully parallel.
5. **Always on.** No config field, no toggle. The lock is correctness, not a
   tunable; different files still run in parallel, so cross-file batching is
   unaffected.
6. **In-process only.** Matches ADR 112's scope: the reported bug is a single
   agent emitting parallel calls in one turn. Cross-process (two `drone-agent`
   processes on one repo) needs an FS advisory lock with stale-lock recovery and
   remains out of scope.
7. **Silent.** No notice or event is emitted on lock contention. Serialization
   preserves every requested edit, so there is nothing surprising for the model
   to reconcile; the per-call results already report accurately.
8. **Tool-site, not a runtime concept.** The lock lives inside each tool's
   `execute` body. A generic `serializeBy`/exclusive-tool field on
   `DroneToolDefinition` was considered and **deferred** — it would touch
   `drone-core`, `plugin-engine.executeTool`, and `conversation-service`'s
   `executeToolCalls`, a shared-interface change with a large blast radius for no
   additional coverage here (self-improvement already had a lock; the
   memory/swarm stores route through HTTP/DB, not local read-modify-write).

## Consequences

### Positive

- Concurrent same-file `apply_diff` calls no longer lose hunks; all requested
  edits survive.
- Concurrent same-file `write` calls no longer report spurious
  `verified: false` — the verify read-back is inside the lock.
- One shared mutex implementation, used by both the file and self-improvement
  plugins.
- `file.test.ts` (1168 lines) is split into `test/file/` topic files, all under
  the project's size limits.

### Neutral

- Same-path same-turn edits now serialize (a small latency cost); different
  files stay parallel.
- A `write` and an `apply_diff` to one path serialize against each other.
- On case-sensitive filesystems, two genuinely distinct paths differing only by
  case are over-serialized (loses parallelism, never correctness).

### Out of scope

- Cross-process safety.
- A generic runtime-level "exclusive tool" / `serializeBy` concept.

## Tests

- **`test/file/concurrency.test.ts` (new, 8 tests).**
  - Helper unit tests: same-key tasks serialize (`maxActive === 1`), different
    keys run in parallel (`maxActive === 2`), a throwing task still releases the
    key, and `withPathLock` collapses dot-segments and case variants of one path.
  - Integration regression tests: 6 concurrent `apply_diff` calls on one file
    preserve all 6 edits; 8 concurrent `write` calls all report `verified: true`;
    concurrent `apply_diff` calls to _different_ files are independent; a
    concurrent `write` + `apply_diff` on one path leaves one coherent version.
- **`test/file/` split (from `test/file.test.ts`).** `setup.ts` (shared
  `makeHunk`/`captureRegistration`), `file-plugin.test.ts` (14 tests),
  `patch-applier.test.ts` (21), `apply-diff.test.ts` (8). The original
  1168-line file was deleted; its 43 tests are preserved verbatim.

### RED → GREEN proof

With the source fix reverted (tools unwrapped; only the shared helper module
present so the test file imports), the same-file integration tests **fail**:

```
✕ preserves every concurrent apply_diff to the same file
    expect(content).toContain("item_0")   ← only item_5 (last writer) survived
✕ reports verified: true for every concurrent write to the same file
    expected false to be true
```

With the fix applied, all 8 tests **pass**.

### Behavioral check

Three `file__apply_diff` calls to one file issued in parallel (one turn):
all three report `patched: true` and the final file contains **all three**
hunks (pre-fix, only one survived).

## Validation

- **LSP**: clean — zero errors/warnings on every touched file and the workspace.
- **`pnpm typecheck`**: exit 0.
- **`pnpm -r run build`**: exit 0 (8 packages).
- **`pnpm run lint`**: exit 0 (ESLint + Prettier).
- **`pnpm run test`**: **3680 passed / 14 skipped / 0 failed** (271 files passed,
  3 skipped). `test/file/` contributes 51 tests (43 relocated + 8 new).
- **No new config surface**: no `drone-core` config type, schema, default, or
  allowlist entry was added.
- **Single home**: `grep -rn withFileLock drone-agent/src` shows the definition
  only in `src/shared/file-lock.ts`, with imports at
  `plugins/self-improvement/file-engine.ts` and the `withPathLock` wrapper.

### Notes on process

- **Step-ordering deviation (documented).** The plan placed the concurrency test
  file (Step 3) before the shared helper module (Step 4). The test imports the
  helper, so the module was created first; the RED gate was then observed by
  running the tests with the helper present but the tools unwrapped. Net effect
  is unchanged: the integration tests were proven to fail pre-fix and pass
  post-fix.
- **Pre-existing flake.** `test/self-improvement/` intermittently fails under
  full-suite file-parallelism (`ENOENT`/`ENOTEMPTY` on `Date.now()`-named temp
  dirs combined with `process.chdir`), varying 3–10 failures run to run. It fails
  identically with this change stashed, so it is not caused by the lock move. The
  full fast suite passed cleanly on the validation run; the flake was not
  touched.
- **Prettier reflow.** The first pass of the tool-site wraps was applied with
  fuzzy diff patches; because `read` and `write`/`apply_diff` share identical
  line patterns, the anchors mis-targeted. The wraps were re-applied with
  uniquely-anchored context, then Prettier normalized the indentation.

## Related

- [112-self-improvement-file-write-race-fix](112-self-improvement-file-write-race-fix.md)
  — origin of `withFileLock`, the reused mechanism.
- [227-skills-wizard-persona-owned-targets](227-skills-wizard-persona-owned-targets.md)
  — live observation of the same-file patch race.
- [157-runtime-truth-context-windows](157-runtime-truth-context-windows.md) —
  process note on the parallel same-file patch race.
- [046-tui-tail-region-refactor](046-tui-tail-region-refactor.md) — why tool
  calls run in parallel via `Promise.all`.
