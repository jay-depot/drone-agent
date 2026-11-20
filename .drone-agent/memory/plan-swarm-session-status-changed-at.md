---
key: plan-swarm-session-status-changed-at
tags:
  - plan
  - drone-coordinator
  - drone-coordinator-ui
  - drone-swarm
  - mcp-swarm
  - drone-agent
  - swarm-sessions
  - status-changed-at
  - schema
  - migration
  - ADR-280
created: 2026-11-19T19:57:00.000Z
updated: 2026-11-19T19:57:00.000Z
---

# Plan — Add a "last status change" timestamp to coordinator swarm session records

**Status:** Ready for execution.
**Executor:** persona `code`. One reviewer pass at the end.
**Estimated steps:** 9.

## 1. Summary — what and why

Coordinator swarm session records carry a `status` value. The values are `active`, `stale`,
`ended`, `processing`, `processed`, and `archived`. The records carry no timestamp for the last
status change. A user cannot see how long a session has stayed in one status.

The user wants to add this field. The user wants the field named "last status change". The field
must contain the time when the status value last changed. The user will run external, user-provided
processes. Those processes will detect stuck sessions and clean them up. Those processes need this
timestamp.

The user also wants existing records to get a value. The user accepted `updatedAt` as the backfill
source. Every status write also rewrites `updatedAt`. So `updatedAt` is the best available proxy
for a record that predates the new column.

The plan also updates every surface that shows a session list or a single session. The surfaces
are the REST endpoints, the `drone-swarm` CLI, the `/swarm-session list` slash command, and the
`mcp-swarm` MCP tool.

## 2. Design decisions (locked)

The operator agreed to these decisions in the planning session. Do not change them.

**D1 — Field name and type.** The database column is `status_changed_at` (type INTEGER). The
TypeScript field is `statusChangedAt` (type `number | null`).

**D2 — The field is REQUIRED and nullable.** `statusChangedAt` is `number | null`, not an optional
field (`statusChangedAt?`). A required field makes the type checker find every construction site.
This is the rule from ADR 269, the sibling `ended_at` work. That work found one missed site with
this rule.

**D3 — Migration.** Add the column with an idempotent PRAGMA-guarded `ALTER TABLE` statement in
`drone-coordinator/src/db/init.ts`. Put it next to the `interactive`, `session_snapshot`, and
`ended_at` blocks. There is no migration framework in this project. Follow the existing pattern.

**D4 — Backfill inline, one time.** Run the backfill `UPDATE` inside the same guard that adds the
column. The guard runs only when the column is new. So the backfill runs exactly one time, on an
existing database. A new database skips the backfill, because the column already exists.

Backfill statement:
`UPDATE swarm_sessions SET status_changed_at = updatedAt WHERE status_changed_at IS NULL`

This decision deliberately differs from ADR 269. ADR 269 chose no backfill. An end time is
unrecoverable. Here, `updatedAt` is recoverable, so the plan backfills. Record this difference in
the ADR.

**D5 — Stamp rule.** Stamp the field on every status change. Stamp the field only when the status
value actually changes. Compare the old value with the new value. Do not stamp when the value does
not change. A redundant status write must not move the timestamp. If it moved, a long-stuck session
would look recently touched. That would defeat the stuck-detection use case.

The initial `active` value is the first status. So `createSwarmSession` stamps the field with the
creation time.

**D6 — `markStaleSessions` stamps the field.** The stale sweep changes the status from `active` to
`stale`. This is a real status change. So the sweep stamps the field. Note the difference from
`ended_at`. `ended_at` deliberately does NOT stamp on the stale sweep, because `stale` is a
liveness heuristic, not a stop. `statusChangedAt` is different. It tracks the status value, so it
stamps.

**D7 — `updateSwarmSessionPersona` carries the value forward.** This function rewrites the row. It
does not change the status. So it carries the old value forward. It must still set the column
explicitly in its `UPDATE` statement. This keeps the ADR 269 invariant: every row-rewriting
`UPDATE` sets the new column.

**D8 — Surface sweep.** Add the field to these surfaces:

