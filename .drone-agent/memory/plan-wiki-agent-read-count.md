---
key: plan-wiki-agent-read-count
tags: []
created: 2026-10-10T04:59:54.392Z
updated: 2026-10-10T04:59:54.392Z
---

# Plan: Coordinator Wiki — Agent Read Count

## Summary

**What:** Add a per-page **agent read count** to the swarm wiki. Each coordinator wiki page gets a counter that starts at `0` and increments once for every genuine **agent** read of the page body. Displayed on the coordinator web UI: as a new sortable column on the wiki list page, and as a field on the wiki detail page. More metadata fields will be added to the same store in later iterations, so the table is named for the general case.

**Why:** Accounting for swarm memory — which pages agents actually consult — is currently invisible. Future iterations build on the same `wiki_page_metadata` table.

**Key architectural facts (verified):**

- The coordinator wiki is **flat Markdown files** (`<configDir>/knowledge-base/<id>.md`), served by the shared `drone-swarm-common/src/wiki-storage.ts`. There is **no** existing coordinator wiki table. (The `knowledge` table is an unrelated key/value registry; the `wiki_*` beacon tables are the vector index.)
- Agents read pages **only** through the beacon: `swarm__wiki_read` → beacon `GET /wiki/:pageId`. The beacon is the sole trust gate.
- Three other readers must **not** be counted: the beacon's own `WikiIndexer` (reads coordinator bodies directly during its 5-minute sweep), the human web UI (coordinator `GET /api/wiki/:pageId`), and beacon-origin pages.

## Design decisions (locked)

| #   | Decision                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | New coordinator SQLite table **`wiki_page_metadata`** (`page_id` PK, `read_count`, `last_read_at`), created additively. New module `db/wiki-page-metadata.ts`.               |
| D2  | Increment fires at the **beacon's** `GET /wiki/:pageId` for **coordinator-origin** versions only, pushed fire-and-forget to a new coordinator `POST /api/wiki/:pageId/read`. |
| D3  | **Only** body reads count. List/search/lint/reindex/semantic-search do **not**. Repeat reads count each time. No-scope read returning both versions = **1**.                 |
| D4  | Optional `agentReadCount?: number` on `DroneWikiPageMeta`; **coordinator routes** merge it in from the table. Shared storage stays count-free.                               |
| D5  | Coordinator `DELETE /api/wiki/:pageId` **cascade-deletes** the metadata row. No prune sweep, no tombstones.                                                                  |
| D6  | UI: column label **`Agent Reads`** between `Word Count` and `Source Sessions`; sortable (`'reads'` key); detail-page grid cell. **No** filter toggle this iteration.         |
| D7  | Route `POST /api/wiki/:pageId/read`, unconditional atomic upsert, no existence check. Beacon call is unawaited and best-effort.                                              |

## Execution order & dependencies

| Step | Agent    | Depends on | Deliverable                                                                          |
| ---- | -------- | ---------- | ------------------------------------------------------------------------------------ |
| 1    | coder    | —          | Coordinator DB schema + `wiki-page-metadata.ts` module (+ unit tests)                |
| 2    | coder    | —          | `agentReadCount?` on `DroneWikiPageMeta` in `drone-core`; rebuild                    |
| 3    | coder    | 1, 2       | Coordinator wiki routes: merge counts, `POST …/read`, cascade delete (+ route tests) |
| 4    | coder    | 3          | Beacon `GET /wiki/:pageId` fire-and-forget increment (+ beacon tests)                |
| 5    | coder    | 2, 3       | Coordinator UI: type, table column, sort, detail cell (+ UI tests)                   |
| 6    | coder    | 1–5        | ADR `244` + README endpoint note + swarm-wiki hub page refresh                       |
| 7    | reviewer | 1–6        | **Final validation** against the criteria below                                      |

---

### Step 1 — Coordinator DB: schema + module _(agent: coder)_

