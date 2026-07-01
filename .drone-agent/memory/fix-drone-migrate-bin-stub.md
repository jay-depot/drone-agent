---
key: fix-drone-migrate-bin-stub
tags:
  []
created: 2026-07-01T03:04:44.292Z
updated: 2026-07-01T03:06:49.898Z
---

# Fix `drone-migrate` Standalone Bin Stub

## Problem
The `drone-migrate` bin stub at `drone-agent/bin/drone-migrate` just imports `../dist/migrate.js` and does nothing else. The `migrate.ts` module only exports `runMigrate()` — it has no self-invoking entry point. So `drone-migrate --list` exits silently with code 0.

The `drone-agent migrate --list` subcommand works because `index.tsx` handles the dispatch explicitly.

## Plan

### Step 1 — Update `drone-agent/bin/drone-migrate` to parse args and call `runMigrate()`
Replace the stub with one that imports `parseCliArgs` from `../dist/cli.js` and `runMigrate` from `../dist/migrate.js`, parses `process.argv.slice(2)`, and dispatches to `runMigrate()` when `kind === 'migrate'`.

### Step 2 — Verify the fix works
Run `pnpm build`, then test `node bin/drone-migrate --list`, `node bin/drone-migrate --type persona --id plan --to beacon`, and `node bin/drone-migrate` with no args.

### Step 3 — Run existing tests
`pnpm test -- migration.test.ts`

## Validation Criteria
- [x] `node bin/drone-migrate --list` prints migratable assets (not silent exit)
- [x] `node bin/drone-migrate` with no args prints usage and exits with code 1
- [x] `node bin/drone-migrate --unknown-flag` throws an error
- [x] `drone-agent migrate --list` still works (regression check)
- [x] All existing tests pass (807/807)
- [x] `pnpm typecheck` passes (pre-existing errors in unrelated test file)
- [x] `pnpm lint` passes (pre-existing errors in unrelated file)

## Summary of Work Completed
The fix was straightforward: the bin stub now prepends `'migrate'` to `process.argv.slice(2)` and calls `parseCliArgs`, which routes to `parseMigrateSubcommand`. When `kind === 'migrate'`, it calls `runMigrate()` with the parsed options. The `'migrate'` prefix is needed because `parseCliArgs` checks `argv[0] === 'migrate'` to route to the migrate subcommand parser — the standalone bin doesn't have that prefix naturally (unlike `drone-agent migrate --list` which does).