- The full-row REST endpoints `GET /sessions` and `GET /sessions/:id`. The field flows through
  automatically. Add tests only.
- The hand-picked session subsets in `GET /sessions/:id/log` and `GET /sessions/:id/transcript`.
  Add the field explicitly. These subsets do not flow through automatically.
- The `drone-swarm` CLI session commands. The CLI passes JSON through. The field flows through
  automatically. Add tests only.
- The `/swarm-session list` slash command. Add a column to the table. This table is hand-rolled.
- The `mcp-swarm` MCP tool `swarm.session.list`. The response schema is unconstrained. The field
  flows through automatically. Add a test only.

**D9 — Leave these surfaces unchanged:**

- The `drone-gateway` console output (`swarm.session.list`, `swarm.session.get`). The console
  human table is hand-picked. But the console `--json` output already carries the field. The
  operator chose to leave the console unchanged.
- The coordinator WebSocket initial-state dump. That dump is `beacon_sessions`-shaped. It already
  omits `status`, `endedAt`, and `interactive`. Leave it unchanged. (Verified in the code at
  `drone-coordinator/src/index.ts`, in the `listSwarmSessions({ status: 'active' })` mapping block.)
- The coordinator UI sessions page (`drone-coordinator-ui/src/pages/sessions.tsx`). The operator
  chose to leave the UI unchanged. The field is still available to external tools through the REST
  API.

## 3. Notes for the executor

- **Verify every edit.** The `apply_diff` tool can report `patched: true` with a `-0 +0` summary and
  write nothing. After every edit, search the file for the new text. A summary of zero changes is a
  failure.
- **Do not sweep with `grep | head`.** The `head` command truncates the result. A truncated sweep
  hid a construction site in the `ended_at` work. Run the type checker instead. The type checker
  finds every required-field construction site.
- **Run `pnpm -r run build` after you change `drone-coordinator`.** Dependent packages resolve
  `drone-coordinator` from its built `dist/`, not from source.
- **Re-read a file after the linter runs.** `pnpm run lint` runs Prettier. Prettier reformats the
  files. Re-read a file before you change it again.
- **The `ended_at` work is the template.** Read `docs/adr/269-session-ended-at-duration.md` before
  you start. It shows the exact migration, stamp, and type shapes used here.

---

## Step 1 — Extract the swarm-session migration into a testable function

**File:** `drone-coordinator/src/db/init.ts`
**Agent:** coder

The three existing swarm-session migrations are inline in `initDatabase`. Move them into an exported
function. This makes the backfill testable against an in-memory database. This follows the existing
`makeBeaconPortOptional(db)` precedent. That function is exported and unit-tested.

Add this function. Put it next to `makeBeaconPortOptional`:

```ts
/**
 * Add the `swarm_sessions` columns that earlier schemas lack. Backfill the
 * status-change stamp for rows that predate the column. Idempotent: each
 * column is probed before it is added, so the backfill runs one time only.
 */
export function migrateSwarmSessionColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(swarm_sessions)').all() as Array<{
    name: string;
  }>;

  if (!cols.some(c => c.name === 'interactive')) {
    db.exec(
      'ALTER TABLE swarm_sessions ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0'
    );
  }

  if (!cols.some(c => c.name === 'session_snapshot')) {
    db.exec('ALTER TABLE swarm_sessions ADD COLUMN session_snapshot TEXT');
  }

  // ended_at records the real stop time. NULL means the session is live, or
  // the row predates this column.
  if (!cols.some(c => c.name === 'ended_at')) {
    db.exec('ALTER TABLE swarm_sessions ADD COLUMN ended_at INTEGER');
  }

  // status_changed_at records when the status last changed. The backfill uses
  // updatedAt, which every status write also rewrites. It is the best proxy
  // for a row that predates this column.
  if (!cols.some(c => c.name === 'status_changed_at')) {
    db.exec('ALTER TABLE swarm_sessions ADD COLUMN status_changed_at INTEGER');
    db.exec(
      'UPDATE swarm_sessions SET status_changed_at = updatedAt WHERE status_changed_at IS NULL'
    );
  }
}
```

