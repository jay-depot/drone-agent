---
key: swarm-knowledge-base-plan
tags:
  []
created: 2026-06-29T01:37:23.461Z
updated: 2026-06-29T02:35:37.546Z
---

# Part 2: Swarm-wide Conversation Log Analysis, Knowledge Extraction, Knowledge Base Maintenance & Retrieval

## Summary

Implemented an LLM Wiki-style knowledge base for the swarm. Session logs (swarm_events on coordinator, event_log on beacon) are the raw sources. The wiki is a maintained, compounding collection of markdown pages stored on the server. The knowledge table is reserved as a future vector index (phase 5), not built now.

## Architecture

### LLM Wiki Pattern (adapted)

| LLM Wiki Layer | Drone Equivalent |
|---|---|
| **Raw sources** (immutable) | Session logs (swarm_events on coordinator, event_log on beacon) |
| **The wiki** (maintained) | Swarm knowledge base — markdown pages on beacon/coordinator filesystem |
| **The schema** (maintenance contract) | A skill or persona defining ingest/query/lint workflows |
| **Ingest** | Process session logs → extract knowledge → update existing wiki pages, note contradictions, maintain cross-references |
| **Query** | Agent reads wiki pages during work → good answers filed back as new pages |
| **Lint** | Periodic health-check: stale claims, contradictions, orphan pages, missing cross-references, downward links |

### Storage

- Wiki pages stored as **markdown files** on the server filesystem:
  - Beacon: `./knowledge-base/` (or configurable via `setKnowledgeBaseDir()`)
  - Coordinator: `./knowledge-base/` (or configurable via `setKnowledgeBaseDir()`)
- Pages have YAML frontmatter with at minimum: `title`, `scope` (beacon|coordinator), `tags`, `sources` (list of session log IDs)
- The existing `knowledge` table is **reserved** for a future vector/search index over wiki pages (phase 5). No index built now.

### API Design

All wiki access is through beacon HTTP endpoints. Coordinator requests are always proxied through the beacon (agent never talks to coordinator directly).

**Beacon endpoints:**
- `GET /wiki` — list all wiki pages (beacon + coordinator, scope-tagged)
- `GET /wiki/:pageId` — get a specific wiki page (markdown content + frontmatter)
- `PUT /wiki/:pageId` — create or update a wiki page (body is markdown)
- `DELETE /wiki/:pageId` — delete a wiki page
- `GET /wiki/search?q=...` — search wiki pages (simple text search for now; vector search in phase 5)
- `POST /wiki/lint` — trigger a lint pass (health-check the wiki)

**Coordinator endpoints** (same shape, beacon proxies to these):
- `GET /wiki`, `GET /wiki/:pageId`, `PUT /wiki/:pageId`, `DELETE /wiki/:pageId`
- `GET /wiki/search?q=...`
- `POST /wiki/lint`

### Scope Rules: No Linking Downwards

Wiki pages from beacon and coordinator are in a common pool (merged list, scope-tagged). The "no linking downwards" rule applies:

- **Coordinator-scoped page** → can link to other coordinator-scoped pages, **CANNOT** link to beacon-scoped pages (not all beacons share the same beacon-scoped knowledge)
- **Beacon-scoped page** → can link to coordinator-scoped pages (shared across all beacons) and other beacon-scoped pages

**Enforcement (hard + soft):**
- **Hard enforcement on write**: When `PUT /wiki/:pageId` is called and both the source page and linked target page exist with known scopes, the server rejects writes that create downward links (coordinator page linking to beacon page).
- **Soft enforcement via lint**: The lint operation flags downward links that the server can't catch at write time (links to non-existent pages, stale references after page renames, etc.)

### Agent Tools

The swarm plugin registers wiki tools that call the beacon endpoints:
- `wiki_read` — read a page
- `wiki_write` — create/update a page
- `wiki_search` — search the wiki
- `wiki_list` — list pages
- `wiki_delete` — delete a page
- `wiki_lint` — trigger lint pass

## Files Modified/Created

### drone-core
- `src/wiki-types.ts` (new) — DroneWikiPage, DroneWikiPageMeta, DroneWikiSearchResult types
- `src/index.ts` — re-export wiki types

### drone-coordinator
- `src/wiki-storage.ts` (new) — filesystem management, scope enforcement, lint
- `src/db.ts` — added wiki_pages table
- `src/routes.ts` — added /wiki endpoints

### drone-beacon
- `src/wiki-storage.ts` (new) — filesystem management, scope enforcement, lint
- `src/db.ts` — added wiki_pages table
- `src/routes.ts` — added /wiki endpoints + coordinator proxy; fixed syntax error in principles delete handler

### drone-agent
- `src/plugins/swarm/index.ts` — registered wiki_read, wiki_write, wiki_search, wiki_list, wiki_delete, wiki_lint tools

## Validation
- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes (500 tests)
- All changes committed