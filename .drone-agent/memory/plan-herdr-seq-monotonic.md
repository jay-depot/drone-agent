---
key: plan-herdr-seq-monotonic
tags:
  - plan
  - herdr
  - bugfix
  - plugin
created: 2026-10-08T22:20:00.000Z
updated: 2026-10-08T22:20:00.000Z
---

# Plan: herdr `--seq` must be monotonic across process restarts

**Branch:** `fix/herdr-seq-monotonic` (already cut off `main` at `89c891ba`).
**Assigned agent type:** `code`.
**Origin:** planning session; bug diagnosed by observing a live Herdr pane.

## Summary

**What.** The `herdr` plugin (ADR 239) reports agent state to the [Herdr](https://herdr.dev)
terminal multiplexer with a `--seq N` argument. Today `--seq` comes from a 0-based
counter that is local to one process (`let seq = 0; … String(seq++)`). Herdr's
documented contract is the opposite:

> `--seq` … must increase with every report from your source, **including across
> sessions and restarts of your agent**. … Herdr ignores reports whose number is
> not higher than the last one it accepted.

**Why it matters.** When a run exits without calling `release` (crash, `kill -9`,
Herdr pane restore), the next run restarts the counter at `0`, so its startup
`idle` report and the first few reports of the first turn carry seq values **below**
the dead run's accepted watermark and are **silently dropped**. Observable symptom:
the agent does not appear in `herdr agent list` promptly after startup; it only
appears after its counter overtakes the stale value (typically after the first
agent response). It is flaky because the outcome depends on the previous run's
final seq and whether that run released — and a Herdr *server* restart clears the
in-memory watermark (there is no `seq` field in `~/.config/herdr/session.json`),
so it sometimes works immediately.

**The fix.** Derive `--seq` from a wall-clock value that is forced strictly
increasing within the process, so a fresh process always starts above any prior
process's watermark. Herdr's own docs bless this ("A timestamp works well").
No persistence and no signal handling are needed.

**Scope boundary (explicitly out of scope).** No SIGINT/SIGTERM handling, and no
change to the release-on-`onShutdown`-only policy — ADR 239 D6 decided that
deliberately, and once seq is wall-clock a missed release is harmless. Do **not**
add signal traps in this change.

## Evidence that this is not a merge/MCP regression (do not re-litigate)

- `drone-agent/src/plugins/herdr/reporter.ts` is byte-identical on `main` and
  `feat/herdr-support` (blob `e613cc70612ae70456c41619f3b0a7bdb19cc078`).
- The startup report is register-time (`plugins/herdr/index.ts:118`,
  `reporter.report('idle')`), unchanged by #122/#123.
- The earlier "random garbage agent name" observed on the pane was caused by
  manual `herdr pane report-agent … --agent <probe>` commands, not by the plugin.

## Reproduction (already confirmed; a fresh confirmation is part of Step 3's test)

Against a live pane, with `P="$HERDR_PANE_ID"`:

```bash
# prior run reaches watermark 3
herdr pane report-agent "$P" --source demo --agent A --state idle    --seq 0
herdr pane report-agent "$P" --source demo --agent A --state working --seq 1
herdr pane report-agent "$P" --source demo --agent A --state idle    --seq 2
herdr pane report-agent "$P" --source demo --agent A --state working --seq 3
# restart, counter resets to 0 — all of these are IGNORED (still "working")
herdr pane report-agent "$P" --source demo --agent A --state idle    --seq 0
herdr pane report-agent "$P" --source demo --agent A --state working --seq 1
herdr pane report-agent "$P" --source demo --agent A --state idle    --seq 2
herdr pane report-agent "$P" --source demo --agent A --state working --seq 3
herdr pane report-agent "$P" --source demo --agent A --state idle    --seq 4   # first accepted
```

## Locked design decisions

- **D-A (seq source).** Wall-clock, strictly increasing within the process:
  `let seq = 0; const nextSeq = () => (seq = Math.max(Date.now(), seq + 1));`.
  Used by **both** `report()` and `release()` (a release below the watermark is
  also silently ignored today — same root cause).
- **D-B (scope).** Seq fix only. No exit-path/signal hardening; no D6 amendment.
- **D-C (test determinism).** `vi.useFakeTimers()` + `vi.setSystemTime(...)`
  (repo precedent: `test/swarm/swarm-info.test.ts`, `test/lsp-ergonomics.test.ts`).
  The restart regression is simulated with **two separate `createReporter`
  instances** at two controlled times; assert every seq from instance #2 is
  strictly greater than every seq from instance #1.
- **D-D (test placement).** New unit file
  `drone-agent/test/herdr-reporter.test.ts` (sibling to
  `herdr-resume-argv.test.ts`; drives `createReporter` directly with `execFileAsync`
  mocked). **Also** update the existing `increases --seq across every report`
  case in `drone-agent/test/herdr-plugin.test.ts` for consistency.

---

## Steps

### Step 1 — `reporter.ts`: replace the counter with a wall-clock sequence

**Agent:** code · **Depends on:** none · **File:** `drone-agent/src/plugins/herdr/reporter.ts`

In `createReporter` (currently line 48), replace the counter declaration
(line 50) and both `String(seq++)` call sites (lines 98 and 122).

Replace:

```ts
let seq = 0;
```

with:

```ts
// Herdr requires `--seq` to increase across process restarts, not just within
// one process (see https://herdr.dev/docs/add-herdr-support/). A wall-clock
// value guarantees a fresh process starts above any prior process's watermark;
// Math.max(..., seq + 1) keeps it strictly increasing for same-millisecond
// reports.
let seq = 0;
const nextSeq = (): number => (seq = Math.max(Date.now(), seq + 1));
```

Then in `report()`, replace the seq argument:

```ts
      '--seq',
      String(seq++),
```

with:

```ts
      '--seq',
      String(nextSeq()),
```

And in `release()`, replace the same pattern:

```ts
      '--seq',
      String(seq++),
```

with:

```ts
      '--seq',
      String(nextSeq()),
```

Update the module header comment (lines 7–9) so it no longer implies the
sequence is only in-process. Replace:

```
 * Reports are coalesced to a single in-flight call, keeping only the latest
 * desired state, and carry a strictly increasing `--seq` so out-of-order
 * deliveries cannot regress Herdr's view.
```

with:

```
 * Reports are coalesced to a single in-flight call, keeping only the latest
 * desired state, and carry a `--seq` that increases across process restarts
 * (a wall-clock value), so a restarted process cannot be silently dropped as
 * "not newer than" a previous run — and out-of-order deliveries cannot regress
 * Herdr's view.
```

**Do not** add a clock parameter to `HerdrReporterOptions`; tests control time
with fake timers (D-C).

### Step 2 — New unit test `drone-agent/test/herdr-reporter.test.ts`

**Agent:** code · **Depends on:** Step 1 · **File:** `drone-agent/test/herdr-reporter.test.ts` (new)

Create the file. Mirror the mocking style of `test/herdr-plugin.test.ts`
(mock `../src/shared/exec-async.js`) but drive `createReporter` directly.

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createReporter,
  type HerdrReporterOptions,
} from '../src/plugins/herdr/reporter.js';