In `initDatabase`, replace the three inline blocks (the `swarmSessionCols` probe and the three
`if (!swarmSessionCols...)` blocks) with one call:

```ts
migrateSwarmSessionColumns(db);
```

Keep the call in the same position. The position is after `makeBeaconPortOptional(db)` and before
the extension-table `db.exec`.

**Check:** the file has no `swarmSessionCols` variable left. The file exports
`migrateSwarmSessionColumns`. Run `pnpm --filter drone-coordinator run build`.

## Step 2 — Add the field to the type, the row mapper, and the create path

**File:** `drone-coordinator/src/db/swarm-sessions.ts`
**Agent:** coder

Add the field to `SwarmSession` (required, nullable):

```ts
export interface SwarmSession {
  id: string;
  personaId: string | null;
  beaconId: string;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  statusChangedAt: number | null;
  status: string;
  interactive: boolean;
  sessionSnapshot: DroneSessionSnapshot | null;
}
```

Add the field to `SwarmSessionRow`:

```ts
status_changed_at: number | null;
```

Add the field to `rowToSwarmSession`:

```ts
    statusChangedAt: row.status_changed_at,
```

In `createSwarmSession`, add the column to the `INSERT` statement, the parameter map, and the
returned object. The creation time is the first status change, so use `now`:

- `INSERT INTO swarm_sessions (id, persona_id, beacon_id, createdAt, updatedAt, status, interactive, session_snapshot, ended_at, status_changed_at)`
- `VALUES (@id, @personaId, @beaconId, @createdAt, @updatedAt, @status, @interactive, @sessionSnapshot, @endedAt, @statusChangedAt)`
- Add `statusChangedAt: now` to the `stmt.run({...})` object.
- Add `statusChangedAt: now` to the returned `SwarmSession` literal.

Add this shared helper near the top of the file, next to `LIVE_STATUSES` and `freezesClock`:

```ts
/** The stamp moves only when the status value changes. */
function nextStatusChangedAt(
  previousStatus: string,
  nextStatus: string,
  previousStamp: number | null,
  now: number
): number | null {
  return previousStatus !== nextStatus ? now : previousStamp;
}
```

**Check:** run `pnpm --filter drone-coordinator run build`. Expect errors at every construction site
that you have not updated yet. Continue to the next steps. The errors are the expected sweep.

## Step 3 — Stamp the field in every status-changing write

**File:** `drone-coordinator/src/db/swarm-sessions.ts`
**Agent:** coder

**`updateSwarmSessionStatus`** — add the computation, the `SET` clause, the parameter, and the
return value:

```ts
const statusChangedAt = nextStatusChangedAt(
  existing.status,
  status,
  existing.statusChangedAt,
  now
);
const stmt = getDatabase().prepare(`
    UPDATE swarm_sessions
    SET status = @status, updatedAt = @updatedAt, ended_at = @endedAt,
        status_changed_at = @statusChangedAt
    WHERE id = @id
  `);
stmt.run({ id, status, updatedAt: now, endedAt, statusChangedAt });

return { ...existing, status, updatedAt: now, endedAt, statusChangedAt };
```

**`transitionSessionStatus`** — the same shape. Use the `from`-status as the previous value:

```ts
const statusChangedAt = nextStatusChangedAt(
  session.status,
  toStatus,
  session.statusChangedAt,
  now
);
const stmt = getDatabase().prepare(
  'UPDATE swarm_sessions SET status = @status, updatedAt = @updatedAt, ended_at = @endedAt, status_changed_at = @statusChangedAt WHERE id = @id'
);
stmt.run({ id, status: toStatus, updatedAt: now, endedAt, statusChangedAt });

return {
  ...session,
  status: toStatus,
  updatedAt: now,
  endedAt,
  statusChangedAt,
};
```

**`markStaleSessions`** — the query returns only `active` rows. The target value `stale` always
differs. Use the helper for clarity. Add the `SET` clause, the parameter, and the return value:

