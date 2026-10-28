---
key: plan-coordinator-ui-session-duration
tags:
  - plan
  - coordinator-ui
  - sessions
  - duration
  - ended-at
created: 2026-10-28T01:15:56.646Z
updated: 2026-10-28T01:15:56.646Z
---

# Plan: Fix the Sessions-page "Duration" column (show a true duration, not an age)

Branch: feat/ui-polish (all work stays on this branch). Language: ASD-STE100.

## Summary
The Sessions page shows a "Duration" column that actually shows the session's age, because the coordinator never records an end time for a swarm session. This plan adds a real end timestamp to swarm sessions and renders a true duration.

## Root cause (verified)
- drone-coordinator-ui/src/pages/sessions.tsx formatDuration (L359) computes Date.now() - connectedAt; connectedAt is mapped from SwarmSession.createdAt; durationMs is always null.
- swarm_sessions (drone-coordinator/src/db/swarm-sessions.ts) has only createdAt/updatedAt; updatedAt is rewritten by every status transition, so it cannot serve as an end time.
- A separate table beacon_sessions does record disconnected_at + duration_ms (used by beacon-detail.tsx L428) but is not what GET /sessions reads.

## Decisions (locked with user Q1-Q7)
- Q1: Add nullable `ended_at INTEGER` to swarm_sessions. Duration = endedAt - createdAt when set, else live age.
- Q2: Stamp ended_at on ANY transition into ended/processing/processed/archived (the four non-live states), set-once (only when currently NULL). Leave active and stale NULL (they show live age). stale stays live because it is a 24h liveness heuristic, not a confirmed stop.
- Q3: Format ladder: Xs / Xm / Xh YYm / Xd YYh, zero-padded second unit, `~` prefix on live (unfrozen) values.
- Q4: No live ticker; compute at render time only.
- Q5: Surface endedAt in API responses (coordinator SwarmSession type + UI lib/types.ts). No new display sites beyond the list column.
- Q6: Extract one shared formatDuration(ms) helper in drone-coordinator-ui/src/lib/duration.ts, used by both sessions.tsx and beacon-detail.tsx.
- Q7: No backfill of existing rows (their true end is unrecoverable). In the UI, a row in a non-live state (not active, not stale) that lacks an end time renders "unknown".

Non-goal: the WS initial snapshot in drone-coordinator/src/index.ts builds its own active-only session objects; the Sessions page ignores it. Do not change it. Do not add endedAt to the UI BeaconSession type.

## Steps

### Step 1 - Add the database column (coder)
File: drone-coordinator/src/db/init.ts
Add this idempotent migration next to the existing swarm_sessions migrations (the variable swarmSessionCols already exists there):
```ts
// Idempotent migration: add ended_at to swarm_sessions. It records the real
// stop time. NULL means the session is live, or the row predates this column.
if (!swarmSessionCols.some(c => c.name === 'ended_at')) {
  db.exec('ALTER TABLE swarm_sessions ADD COLUMN ended_at INTEGER');
}
```

### Step 2 - Record the end time in the DB layer (coder)
File: drone-coordinator/src/db/swarm-sessions.ts
- 2a: Add `endedAt: number | null;` to the SwarmSession interface and `ended_at: number | null;` to the SwarmSessionRow interface.
- 2b: Map `endedAt: row.ended_at,` in rowToSwarmSession.
- 2c: Add the column to the createSwarmSession INSERT, writing null; add endedAt: null to the returned object.
- 2d: Add a shared helper near the top:
```ts
const LIVE_STATUSES = new Set(['active', 'stale']);
/** A transition into a non-live state freezes the session clock. */
function freezesClock(status: string): boolean {
  return !LIVE_STATUSES.has(status);
}
```
- 2e: Change updateSwarmSessionStatus to set ended_at set-once:
```ts
export function updateSwarmSessionStatus(
  id: string,
  status: string
): SwarmSession | undefined {
  const existing = getSwarmSession(id);
  if (!existing) return undefined;
  const now = Date.now();
  const endedAt = freezesClock(status)
    ? (existing.endedAt ?? now)
    : existing.endedAt;
  const stmt = getDatabase().prepare(`
    UPDATE swarm_sessions
    SET status = @status, updatedAt = @updatedAt, ended_at = @endedAt
    WHERE id = @id
  `);
  stmt.run({ id, status, updatedAt: now, endedAt });
  return { ...existing, status, updatedAt: now, endedAt };
}
```
- 2f: Make the same change in transitionSessionStatus (use session.endedAt in place of existing.endedAt); return endedAt in the result object.
- 2g: Do NOT change markStaleSessions. It writes 'stale', a live status; freezesClock('stale') is false; the clock stays open.

