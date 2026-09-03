---
key: coordinator-wiki-architecture-map
tags:
  - coordinator
  - wiki
  - memory-pipeline
  - architecture
created: 2026-08-31T01:03:43.584Z
updated: 2026-08-31T01:03:43.584Z
---

Coordinator memory wiki survey (2026-08-30): wiki storage is FILE-based (not SQLite) via drone-swarm-common/src/wiki-storage.ts (writePage/readPage/deletePage/listPages/searchPages/lintPages; kbDir set by coordinator index.ts setKnowledgeBaseDir(configDir + 'knowledge-base')); flat <pageId>.md with hand-rolled YAML frontmatter (id,title,scope beacon|coordinator,tags,sources,createdAt,updatedAt); [[links]] with no-downward-link rule (coordinator cannot link to beacon), enforced on write + lintPages (broken-link/downward-link/orphan). Coordinator REST (all under /api prefix, routes/routes/index.ts): GET /api/wiki, GET/PUT/DELETE /api/wiki/:pageId, GET /api/wiki/search?q=, POST /api/wiki/lint. Auth: primary port = mTLS client-cert pinned to beacon_trust (mtls.ts, /health + POST /api/beacons exempt); web port = Bearer web token only for non-local IPs (web-auth.ts PROTECTED_PREFIXES includes /wiki; Tailscale 100.64/10 + loopback bypass). drone-swarm CLI supports wiki read/write/search only (no list/lint); dialect /api prefix for coordinator, flat for beacon (client.ts url()). Session write side: swarm_sessions(swarm_events)+swarm_events_fts5 SQLite; lifecycle active→stale(hourly markStaleSessions 24h; POST /sessions/mark-stale)→ended(DELETE /api/sync/sessions/:id fires runSessionEndHook fire-and-forget)→processing(POST /sessions/:id/process returns resolved events incl blob: retrieval)→processed(POST :id/processed {summary,notes}); session-end.ts triggers: command (/bin/sh -c {session_id}, 30s) or spawn (coordinator REQUIRES beaconId, sends 'spawn' via sendBeaconCommand reverse-channel WS 10s, HTTP /spawn fallback). wiki_search = case-insensitive substring over title(1.0)/tags(0.8)/content(0.5), re-parses all pages per query, NO vector/semantic anywhere on coordinator (beacon-only sqlite-vec); coordinator FTS5 exists only for swarm event payloads (/api/events/search). Seeded persona coordinator-wiki-librarian + memory-wiki skill in coordinator seedDefaults(); swarm__wiki_write/delete seeded default-hidden in db/init.ts. Separate legacy 'knowledge' SQLite table + /api/knowledge CRUD ≠ wiki.
