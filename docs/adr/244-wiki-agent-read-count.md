---
tags: [decision, coordinator, wiki, accounting, read-count, rest, beacon, coordinator-ui, adr]
related:
  [
    decisions/243-orphan-tool-message-pairing.md,
    decisions/216-coordinator-ui-wiki-table-and-filters.md,
    decisions/206-wiki-delete-coordinator-scope.md,
    decisions/210-beacon-proxy-error-forwarding.md,
    decisions/179-swarm-memory-rag-retrieval.md,
    modules/drone-coordinator.md,
    modules/drone-beacon.md,
    modules/drone-coordinator-ui.md,
    modules/drone-core.md,
  ]
---

# 244: Coordinator wiki — agent read count

**Status**: Implemented (2026-10-10) · **Branch**: `feat/swarm-rag-accounting` · **Plan**: project-memory `plan-wiki-agent-read-count`

**Summary**: The swarm's durable memory wiki had no accounting for which pages agents actually consult. This decision adds a per-page **agent read count**: a counter that starts at `0` and increments once for every genuine **agent** read of a coordinator wiki page body. The count is stored in a **new coordinator SQLite table** (`wiki_page_metadata`, named for future metadata fields, not just counts), incremented from the **beacon** — the one chokepoint that sees exactly agent reads — and surfaced in the coordinator web UI as a sortable **Agent Reads** column on the wiki list and an **Agent Reads** field on the detail page.

## Context

The coordinator's wiki is **flat Markdown files** (`<configDir>/knowledge-base/<id>.md`), served by the shared `drone-swarm-common/src/wiki-storage.ts`. There is **no** coordinator wiki table — the request's premise of "add a column to the wiki table" did not match the code. Two similarly-named stores invite confusion: the coordinator `knowledge` table is an unrelated key/value registry (`/api/knowledge/*`, ADR 010's sync), and the beacon's `wiki_pages`/`wiki_sources`/`wiki_chunks`/`wiki_vec_chunks` tables are the semantic-search **vector index**, not an authoring store.

Agents read wiki pages through **one** path: the `swarm__wiki_read` tool calls the **beacon** (`GET /wiki/:pageId`), which merges beacon-origin and coordinator-origin versions and tags each with its `origin`. Agents never call the coordinator directly; the beacon is the sole trust gate. Three other readers touch the same content and must **not** be counted:

1. **The beacon's own indexer.** `WikiIndexer.fetchPageContent` reads coordinator page bodies (and the list) by calling the coordinator directly, on every 5-minute sweep — machine housekeeping, not an agent read.
2. **The human web UI.** It calls the coordinator's `GET /api/wiki/:pageId` on the web port.
3. **Beacon-origin pages.** The accounting is coordinator-only.

## Decision

1. **Storage — a new coordinator table.** `wiki_page_metadata(page_id TEXT PRIMARY KEY, read_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER NOT NULL)`, created additively (`CREATE TABLE IF NOT EXISTS`) in `drone-coordinator/src/db/init.ts`, with a dedicated `db/wiki-page-metadata.ts` module (`incrementWikiReadCount`, `getWikiReadCount`, `getWikiReadCounts`, `deleteWikiPageMetadata`), re-exported from `db/index.ts`. Rejected: a `readCount` frontmatter field on the page (every read would rewrite `<id>.md`, causing write amplification and beacon vector-reindex churn) and overloading the `knowledge` table (an unrelated store). The table is named for the **general** case because later iterations will add more per-page fields.
2. **Increment chokepoint — the beacon, coordinator-origin only.** The beacon's agent-facing `GET /wiki/:pageId` handler fires a **fire-and-forget** `POST {coordinator}/api/wiki/:pageId/read` for coordinator-origin versions, in **both** the `?scope=coordinator` and no-scope branches. The beacon route is the only chokepoint that sees exactly agent reads: it excludes the indexer (which calls the coordinator directly) and the human web UI (which never touches the beacon).
3. **What counts.** Only explicit page-body reads. `?scope=beacon` reads, `GET /wiki` (list), `GET /wiki/search`, `/wiki/lint`, `/wiki/reindex`, and the RAG/semantic-search path (which hits the vector index and never reads a body) do **not** count. A no-scope read returning both a beacon and a coordinator version increments by exactly **1**. Repeat reads count each time.
4. **The coordinator merge.** The coordinator's `GET /api/wiki` and `GET /api/wiki/:pageId` handlers merge the count in from `wiki_page_metadata` (`0` when no row exists). `DroneWikiPageMeta` (drone-core) gains an **optional** `agentReadCount?: number`; the shared storage layer stays count-free and beacon-origin metadata carries no count.
5. **The write route.** `POST /api/wiki/:pageId/read` (no body) does one **atomic, unconditional** upsert and returns `{ agentReadCount }`. No existence check — an orphan row is harmless (deletes cascade; a row left by an out-of-band `rm` is invisible because the UI iterates pages, not rows). Because `registerRoutes` runs inside `buildApp()`, the route is mounted on **both** coordinator servers (mTLS primary + HTTP web) with no extra wiring; a co-located beacon reaches it over loopback, which bypasses web auth.
6. **Deletion.** The coordinator's `DELETE /api/wiki/:pageId` cascade-deletes the metadata row after a successful file delete. No prune sweep, no tombstones.
7. **UI.** A sortable **Agent Reads** column between **Word Count** and **Source Sessions** (new `'reads'` sort key), and an **Agent Reads** cell in the wiki detail Information card. No filter toggle this iteration.

## Consequences

- Read frequency — previously invisible — is now a first-class, query-ready per-page metric, and the `wiki_page_metadata` table is the seed for later per-page metadata.
- Counting is **best-effort**: a coordinator outage drops the increment silently and never breaks an agent read. Counts may therefore under-report during coordinator downtime — acceptable for an accounting signal.
- Accepted wart: a `drone-swarm wiki read` that goes **through the coordinator** does not count, while the same read through the beacon would; the CLI is an operator tool, not an agent.
- Orphan metadata rows (page removed out-of-band) are harmless and self-healing-by-irrelevance; no sweep is needed.

## Validation

- New tests at every layer: `drone-coordinator/test/wiki-page-metadata.test.ts` (increment/get/list/delete), `drone-coordinator/test/routes/wiki.test.ts` (`POST …/read` increments; list/detail merge; delete cascades), `drone-beacon/test/wiki-origin-reads.test.ts` (fires for coordinator-origin reads in both branches; **not** for beacon-origin/list/search), and coordinator-UI `wiki-sort`/`wiki-page-table`/`wiki-detail` tests.
- `pnpm -r run build`, `pnpm run lint`, and `pnpm run test` pass; LSP clean.

## Related

- [216-coordinator-ui-wiki-table-and-filters](216-coordinator-ui-wiki-table-and-filters.md) — the wiki table + derived-field precedent this extends
- [206-wiki-delete-coordinator-scope](206-wiki-delete-coordinator-scope.md) — no-scope delete semantics the cascade rides
- [210-beacon-proxy-error-forwarding](210-beacon-proxy-error-forwarding.md) — the beacon proxy helper the increment uses
- [179-swarm-memory-rag-retrieval](179-swarm-memory-rag-retrieval.md) — the RAG path that advertises pages but does not count as a read
- [drone-coordinator](../../drone-coordinator/) — the table, routes, and module
- [drone-beacon](../../drone-beacon/) — the increment chokepoint
- [drone-coordinator-ui](../../drone-coordinator-ui/) — the Agent Reads column and detail field