### Step 3 - Confirm no other construction site breaks (coder)
Search for the SwarmSession type and object literals that build it; add endedAt to each. GET /sessions returns DB rows directly (no route change). drone-swarm session list prints the API JSON, so endedAt flows through with no change.

### Step 4 - Add the shared formatter (coder)
New file: drone-coordinator-ui/src/lib/duration.ts
```ts
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LIVE_STATUSES = new Set(['active', 'stale']);
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** Format a duration in milliseconds: 42s, 17m, 3h 05m, 2d 04h. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < MINUTE) return `${Math.floor(value / 1000)}s`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)}m`;
  if (value < DAY) {
    const hours = Math.floor(value / HOUR);
    const minutes = Math.floor((value % HOUR) / MINUTE);
    return `${hours}h ${pad2(minutes)}m`;
  }
  const days = Math.floor(value / DAY);
  const hours = Math.floor((value % DAY) / HOUR);
  return `${days}d ${pad2(hours)}h`;
}
export interface SessionDurationInput {
  createdAt: number;
  endedAt: number | null;
  status: string;
}
/**
 * Show a session duration. A set end time gives a frozen value. A live status
 * gives a `~`-prefixed age. Any other case gives "unknown".
 */
export function formatSessionDuration(
  session: SessionDurationInput,
  now: number = Date.now()
): string {
  if (session.endedAt !== null) {
    return formatDuration(session.endedAt - session.createdAt);
  }
  if (LIVE_STATUSES.has(session.status)) {
    return `~${formatDuration(now - session.createdAt)}`;
  }
  return 'unknown';
}
```

### Step 5 - Update the UI types (coder)
File: drone-coordinator-ui/src/lib/types.ts - add `endedAt: number | null;` to SwarmSession. Do not change BeaconSession.

### Step 6 - Update the Sessions page (coder)
File: drone-coordinator-ui/src/pages/sessions.tsx
- 6a: Extend the local row type: `type SessionRow = BeaconSession & { status?: string; endedAt: number | null };`
- 6b: In fetchSessions add `endedAt: s.endedAt,` to the row map.
- 6c: Delete the local formatDuration function (near L359); import formatSessionDuration from '@/lib/duration'.
- 6d: Replace the Duration cell body:
```tsx
<TableCell>
  {formatSessionDuration({
    createdAt: session.connectedAt,
    endedAt: session.endedAt,
    status: session.status ?? 'active',
  })}
</TableCell>
```

### Step 7 - Use the shared helper in the beacon detail page (coder)
File: drone-coordinator-ui/src/pages/beacon-detail.tsx - import formatDuration from '@/lib/duration'; replace the inline formatting near L428:
```tsx
<TableCell className="text-xs">
  {session.durationMs !== null
    ? formatDuration(session.durationMs)
    : 'Active'}
