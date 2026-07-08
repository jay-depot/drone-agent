---
key: git-plugin-overhaul
tags:
  - git
  - plugin
  - bug
  - refactor
created: 2026-07-08T18:17:39.489Z
updated: 2026-07-08T15:05:00.000Z
---

# git plugin overhaul — review fix cycle

Original refactor (`3610a813`) split the single-file git plugin into a `git/`
folder with 11 tools + TUI render components and fixed the porcelain
staged/unstaged classification bug. A follow-up code review found the
"report what changed" layer was built on a category error; those fixes were
applied in commit after `1ca2e67`.

## Bugs fixed (verified against real git output)

1. **add.ts returned empty file paths.** It fed `git diff --cached --name-status`
   (TAB-separated `M\tf.txt`) into `nameStatusToItems`, which split on the
   first SPACE — so `path` resolved to `""`. The AddBlock/TUI rendered bullets
   with no filename. FIX: `nameStatusToItems` now splits on `\t` (matching the
   `--name-status` format) and handles rename/copy as removed(old)+added(new)
   pairs. Covering unit tests in `test/git-name-status.test.ts`.

2. **restore.ts mislabeled untracked / showed rename arrows.** It fed
   `git status --porcelain=v1` (space-separated, `??`, `R  a -> b`) into
   `nameStatusToItems`, which expects `--name-status`. An untracked file came
   out as `{ kind: 'modified', path }`. FIX: restore.ts now runs
   `git diff --name-status` (post-restore) instead of porcelain. stash.ts
   already did this correctly and was left as the reference.

3. **add with no args silently ran `git add -u`** (staged the whole tree),
   contradicting the "never silent git add -A" discipline applied to commit.
   FIX: add now requires either `paths` or `all:true`; otherwise it throws.

4. **restore silently reinterpreted `staged:true + discard:true`** as
   "unstage only", dropping the user's explicit (irreversible) discard intent.
   FIX: the contradictory combo now throws.

## Quality fixes

5. `asPaths` was copy-pasted across commit/restore/stash — moved to `run-git.ts`
   as a shared helper; the three local copies removed.

6. Dead code removed from `parse-porcelain.ts`: the hardcoded `branch: ''`
   field (branch is resolved separately via `rev-parse` in status.ts) and the
   unused `porcelainLines()` export. `entries`/`PorcelainEntry` retained
   (used by porcelain unit tests).

7. `FetchPullBlock` discarded the git output on success (it was captured into
   `explanation` by fetch/pull tools but only rendered on failure). Now shows
   `explanation` on both success and failure.

8. Minor: `StatusBlock` now defensively guards the `staged`/`unstaged`/
   `untracked` arrays against malformed JSON.

## Validation

- `test/git-plugin.test.ts` (13 tests) — added assertions on returned `files`
  paths, the add throw behavior, the restore staged-name-status correctness
  (untracked not mislabeled), and the contradictory-combo throw.
- `test/git-name-status.test.ts` (5 tests, new) — direct `nameStatusToItems`
  coverage including the porcelain-mislabel regression.
- Full suite: 1300 tests pass. `tsc -b` clean.