```ts
const statusChangedAt = nextStatusChangedAt(
  session.status,
  'stale',
  session.statusChangedAt,
  now
);
const stmt = getDatabase().prepare(
  'UPDATE swarm_sessions SET status = @status, updatedAt = @updatedAt, ended_at = @endedAt, status_changed_at = @statusChangedAt WHERE id = @id'
);
stmt.run({
  id: session.id,
  status: 'stale',
  updatedAt: now,
  endedAt: session.endedAt,
  statusChangedAt,
});
updated.push({ ...session, status: 'stale', updatedAt: now, statusChangedAt });
```

**`updateSwarmSessionPersona`** — carry the value forward. Change the `SET` clause, the parameter,
and the return value:

```ts
const stmt = getDatabase().prepare(`
    UPDATE swarm_sessions SET persona_id = @personaId, updatedAt = @updatedAt, ended_at = @endedAt, status_changed_at = @statusChangedAt WHERE id = @id
  `);
stmt.run({
  id,
  personaId,
  updatedAt: now,
  endedAt: existing.endedAt,
  statusChangedAt: existing.statusChangedAt,
});

return { ...existing, personaId, updatedAt: now };
```

`archiveSwarmSession` and `restoreSwarmSession` delegate to `transitionSessionStatus`. No change is
needed in them.

**Check:** run `pnpm --filter drone-coordinator run build`. Expect the typecheck sweep to point at
the remaining sites below. Verify each `UPDATE` statement in the file contains `status_changed_at`
by searching the file.

## Step 4 — Add the field to the hand-picked REST subsets

**File:** `drone-coordinator/src/routes/swarm.ts`
**Agent:** coder

The `GET /sessions/:id/log` route and the `GET /sessions/:id/transcript` route build the session
object by hand. Find each `session: { id: session.id, ... }` block. Add `statusChangedAt` to both:

```ts
        session: {
          id: session.id,
          personaId: session.personaId,
          beaconId: session.beaconId,
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          statusChangedAt: session.statusChangedAt,
        },
```

`GET /sessions` and `GET /sessions/:id` return the full row. They need no change.

**Check:** search `drone-coordinator/src/routes/swarm.ts` for `statusChangedAt`. Expect two hits.

## Step 5 — Add a column to the `/swarm-session list` slash-command table

**File:** `drone-agent/src/plugins/swarm/session-command.ts`
**Agent:** coder

Add the field to the inline response type in `handleList`:

```ts
sessions: Array<{
  id: string;
  personaId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  statusChangedAt: number | null;
}>;
```

Add the value to the mapped line. Show it as an ISO string. Show `-` when the value is null:

```ts
const lines = sessions.map(s => {
  const created = new Date(s.createdAt).toISOString();
  const updated = new Date(s.updatedAt).toISOString();
  const changed =
    s.statusChangedAt === null
      ? '-'
      : new Date(s.statusChangedAt).toISOString();
  return `${s.id.padEnd(24)} ${(s.personaId ?? 'none').padEnd(16)} ${s.status.padEnd(10)} ${created} ${updated} ${changed}`;
});
```

**Check:** search the file for `statusChangedAt`. Expect two hits.

## Step 6 — Update the coordinator test suite

**Files:** `drone-coordinator/test/db.test.ts`, `drone-coordinator/test/routes/swarm.test.ts`,
`drone-coordinator/test/transcript.test.ts`
**Agent:** coder

**`test/transcript.test.ts`** — the typed `SwarmSession` literal at the top of the file needs the
new required field. Add `statusChangedAt: null` to the literal.

**`test/db.test.ts`** — add a `describe('migrateSwarmSessionColumns', ...)` block. Follow the
`makeBeaconPortOptional` test pattern in the same file. Test these cases:

1. A legacy `:memory:` database with `swarm_sessions` rows and no `status_changed_at` column gets
   the column added. The backfill sets `status_changed_at` equal to `updatedAt` for every row.
2. The function is idempotent. A second call does not throw and does not change the values.
3. A fresh database (the column exists) runs no backfill.

Add session-stamp cases in the `describe('Swarm Session & Events', ...)` block:

1. A new session has `statusChangedAt` equal to `createdAt`.
2. `updateSwarmSessionStatus` moves `statusChangedAt` when the status changes.
3. `updateSwarmSessionStatus` does NOT move `statusChangedAt` when the status is unchanged. (Call
   it twice with the same value.)
