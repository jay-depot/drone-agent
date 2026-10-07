---
tags: [decision, swarm, types]
related: [048-large-file-splitting.md, drone-swarm-common.md]
---

# 049 — db-helpers structural types (any → Database/Statement)

**Summary**: Replaced `any` annotations in `drone-swarm-common/src/db-helpers.ts` with minimal structural `Database`/`Statement` interfaces matching the better-sqlite3 subset actually used.

## Context

`drone-swarm-common/src/db-helpers.ts` holds the shared CRUD helpers (`getRow`, `listRows`, `createRow`, `updateRow`, `deleteRow`) used by the beacon and coordinator entity modules after the large-file-splitting refactor ([048-large-file-splitting](048-large-file-splitting.md)). The `db` parameter is a thunk `() => Database` so callers can pass `getDatabase` without worrying about initialization order.

Originally the helpers used `any` for the database/statement parameter, which triggered `@typescript-eslint/no-explicit-any` lint errors in strict mode.

## Decision

Define two minimal structural interfaces at the top of `db-helpers.ts` instead of `any`:

```ts
interface Statement {
  get<T>(...params: unknown[]): T | undefined;
  all<T>(...params: unknown[]): T[];
  run(...params: unknown[]): { changes: number };
}
interface Database {
  prepare(sql: string): Statement;
}
```

These match the better-sqlite3 subset the helpers call (`prepare`, `get`, `all`, `run`). Using structural types — rather than importing `better-sqlite3`'s own `Database` type — keeps `drone-swarm-common` from depending on `better-sqlite3` directly. The beacon/coordinator packages still import `better-sqlite3` for their own `getDatabase` thunks; the structural interface is satisfied structurally at the call boundary.

## Consequences

- Eliminates `@typescript-eslint/no-explicit-any` lint errors in the shared helper without adding a `better-sqlite3` dependency to `drone-swarm-common`.
- **Does not** resolve the pre-existing `better-sqlite3` `Database` vs `Database` type incompatibility still present in `drone-beacon/src/db/*` and `drone-coordinator/src/db/*` (those packages import the concrete `BetterSqlite3.Database` and mismatch against the shared `Database` structural type in some signatures). That remains an open typecheck issue, tracked separately.

## Source

- Commit `0277eeaa` — `fix: replace any with minimal local Database/Statement interfaces in db-helpers.ts`
- Commit `498e68d2` — `Run linter and formatter` (carried the fix through formatting + a concurrent db-helpers architecture insight)