const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
vi.mock('../src/shared/exec-async.js', () => ({
  execFileAsync: (...args: unknown[]) => mockExec(...args),
}));

function makeOptions(
  overrides: Partial<HerdrReporterOptions> = {}
): HerdrReporterOptions {
  return {
    binPath: '/usr/bin/herdr',
    paneId: 'w1:p1',
    source: 'drone-agent',
    agentLabel: 'drone-agent',
    sessionId: 'agent-1',
    ...overrides,
  };
}

/** Drain the reporter's background coalescing pump. */
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

function seqsFromCalls(): number[] {
  return mockExec.mock.calls
    .map(call => call[1] as string[])
    .filter(argv => argv.includes('--seq'))
    .map(argv => Number(argv[argv.indexOf('--seq') + 1]));
}

describe('herdr reporter --seq', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExec.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits strictly increasing seqs across reports and release', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const reporter = createReporter(makeOptions());
    reporter.report('idle');
    reporter.report('working');
    reporter.report('idle');
    await flush();
    await reporter.release();

    const seqs = seqsFromCalls();
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('a restarted process out-sequences the previous process (the regression)', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const first = createReporter(makeOptions());
    first.report('idle');
    first.report('working');
    first.report('idle');
    await flush();
    const firstSeqs = seqsFromCalls();
    const firstMax = Math.max(...firstSeqs);

    mockExec.mockClear();
    // Simulate a restart one second later (the pane was NOT released).
    vi.setSystemTime(new Date('2026-10-08T22:00:01.000Z'));
    const second = createReporter(makeOptions());
    second.report('idle');
    await flush();
    const secondSeqs = seqsFromCalls();

    expect(secondSeqs.length).toBeGreaterThan(0);
    for (const s of secondSeqs) {
      expect(s).toBeGreaterThan(firstMax);
    }
  });

  it('is strictly increasing even for same-millisecond reports', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const reporter = createReporter(makeOptions());
    reporter.report('working');
    reporter.report('idle');
    reporter.report('working');
    await flush();
    const seqs = seqsFromCalls();
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
```

### Step 3 — Update the plugin-level assertion

**Agent:** code · **Depends on:** Step 1 · **File:** `drone-agent/test/herdr-plugin.test.ts`

The existing case `it('increases --seq across every report', …)` (around
line 214) collects seqs via `flattenArgvCalls()`. It stays valid, but tighten it
so it also asserts the floor: every seq is at or above the current wall clock.
Add a lower-bound check to the existing loop, or add this assertion after the
existing strictly-increasing loop:

```ts
    // Wall-clock floor: every seq is a real timestamp, so a restart cannot
    // collide with an older process's watermark.
    for (const s of seqs) {
      expect(s).toBeGreaterThanOrEqual(Date.now() - 5_000);
    }
```

Do **not** add `vi.useFakeTimers()` to this file; keep it as an integration-style
check with the real clock (its purpose is wiring coverage, not time control).

### Step 4 — Documentation

**Agent:** code · **Depends on:** Step 1 · **Files:**
`docs/agents/herdr-plugin.md`, `docs/adr/239-herdr-agent-integration.md`,
`docs/adr/index.md`

1. `docs/agents/herdr-plugin.md` line ~40 currently reads:

   > Reports carry a strictly increasing `--seq` and are coalesced to one
   > in-flight call (only the latest state is sent).

   Replace with:

   > Reports carry a `--seq` that increases across process restarts (a
   > wall-clock value), and are coalesced to one in-flight call (only the latest
   > state is sent). Herdr ignores a report whose seq is not higher than the last
   > one it accepted, so a value that only counted up within one process would be
   > silently dropped after a crash or pane restore.

2. `docs/adr/239-herdr-agent-integration.md` D6 currently states:

   > Reports carry a monotonic in-process `--seq` …

   Replace that clause with:

   > Reports carry a `--seq` that is strictly increasing across process
   > restarts (a wall-clock value), not merely in-process …

   Add a short note to the ADR's **Consequences** section:

   > `--seq` is derived from the wall clock so a restarted process cannot be
   > silently dropped by Herdr's "not higher than the last accepted" rule; the
   > earlier 0-based in-process counter produced exactly that failure after a run
   > that exited without releasing.

   Leave the ADR **Status** line's branch reference (`feat/herdr-support`) as
   historical; do not rewrite it.

3. `docs/adr/index.md` row 239 (line ~284): update the phrase
   `monotonic --seq` to `wall-clock --seq (monotonic across restarts)`.

### Step 5 — Verify against the validation criteria

**Agent:** code · **Depends on:** Steps 1–4

Run every check in the **Validation criteria** section below. All must pass
before the work is considered done. If any check fails, fix and repeat.

---

## Validation criteria

All items must pass. Do not skip the test suites.

1. **LSP clean** — no errors or warnings in `drone-agent/src/plugins/herdr/*`
   or the touched test/doc files.
2. **Typecheck:** `pnpm -r run typecheck` passes with zero errors.
3. **Build:** `pnpm -r run build` passes with zero errors.
   (Run this before relying on LSP in dependent packages — dependents resolve
   `drone-core` from built `dist/`.)
4. **Lint:** `pnpm run lint` passes with zero errors and **no new
   `eslint-disable`** comments. Note the repo-wide lint hazard: `pnpm run lint`
   runs `eslint . --fix` + `prettier --write .` and will reformat unrelated
   files. Prefer verifying the feature with
   `pnpm exec prettier --check <changed files>` and a scoped
   `eslint --fix` on the changed paths; if you do run the repo-wide lint,
   `git restore` any unrelated churn before committing.
   - Known pre-existing exception: `.drone-agent/insights/project/drone-agent.json`
     is not prettier-clean on `main`. Either leave it out of the change or let
     prettier normalise it deliberately — do not treat it as a new failure.
5. **Fast tests:** `pnpm run test` passes, including the new
   `drone-agent/test/herdr-reporter.test.ts` and the updated
   `drone-agent/test/herdr-plugin.test.ts`.
6. **Regression proof (RED→GREEN).** Confirm the new restart test fails against
   the pre-fix `reporter.ts` and passes after Step 1:
   - `git stash` the `reporter.ts` change (or temporarily restore
     `String(seq++)`), run the new test file, observe the
     "restarted process out-sequences the previous process" case **fail**.
   - Restore the fix, re-run, observe it **pass**.
7. **Unit coverage:** every new behaviour (wall-clock floor, strict
   monotonicity, cross-restart monotonicity, release seq) is covered by a test.
8. **Dead code / comments:** no leftover `seq++`, no unused variables, no
   "step" comments. The only new comment is the explanatory one in Step 1.
9. **Docs consistency:** the three documentation edits from Step 4 are present,
   and a `grep -rn "monotonic in-process"` across `docs/` returns nothing.
10. **Manual in-pane round-trip (recommended, not blocking).** Inside a Herdr
    pane with the plugin enabled and swarm connected: start drone-agent, confirm
    it appears in `herdr agent list` **within a second or two**; kill the pane's
    process without releasing (`kill -9`), start it again in the same pane, and
    confirm it announces itself promptly again (this is the reported failure,
    now fixed). Use a scratch `herdr --session <name>` pane — **never** probe the
    user's live pane with `report-agent`, as that hijacks the displayed agent.

## Out of scope (do not implement)

- SIGINT/SIGTERM traps or a D6 amendment (ADR 239 D6 stands).
- Persisted seq counters / cross-process locking (a wall clock removes the need).
- Any change to `drone-core`, the engine, MCP, or the swarm plugin.
- Reworking the `blocked` state (still deferred per ADR 239 D1).