</TableCell>
```

### Step 8 - Unit tests for the formatter (tester)
New file: drone-coordinator-ui/src/lib/duration.test.ts
Cover: formatDuration(0) -> '0s'; formatDuration(42_000) -> '42s'; formatDuration(1_020_000) -> '17m'; formatDuration(11_100_000) -> '3h 05m' (zero-pad); formatDuration(187_200_000) -> '2d 04h'; negative input -> '0s'; formatSessionDuration frozen (createdAt 0, endedAt 300_000) -> '5m'; live (status active, endedAt null, fixed now) -> '~5m'; live stale -> '~...'; non-live without end time (status processing, endedAt null) -> 'unknown'.

### Step 9 - Database tests (tester)
File: drone-coordinator/test/db.test.ts (Swarm Session & Events block):
- A new session has endedAt === null.
- updateSwarmSessionStatus(id, 'ended') sets endedAt to a number.
- transitionSessionStatus(id, 'active', 'processing') sets endedAt.
- Set-once: after 'ended', a transition to 'processing' keeps the same endedAt.
- markStaleSessions leaves endedAt === null.

### Step 10 - Route tests (tester)
File: drone-coordinator/test/routes/swarm.test.ts:
- After DELETE /sync/sessions/:id, GET /sessions shows a non-null endedAt for that session.
- A live session in GET /sessions shows endedAt: null.

### Step 11 - UI page tests (tester)
File: drone-coordinator-ui/src/pages/sessions.test.tsx - add a block:
- A frozen row (createdAt and endedAt 5 minutes apart, status processed) shows '5m'.
- A live row (status active, endedAt null) shows a ~-prefixed value.
- A non-live row without an end time (status processing, endedAt null) shows 'unknown'.

### Step 12 - ADR (coder)
New file: docs/adr/267-session-ended-at-duration.md
Record: the problem (the Duration column showed an age), the new ended_at column, the set-once rule for the four non-live states, the live active/stale rule, the no-backfill decision, and the shared formatter. Add a row to docs/adr/index.md.

### Step 13 - Check the work against the validation criteria (reviewer)
Run every check in the validation section; confirm each result.

## Dependencies and order
```
Step 1 -+
Step 2 -+-> Step 3 -> Step 9, Step 10   (coordinator side)
Step 4 -+
Step 5 -+-> Step 6 -> Step 7 -> Step 8, Step 11   (UI side)
        +-> Step 12 -> Step 13
```
- Step 2 needs Step 1. Step 6 needs Steps 4 and 5. Step 12 can start after Steps 2 and 6. Step 13 is last.
- IMPORTANT: after Step 2, run `pnpm -r run build`. Dependent packages resolve drone-core/drone-coordinator types from dist/, so without this build LSP/typecheck show stale results.

## Validation criteria (all must pass; no exceptions)
1. LSP: no errors and no warnings on all changed files (sessions.tsx, beacon-detail.tsx, duration.ts, lib/types.ts, swarm-sessions.ts, init.ts, and every test file).
2. Build: `pnpm -r run build` passes with zero errors.
3. Typecheck: `pnpm typecheck` passes with zero errors.
4. Lint: `pnpm lint` passes with zero errors. Prettier reformats files; re-read each file after this step before changing it again.
5. Fast tests: `pnpm test` passes.
6. UI tests: `pnpm --filter drone-coordinator-ui test` passes (runs with NODE_ENV=test, which React needs for act).
7. Behavior: a session that reaches ended/processing/processed/archived has a non-null endedAt; the endedAt value does not change after the first set; an active or stale session has endedAt === null and shows a ~-prefixed age; a non-live session without an end time shows 'unknown'; no old row is backfilled.
8. No duplicate formatter: grep finds no second duration-formatting implementation in the coordinator UI.

## Test-environment notes
- Coordinator tests use setupDb()/teardownDb() from test/setup.ts (fresh temp-dir SQLite per test) and buildTestApp() from test/app-helper.ts for route injection.
- UI tests run via the package's pnpm test script (NODE_ENV=test) because react 19 exports .act only on its development build.
- Prettier runs as part of pnpm lint and will reformat files; re-read before further edits.
