---
tags: [decision, testing, vitest, isolation]
related: [concepts/test-infrastructure.md, modules/drone-agent-mcp-client.md]
---

# 152 — Test global-fetch isolation

**Date**: 2026-08-22 · **Status**: Accepted · **Commit**: `12c4015`

## Context

The drone-swarm CLI tests failed intermittently in full `pnpm test` runs but always passed in isolation. Symptom fingerprint: failures correlated with `drone-agent/test/mcp-client.test.ts` completing first, and stderr showed either `real fetch must not be called in MCP unit tests` or `fetch is not a function`.

Root cause: the vitest config uses a **single-fork pool** — all test files share one process, so `globalThis` mutations leak across files, and file order is nondeterministic. Two suites mutated `globalThis.fetch` permanently:

- `mcp-client.test.ts` installed a throwing `GUARD_FETCH` in `afterEach` (to fail loudly when a test forgot its mock) and never restored the original.
- `migration.test.ts` **deleted** `globalThis.fetch` in its teardown instead of restoring it.

Any suite running after either one inherited a broken global — hence flaky-looking, order-dependent failures.

## Decision

Two rules, now applied and worth holding as conventions:

1. **Any test that replaces a global must save the original at module scope and restore it in `afterAll`** — teardown-by-`delete` is not restoration, and `afterEach` alone is not enough because the suite as a whole must leave the process as it found it. Both offender suites were fixed accordingly.
2. **Suites that genuinely depend on a pristine global capture it at module-collection time** (before any other suite's hooks can run) and reinstall it in `beforeAll`, as `drone-swarm/test/cli.test.ts` does for `fetch`/`Response`. Its fixtures also bind ephemeral ports (`listen(0)`) and use a direct `node:http` fetch implementation, making them hermetic regardless of pool behavior.

## Consequences

- Fast suite verified stable across 6 consecutive full runs (2047 passed / 9 skipped).
- New suites that stub globals have an established pattern to copy; the failure mode now has a documented fingerprint (order-dependent failures + specific stderr messages) for fast diagnosis.
- The single-fork pool's shared-process tradeoff remains — the alternative (per-file forks) would slow the suite; isolation discipline is the cheaper fix.

## Related

- [[concepts/test-infrastructure]] · [[modules/drone-swarm]]