4. `transitionSessionStatus` moves `statusChangedAt` on a real change.
5. `markStaleSessions` sets `statusChangedAt` on a stale sweep.
6. `updateSwarmSessionPersona` preserves `statusChangedAt`.

**`test/routes/swarm.test.ts`** — add these cases:

1. `GET /api/sessions` returns a session with a number `statusChangedAt`.
2. `statusChangedAt` survives the round trip through `POST /api/sync/sessions/register` and
   `GET /api/sessions`.
3. `GET /api/sessions/:id/log` includes `statusChangedAt` in the session object.

**Check:** run `pnpm --filter drone-coordinator run test`. All tests pass.

## Step 7 — Update the CLI, slash-command, and MCP tests

**Files:** `drone-swarm/test/cli.test.ts`, `drone-agent/test/session-command.test.ts`,
`mcp-swarm/test/mapping.test.ts`
**Agent:** coder

**`drone-swarm/test/cli.test.ts`** — the fixture returns session records. Add `statusChangedAt` to
the fixture record. In the `session list` test, assert the field is present in the parsed output.

**`drone-agent/test/session-command.test.ts`** — the `/swarm-session list` test asserts the printed
table. Add `statusChangedAt` to the fixture session. Assert the printed line contains the ISO value.

**`mcp-swarm/test/mapping.test.ts`** — add a case that asserts `swarm.session.list` passes the
coordinator body through unchanged. The body must carry `statusChangedAt`.

**Check:** run `pnpm --filter drone-swarm run test`, `pnpm --filter drone-agent run test`, and
`pnpm --filter mcp-swarm run test`. All tests pass.

## Step 8 — Write the ADR and update the ADR index

**Files:** `docs/adr/280-swarm-session-status-changed-at.md` (new), `docs/adr/index.md`
**Agent:** coder

Create the ADR. Use the format of `docs/adr/269-session-ended-at-duration.md`. Record these
decisions:

- D1: the column name and type.
- D2: the field is required and nullable. Explain why (the typecheck sweep).
- D3: the migration pattern.
- D4: the backfill with `updatedAt`. State explicitly that this differs from ADR 269's no-backfill
  rule, and why. An end time is unrecoverable. A status-change time is recoverable from `updatedAt`.
- D5: the stamp rule. Stamp only on a real change.
- D6: `markStaleSessions` stamps, unlike `ended_at`.
- D7: `updateSwarmSessionPersona` carries the value forward.
- D8 and D9: the surface sweep, and the surfaces left unchanged.

Add one row to the top of the table in `docs/adr/index.md`, above the `279-wikilinks-not-links`
row. Use this row format:

```
| [280-swarm-session-status-changed-at](280-swarm-session-status-changed-at.md) | <one-paragraph summary> |
```

**Check:** the ADR file exists. The index file has the new row at the top. Search `docs/adr/index.md`
for `280-swarm-session-status-changed-at`.

## Step 9 — Check the work against the validation criteria

**Agent:** coder

Run every check in section 4. Confirm every result. Fix any failure. Run the checks again after
every fix.

---

## 4. Validation criteria

The work is complete when every item below passes.

1. **LSP is clean.** `lsp__get_diagnostics` returns no errors for the workspace. No exceptions for
   test files. No exceptions for files that you did not edit.
2. **`pnpm -r run build` passes** with zero errors.
3. **`pnpm typecheck` passes** with zero errors.
4. **`pnpm run lint` passes** with zero errors and zero warnings. This command also runs Prettier.
   Prettier handles the formatting. You do not need to match the format by hand.
5. **The fast test suite passes.** `pnpm run test` is green.
6. **Every surface carries the field.** For each surface below, confirm the field is present:
   - `GET /api/sessions` — each session object has `statusChangedAt`.
   - `GET /api/sessions/:id` — the session object has `statusChangedAt`.
   - `GET /api/sessions/:id/log` — the session object has `statusChangedAt`.
   - `GET /api/sessions/:id/transcript` — the session object has `statusChangedAt`.
   - `drone-swarm session list` — the JSON output has `statusChangedAt`.
   - `/swarm-session list` — the printed table has the new column.
   - `mcp-swarm` tool `swarm.session.list` — the response has `statusChangedAt`.