**1a.** In `drone-coordinator/src/db/init.ts`, add to the big `db.exec(\`…\`)`block (e.g. right after the`fragments` table):

```sql
CREATE TABLE IF NOT EXISTS wiki_page_metadata (
  page_id      TEXT PRIMARY KEY,
  read_count   INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER NOT NULL
);
```

**1b.** Create `drone-coordinator/src/db/wiki-page-metadata.ts`:

```ts
import { getDatabase } from './init.js';

/**
 * Increment a page's agent read count, creating the row (count = 1) when it
 * does not exist. Atomic: the upsert and the read-back run in one transaction.
 */
export function incrementWikiReadCount(pageId: string): number {
  return getDatabase().transaction((id: string) => {
    getDatabase()
      .prepare(
        `INSERT INTO wiki_page_metadata (page_id, read_count, last_read_at)
         VALUES (?, 1, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           read_count = read_count + 1,
           last_read_at = excluded.last_read_at`
      )
      .run(id, Date.now());
    const row = getDatabase()
      .prepare('SELECT read_count FROM wiki_page_metadata WHERE page_id = ?')
      .get(id) as { read_count: number };
    return row.read_count;
  })(pageId);
}

export function getWikiReadCount(pageId: string): number {
  const row = getDatabase()
    .prepare('SELECT read_count FROM wiki_page_metadata WHERE page_id = ?')
    .get(pageId) as { read_count: number } | undefined;
  return row?.read_count ?? 0;
}

/** All read counts as pageId → count, for merging onto page lists. */
export function getWikiReadCounts(): Map<string, number> {
  const rows = getDatabase()
    .prepare('SELECT page_id, read_count FROM wiki_page_metadata')
    .all() as Array<{ page_id: string; read_count: number }>;
  return new Map(rows.map(r => [r.page_id, r.read_count]));
}

export function deleteWikiPageMetadata(pageId: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM wiki_page_metadata WHERE page_id = ?')
    .run(pageId);
  return result.changes > 0;
}
```

**1c.** Re-export from `drone-coordinator/src/db/index.ts`:

```ts
export {
  incrementWikiReadCount,
  getWikiReadCount,
  getWikiReadCounts,
  deleteWikiPageMetadata,
} from './wiki-page-metadata.js';
```

**Tests (+):** new file `drone-coordinator/test/wiki-page-metadata.test.ts` — `initDatabase` into a temp dir (mirror `test/helpers/server.ts`), then assert: increment on a fresh id returns `1`; second increment returns `2`; `getWikiReadCount` on an absent id returns `0`; `getWikiReadCounts` returns a map of all rows; `deleteWikiPageMetadata` returns `true` and resets the count to `0` on the next `getWikiReadCount`. Tear down with `closeDatabase()` + `rm`.

**Done when:** module typechecks, tests pass.

---

### Step 2 — `drone-core` type _(agent: coder)_

In `drone-core/src/wiki-types.ts`, add to `DroneWikiPageMeta` (after `linkCount`):

```ts
  /**
   * Coordinator-side accounting: number of agent body-reads of this page.
   * Merged in by the coordinator's wiki routes; absent on beacon-origin
   * metadata and on any response that does not come from the coordinator.
   */
  agentReadCount?: number;
```

**Then run `pnpm -r run build`** (dependent packages resolve `drone-core` from `dist/`, not source).

**Done when:** build succeeds; LSP clean.

---

### Step 3 — Coordinator wiki routes _(agent: coder)_

In `drone-coordinator/src/routes/wiki.ts`, add `import * as db from '../db/index.js';` at the top, then:

**3a. Merge counts on the list** — replace `GET /wiki`'s body:

```ts
app.get<{ Querystring: { tag?: string } }>('/wiki', async request => {
  const { listPages } = await import('drone-swarm-common');
  const pages = await listPages(request.query.tag);
  const counts = db.getWikiReadCounts();
  return pages.map(p => ({ ...p, agentReadCount: counts.get(p.id) ?? 0 }));
});
```

**3b. Merge count on the detail** — replace the `return page;` in `GET /wiki/:pageId`:

```ts
return { ...page, agentReadCount: db.getWikiReadCount(request.params.pageId) };
```

**3c. New read endpoint** (place next to the other `/wiki/:pageId` routes):

```ts
app.post<{ Params: { pageId: string } }>(
  '/wiki/:pageId/read',
  async request => {
    const agentReadCount = db.incrementWikiReadCount(request.params.pageId);
    return { agentReadCount };
  }
);
```

**3d. Cascade delete** — in `DELETE /wiki/:pageId`, after `const deleted = await deletePage(pageId);` confirms deletion and before `return { success: true };`, add `db.deleteWikiPageMetadata(pageId);`.

> `registerRoutes` runs inside `buildApp()`, which builds **both** the mTLS primary server and the HTTP web server — so `POST /api/wiki/:pageId/read` is mounted on both automatically. No auth changes needed.

**Tests (+):** extend `drone-coordinator/test/routes/wiki.test.ts` using the existing `makeApp()` helper: `POST /api/wiki/foo/read` returns `{ agentReadCount: 1 }`, a second call returns `2`; `GET /api/wiki` returns pages each carrying `agentReadCount: 0` before any read; `GET /api/wiki/foo` carries the count; and after `DELETE /api/wiki/foo` then re-`PUT` + `GET`, the count is `0` again (cascade).

**Done when:** route tests pass; LSP clean.

---

### Step 4 — Beacon increment _(agent: coder)_

In `drone-beacon/src/routes/wiki.ts`, add a helper near the top (imports already include `proxyWikiToCoordinator`):

```ts
/**
 * Best-effort: tell the coordinator an agent read this coordinator-origin
 * page. Never awaited — a coordinator outage must not break an agent read.
 */
function bumpCoordinatorReadCount(pageId: string): void {
  proxyWikiToCoordinator(
    'POST',
    `/wiki/${encodeURIComponent(pageId)}/read`
  ).catch(() => {});
}
```

Then call it unawaited in the **two** coordinator-version success branches of `GET /wiki/:pageId`:

- In the `?scope=coordinator` branch, after `const result = await proxyWikiToCoordinator(...)` succeeds and before `return withOrigin(result, 'coordinator');`:
  ```ts
  bumpCoordinatorReadCount(request.params.pageId);
  ```
- In the no-scope branch, after `coordinatorVersion` is resolved from the try/catch and before the final `return { pageId, versions: […] }`:
  ```ts
  if (coordinatorVersion) {
    bumpCoordinatorReadCount(request.params.pageId);
  }
  ```

Do **not** add it to the `?scope=beacon` branch, to `GET /wiki`, `GET /wiki/search`, `/wiki/lint`, or `/wiki/reindex`.

**Tests (+):** extend `drone-beacon/test/wiki-origin-reads.test.ts` (it already mocks `proxyWikiToCoordinator`): a `?scope=coordinator` read calls `proxyWikiToCoordinator` with `('POST', '/wiki/<id>/read')`; a no-scope read where the coordinator version exists also calls it; a no-scope read with only a beacon version does **not**; a `?scope=beacon` read does **not**; `GET /wiki` and `GET /wiki/search` do **not**.

**Done when:** beacon tests pass; LSP clean.

---

### Step 5 — Coordinator UI _(agent: coder)_

**5a.** `drone-coordinator-ui/src/lib/types.ts` — add to `WikiPageMeta` (after `linkCount`):

```ts
  agentReadCount?: number;
```

**5b.** `drone-coordinator-ui/src/lib/wiki-sort.ts` —
`export type WikiSortKey = 'title' | 'created' | 'updated' | 'words' | 'reads' | 'sources';`
add `'reads'` to `SORT_KEYS`; add to `compareByKey`:

```ts
    case 'reads':
      return (a.agentReadCount ?? 0) - (b.agentReadCount ?? 0);
```

**5c.** `drone-coordinator-ui/src/components/wiki-page-table.tsx` —
add `const COL_READS = 'w-[104px]';` beside the other width consts; insert into `COLUMNS` **between `words` and `sources`**:

```tsx
  { key: 'reads', label: 'Agent Reads', className: COL_READS },
```

and the matching body cell **between** the word-count and sources cells:

```tsx
<TableCell className={`${COL_READS} text-xs text-muted-foreground`}>
  {page.agentReadCount ?? 0}
</TableCell>
```

**5d.** `drone-coordinator-ui/src/pages/wiki-detail.tsx` — in the Information card's `grid grid-cols-2` block, add a cell after `Updated`:

```tsx
<div>
  <span className="text-muted-foreground">Agent Reads</span>
  <p className="mt-0.5">{page.agentReadCount ?? 0}</p>
</div>
```

**Tests (+):**

- `src/components/wiki-page-table.test.tsx` — the header test's list gains `'Agent Reads'`; the centering test's **body cell index for Source Sessions changes from `5` to `6`** (new column inserted before it); add a test that renders `agentReadCount` and asserts the value shows.
- `src/lib/wiki-sort.test.ts` — add a case sorting by `'reads'` (asserts order incl. the `?? 0` default for pages missing the field).
- `src/pages/wiki-detail.test.tsx` — add an assertion that the Information card shows `Agent Reads` with the expected value.

**Done when:** UI tests pass; `pnpm run lint` clean.

---

### Step 6 — Documentation _(agent: coder)_

**6a.** Write `docs/adr/244-wiki-agent-read-count.md` (next free number; 243 is current latest). Use the existing ADR format (see e.g. `docs/adr/216-coordinator-ui-wiki-table-and-filters.md`). Record: the file-store-vs-table finding, the `wiki_page_metadata` table, the beacon-chokepoint increment with its rationale (excludes the indexer + human UI), the fire-and-forget best-effort contract, the optional merged `agentReadCount` field, cascade delete, and the accepted wart (drone-swarm CLI reads through the coordinator are not counted).

**6b.** `drone-coordinator/README.md` — add `POST /wiki/:pageId/read` to the wiki endpoint list (add a short `### Wiki` block if one does not already exist).

**6c.** Refresh the swarm-wiki hub page `coordinator-wiki-storage-schema-rest`: note the new `POST /api/wiki/:pageId/read` endpoint and the `agentReadCount` merged field. (If the wiki-librarian owns this page, leave the edit for that persona and instead add a follow-up note in project memory.)

**Done when:** ADR written; README valid; no build/lint impact.

---

### Step 7 — Final validation _(agent: reviewer)_

Check the whole change against the criteria below; do not mark the plan done until every line passes. Report each gate's result explicitly.

---

## Validation criteria

1. **LSP:** `lsp__get_diagnostics` reports **clean** across the workspace (no errors, no warnings) — including new/modified files in `drone-coordinator`, `drone-beacon`, `drone-coordinator-ui`, `drone-core`.
2. **Build:** `pnpm -r run build` passes with zero errors (run after the `drone-core` type change).
3. **Lint:** `pnpm run lint` passes with zero errors.
4. **Fast tests:** `pnpm run test` passes.
5. **New coverage exists at every layer:**
   - `drone-coordinator/test/wiki-page-metadata.test.ts` — increment/get/list/delete semantics.
   - `drone-coordinator/test/routes/wiki.test.ts` — `POST /api/wiki/:pageId/read` increments; list/detail merge `agentReadCount`; delete cascades.
   - `drone-beacon/test/wiki-origin-reads.test.ts` — increment fires for coordinator-origin reads (both branches) and **not** for beacon-origin / list / search.
   - `drone-coordinator-ui` — table header + value, `'reads'` sort, detail cell.
6. **Behavioral spot-checks (by reasoning against the code, not manual run):**
   - A `swarm__wiki_read` with `?scope=beacon` never touches `wiki_page_metadata`.
   - The beacon's 5-minute `WikiIndexer` sweep does not inflate counts (it calls the coordinator directly).
   - A human web-UI page view does not inflate counts.
   - A no-scope read returning both a beacon and a coordinator version increments by exactly `1`.
7. **Docs:** `docs/adr/244-wiki-agent-read-count.md` exists and matches the shipped design; README lists the new endpoint.
8. **No dead code / no stray comments** introduced (per AGENTS.md); file sizes within limits.

---

## COMPLETION SUMMARY (2026-10-10, branch `feat/swarm-rag-accounting`)

**Status: all 7 steps executed; all validation criteria pass.**

### What shipped
- **Step 1** — new coordinator table `wiki_page_metadata(page_id PK, read_count, last_read_at)` in `drone-coordinator/src/db/init.ts`; new module `drone-coordinator/src/db/wiki-page-metadata.ts` (`incrementWikiReadCount`, `getWikiReadCount`, `getWikiReadCounts`, `deleteWikiPageMetadata`), re-exported from `db/index.ts`. New `drone-coordinator/test/wiki-page-metadata.test.ts` (7 tests).
- **Step 2** — optional `agentReadCount?: number` on `DroneWikiPageMeta` (`drone-core/src/wiki-types.ts`); `pnpm -r run build` re-run.
- **Step 3** — `drone-coordinator/src/routes/wiki.ts`: list + detail merge counts; new `POST /api/wiki/:pageId/read` (atomic upsert); `DELETE` cascades the row. 5 new route tests.
- **Step 4** — `drone-beacon/src/routes/wiki.ts`: `bumpCoordinatorReadCount()` fires fire-and-forget `POST /wiki/:pageId/read` at exactly the two coordinator-origin success points (`?scope=coordinator` + no-scope-when-present). 5 new beacon tests.
- **Step 5** — coordinator UI: `agentReadCount?` on `WikiPageMeta` (`lib/types.ts`); `'reads'` sort key (`lib/wiki-sort.ts`); **Agent Reads** column between Word Count and Source Sessions (`components/wiki-page-table.tsx`); detail Information-card cell (`pages/wiki-detail.tsx`). Tests updated/added (sort, table header+value+cells, detail).
- **Step 6** — `docs/adr/244-wiki-agent-read-count.md` + ADR index entry; `drone-coordinator/README.md` wiki endpoint list; swarm-wiki hub page `coordinator-wiki-storage-schema-rest` refreshed (new §5 on the read count).

### Validation results
1. **LSP** — clean (no errors/warnings).
2. **Build** — `pnpm -r run build` zero errors.
3. **Lint** — `pnpm run lint` zero errors (prettier reformatted a few files cosmetically; re-verified).
4. **Fast tests** — `pnpm run test`: **3822 passed | 14 skipped** (286 files, 3 skipped). (Pre-existing, unrelated `sessions.test.tsx` timer notice in the UI suite is not caused by this work — file untouched, all tests pass.)
5. **Coverage** — present at all four layers (see steps above).
6. **Spot-checks** — confirmed by grep/inspection: increment call sites exist only at the 2 beacon coordinator-origin branches; `incrementWikiReadCount` is called only in the `POST /read` route; `GET /api/wiki/:pageId` only *reads* the count; the beacon `WikiIndexer` calls the coordinator directly (never through the beacon route), so sweeps do not inflate counts.
7. **Docs** — ADR 244 written and matching the shipped design; README lists the new endpoint.
8. **Hygiene** — no dead code / stray comments introduced; files within size limits.

### Notes
- No deviations from the plan. The plan's naming guess for the ADR (`244`, next free after `243`) was correct.
- Commits on the feature branch: plan artifact → steps 1–3 → step 4 → step 5 → step 6 (docs).
