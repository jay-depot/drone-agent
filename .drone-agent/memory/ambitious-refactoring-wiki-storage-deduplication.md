---
key: ambitious-refactoring-wiki-storage-deduplication
tags:
  - refactoring
  - architecture
  - duplication
  - drone-shared
  - monorepo
created: 2026-06-30T05:36:46.556Z
updated: 2026-06-30T05:36:46.556Z
---

# 🚀 Ambitious Refactoring Proposal: Extract a Shared `drone-shared` Package

## The Problem

The `drone-beacon` and `drone-coordinator` packages have massive code duplication that violates the DRY principle:

| File              | Lines        | Duplication                                                                        |
| ----------------- | ------------ | ---------------------------------------------------------------------------------- |
| `wiki-storage.ts` | 377 each     | **~98% identical** (only diff is unused import)                                    |
| `tls.ts`          | 124 vs 128   | **~95% identical**                                                                 |
| `db.ts`           | 1295 vs 1478 | **~70% similar** (same tables: personas, skills, insights, principles, wiki_pages) |

The wiki-storage.ts files are nearly identical—just one has an unused `randomUUID` import:

```typescript
// drone-beacon (line 4):
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';

// drone-coordinator (lines 3-4):
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto'; // <-- unused!
```

## The Solution

Create a new `drone-shared` package that extracts common functionality:

```
drone-shared/
├── src/
│   ├── wiki-storage.ts    # Extracted from beacon/coordinator (100% shared)
│   ├── tls.ts             # Parameterized by service name (beacon vs coordinator)
│   ├── db/
│   │   ├── schema.ts      # Shared table definitions
│   │   ├── types.ts       # Shared DB types
│   │   ├── persona.ts     # Shared persona operations
│   │   ├── skill.ts       # Shared skill operations
│   │   ├── insights.ts    # Shared insights/principles
│   │   └── index.ts       # Main export
│   └── index.ts
└── package.json
```

## Benefits

1. **Reduces ~1,000 lines of duplicated code** across the monorepo
2. **Single point of maintenance** — fix wiki storage bugs once
3. **Stronger type safety** — shared types ensure consistency
4. **Easier future services** — adding `drone-gateway` would reuse this code
5. **Aligns with "minimalist" architecture** — shared infrastructure rather than duplicated

## Implementation Strategy

1. **Phase 1**: Create `drone-shared` package with wiki-storage (trivial extraction)
2. **Phase 2**: Refactor TLS to accept a `serviceName` parameter
3. **Phase 3**: Extract common DB operations (personas, skills, insights, principles, wiki_pages)
4. **Phase 4**: Update beacon and coordinator to depend on `drone-shared`

## Risk Assessment

- **Low risk**: The code is already identical — we're just moving it
- **Medium complexity**: Requires updating package.json dependencies and exports
- **Breaking change**: Anyone importing directly from beacon/coordinator wiki-storage would need to update imports
