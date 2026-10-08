---
tags: [decision, tui, performance, react, node-env, docker, memory-leak]
related:
  [
    modules/drone-agent-tui.md,
    modules/drone-agent.md,
    decisions/001-use-ink.md,
    decisions/036-ink-6-react-19.md,
    decisions/154-bin-shims-replace-entry-gates.md,
    decisions/171-codeql-reenable-in-source-dismissal.md,
  ]
---

# 178: TUI User Timing perf-buffer drain + `NODE_ENV=production` defaults

**Status**: Implemented (2026-08-30, branch `fix/perf-entry-buffer-leak`, commits `444dc09`, `d2676f8`); merged to `main` via PR #86 (squash `e5b80cf`, 2026-08-30)

## Context

Long-lived TUI sessions trigger Node's
`MaxPerformanceEntryBufferExceededWarning` and accumulate unreclaimable memory.
Root cause: **react-reconciler's development build** (loaded whenever
`NODE_ENV !== 'production'`) records a `performance.measure` entry for _every
component render/commit and never clears them_. Node's global User Timing
buffer caps at **1,000,000 entries**; a long-lived Ink TUI session — which
re-renders on every streamed chunk — reaches that cap through ordinary
streaming re-renders. No code recursion is involved; the growth is purely the
reconciler's instrumentation.

The reconciler build is selected by `process.env.NODE_ENV` at module-load
time, and nothing in the repo set it: a bare `bin/drone-agent` launch and the
shipped Docker images all ran the dev build (with its instrumentation) by
default.

## Decision

Two complementary fixes, production-first:

**1. `NODE_ENV=production` by default** so end users get the production
reconciler (which carries no instrumentation at all):

- `bin/drone-agent` and `bin/drone-migrate` shims: set
  `NODE_ENV='production'` **only when `process.env.NODE_ENV === undefined`**
  and **before the first import of `dist/`** — react-reconciler branches on
  the variable at module load, so the shim is the only safe place (nothing
  later can change the already-selected build). End users get the production
  reconciler with zero configuration; an explicit `NODE_ENV=development` (or
  any explicit value) still wins, so test harnesses and debugging sessions
  keep dev warnings. `drone-migrate` gets the same default for consistency.
- `docker/drone-agent.Dockerfile` and `docker/drone-beacon.Dockerfile`:
  `ENV NODE_ENV=production`, a belt-and-suspenders for container launches
  that bypass the shim (e.g. `node dist/index.js`). The **test-runner image
  intentionally stays in dev mode** — vitest/React dev warnings are wanted
  there.

**2. `usePerformanceDrain` hook** (`drone-agent/src/tui/hooks/usePerformanceDrain.ts`,
mounted in `App()` before the window-size hook) — bounds buffer growth in any
environment, dev sessions included: an interval timer (default 60s) checks
`performance.getEntriesByType('measure').length` and calls
`performance.clearMeasures()` **only once the count crosses
`MAX_MEASURES = 100_000`** (~10% of Node's 1M-entry cap). Guards make the
hook a no-op where `performance`/`clearMeasures` don't exist. Cost per tick
is proportional to the entry count (≤ 100k) and runs off the hot path —
`getEntriesByType` copies matched entries, the count is the only datum used.

Why keep the hook when production mode "fixes" the root cause: `NODE_ENV` can
be explicitly overridden to non-production (test harnesses, debugging), and
container/shim-bypass launches predate the ENV pins in older images — the
hook bounds the buffer in every one of those environments.

## Consequence

- Normal deployments (shim or image, no overrides) run the production
  reconciler, which emits no measure entries — the warning cannot recur and
  the buffer stays empty for its sake.
- The bin shims' behavior is now load-bearing for memory behavior as well as
  entry robustness (ADR 154): any new entry point must replicate the
  unset-only `NODE_ENV` default.
- Dev-mode sessions (explicit `NODE_ENV=development`) keep all React/vitest
  dev warnings, with `usePerformanceDrain` bounding their growth at 100k
  entries.
- The drain clears the _entire_ measure buffer by design; nothing in the
  codebase consumes reconciler measures.

## Key Points

- The reconciler's build is selected by `NODE_ENV` **at module load** — set
  it in the shim, before the first import of `dist/`; Docker `ENV` covers
  shim-bypassing launches.
- Bound the drain at 100k (~10% of Node's 1M cap) and clear-all when the cap
  is crossed; unconditional periodic clearing would discard non-reconciler
  entries needlessly, and never-clear is precisely the leak.
- The production reconciler is the primary fix; the drain hook is defense in
  depth for any environment still running dev mode.
- Both shims and both runtime images are covered; the test-runner image is a
  deliberate dev-mode exception.

## Validation

New suite `drone-agent/test/use-performance-drain.test.tsx` (2 tests, `ink-testing-library` harness): seeding 100,001 measures with `intervalMs=100` drains the buffer to 0 within the poll deadline, and 50 seeded measures survive sub-tick ticks at `intervalMs=20` (no false drain). LSP clean; the suite passes at HEAD (2 passed, verified during ingest).

## Related

- [001-use-ink](001-use-ink.md) — why the agent is an Ink/React app at all (the user-timing surface)
- [036-ink-6-react-19](036-ink-6-react-19.md) — the Ink 6 + React 19 architecture whose reconciler this selects
- [154-bin-shims-replace-entry-gates](154-bin-shims-replace-entry-gates.md) — the bin-shim pattern that hosts the unset-only default
- [172-tui-long-line-padding-fix](172-tui-long-line-padding-fix.md) — sibling long-session TUI robustness work
- [171-codeql-reenable-in-source-dismissal](171-codeql-reenable-in-source-dismissal.md) — CI hardening in the same window (action v4, Node24, SARIF name fix — commit `cb2942b` cleared the 14 dependabot advisories)
- [drone-agent-tui](../../drone-agent/src/tui/) — where the hook lives
- [drone-agent](../../drone-agent/) — bin shims + Dockerfiles
