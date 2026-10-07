---
tags: [decision, refactoring]
related: [architecture/large-file-splitting.md]
---

# ADR 048: Large File Splitting

**Status**: Implemented (2026-07-06)

**Context**: Ten files across the monorepo had grown beyond 1,000 lines, making them hard to navigate, test, and maintain. The largest was `drone-coordinator/test/routes.test.ts` at 2,096 lines.

**Decision**: Split each large file into focused modules organized by domain. Three tiers of priority:

- **Tier 1** (most urgent): `swarm/index.ts` — a monolith doing plugin registration, WebSocket, wiki tools, coordinator tools, heartbeat
- **Tier 2** (high value): `beacon/db.ts` and `coordinator/db.ts` — repetitive CRUD-per-entity pattern
- **Tier 3** (nice to have): LSP plugin files, self-improvement, migration-service, and test files

**Key design decisions**:

1. **SwarmContext pattern**: Factory closure state bundled into a context object passed to module functions, rather than relying on closure capture
2. **Shared CRUD helpers**: Generic `getRow`/`listRows`/`createRow`/`updateRow`/`deleteRow` in `drone-swarm-common` to reduce boilerplate across entity files
3. **Tool factory pattern**: Each tool created via factory function receiving its dependencies, making tools independently testable
4. **Barrel files**: Each module directory has an `index.ts` re-exporting all public symbols

**Consequences**:

- Positive: Each module is now ~20-100 lines, focused on a single concern
- Positive: Entity files in `db/` directories are ~20-40 lines of thin wrappers using shared helpers
- Positive: Test files are now organized by route/feature, improving parallel execution
- Positive: `drone-swarm-common` gained a reusable CRUD utility
- Neutral: The `lsp/server.ts` factory closure was left mostly intact (only module-level helpers extracted) — converting to a class is future work
- Negative: Vitest exclude pattern `'**/spawn.test.ts'` was too broad and caught the new coordinator route test — had to narrow to `'drone-agent/test/spawn.test.ts'`

**Related**: large-file-splitting