7. **The backfill works.** A test proves that a legacy row gets `status_changed_at` equal to its
   `updatedAt`. A test proves the backfill runs one time only.
8. **The stamp rule works.** A test proves the timestamp moves on a real status change. A test
   proves the timestamp does NOT move on a redundant status write.
9. **The unchanged surfaces stay unchanged.** No file under `drone-coordinator-ui/` changed. No
   change to the WebSocket initial-state dump in `drone-coordinator/src/index.ts`. No change to the
   `drone-gateway` console output.
10. **The ADR exists.** `docs/adr/280-swarm-session-status-changed-at.md` exists. The index row is
    present.
11. **Every edit is verified.** For each changed file, the new text is present in the file. Search
    the file for the new text. The old text is gone.

## 5. Out of scope

- The coordinator UI sessions page. The operator chose to leave it unchanged.
- The `drone-gateway` console output. The operator chose to leave it unchanged.
- The WebSocket initial-state dump. It stays `beacon_sessions`-shaped.
- A bulk re-stamp of existing rows beyond the one-time backfill.

---

## 6. Execution summary (completed 2026-11-19, branch `feat/session-status-changed-at`)

All 9 steps are done. Commit `13e1b954` (`feat(coordinator): add status_changed_at to swarm sessions (ADR 280)`).

**What changed**

- `drone-coordinator/src/db/init.ts` — the three existing swarm-session migrations plus the new
  `status_changed_at` migration moved into an exported `migrateSwarmSessionColumns(db)` (next to
  `makeBeaconPortOptional`). The backfill `UPDATE swarm_sessions SET status_changed_at = updatedAt
  WHERE status_changed_at IS NULL` runs inside the add-column guard, so it runs one time only.
- `drone-coordinator/src/db/swarm-sessions.ts` — `SwarmSession.statusChangedAt: number | null`
  (required, nullable), `SwarmSessionRow.status_changed_at`, mapped in `rowToSwarmSession`. A shared
  pure `nextStatusChangedAt` helper moves the stamp only on a real change. `createSwarmSession`
  stamps `now`; `updateSwarmSessionStatus`, `transitionSessionStatus`, and `markStaleSessions` stamp
  on change; `updateSwarmSessionPersona` carries the value forward (still sets the column).
- `drone-coordinator/src/db/index.ts` — re-exports `migrateSwarmSessionColumns` (needed by the test).
- `drone-coordinator/src/routes/swarm.ts` — `statusChangedAt` added to the hand-picked session
  objects in `GET /sessions/:id/log` and `GET /sessions/:id/transcript`.
- `drone-agent/src/plugins/swarm/session-command.ts` — `/swarm-session list` gains a
  `statusChangedAt` column (ISO string, `-` when null).
- `docs/adr/280-swarm-session-status-changed-at.md` (new) + an index row at the top of
  `docs/adr/index.md`.

**Tests added** — `db.test.ts` (3 migration cases + 6 stamp cases), `routes/swarm.test.ts` (3),
`transcript.test.ts` literal, `drone-swarm/test/cli.test.ts`, `drone-agent/test/session-command.test.ts`,
`mcp-swarm/test/mapping.test.ts`.

**Validation** — LSP clean; `pnpm -r run build`, `pnpm typecheck`, `pnpm run lint` all pass; the fast
suite is green (4743 passed). All 11 criteria in section 4 hold.

**Note on a deviation** — the plan did not list `drone-coordinator/src/db/index.ts`, but the test
imports `migrateSwarmSessionColumns` from `../src/db/index.js`, so the export was added there.

**Pre-existing, unrelated failure** — `drone-coordinator/test/wiki-routes.test.ts > GET /api/wiki/graph`
fails on the clean tree too (wiki graph / pitch pages). Not caused by this work.

**Unchanged surfaces (verified)** — no file under `drone-coordinator-ui/`, no change to the WS
initial-state dump in `drone-coordinator/src/index.ts`, no change to `drone-gateway`.
