/**
 * Generic CRUD helpers for SQLite database operations.
 *
 * These helpers reduce boilerplate in entity-specific database modules.
 * The `db` parameter is a thunk (() => Database) so that callers can pass
 * `getDatabase` without worrying about initialization order.
 *
 * The `Database` and `Statement` interfaces defined here are minimal
 * structural types matching the subset of better-sqlite3's API that we
 * actually use. This avoids requiring better-sqlite3 as a dependency of
 * drone-swarm-common itself.
 */

/**
 * Minimal statement interface matching the better-sqlite3 subset we use.
 *
 * Return types are intentionally `unknown` to stay structurally compatible
 * with better-sqlite3's generic Statement signatures across versions.
 * Callers cast to concrete row/result types at helper boundaries.
 */
interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

/** Minimal database interface matching the better-sqlite3 subset we use. */
interface Database {
  prepare(sql: string): Statement;
}

/**
 * Get a single row by ID from any table.
 */
export function getRow<T>(
  db: () => Database,
  table: string,
  id: string
): T | undefined {
  const stmt = db().prepare(`SELECT * FROM ${table} WHERE id = ?`);
  return stmt.get(id) as T | undefined;
}

/**
 * List rows from a table with optional filter, params, and orderBy.
 */
export function listRows<T>(
  db: () => Database,
  table: string,
  options?: {
    filter?: string;
    params?: unknown[];
    orderBy?: string;
  }
): T[] {
  let sql = `SELECT * FROM ${table}`;
  if (options?.filter) sql += ` ${options.filter}`;
  if (options?.orderBy) sql += ` ORDER BY ${options.orderBy}`;
  const stmt = db().prepare(sql);
  const params = options?.params ?? [];
  return (params.length > 0 ? stmt.all(...params) : stmt.all()) as T[];
}

/**
 * Delete a row by ID. Returns true if a row was deleted.
 */
export function deleteRow(
  db: () => Database,
  table: string,
  id: string
): boolean {
  const stmt = db().prepare(`DELETE FROM ${table} WHERE id = ?`);
  const result = stmt.run(id) as { changes?: number } | undefined;
  return (result?.changes ?? 0) > 0;
}

/**
 * Create a row. The data object's keys become the named parameters.
 * Returns the data object back.
 */
export function createRow<T extends Record<string, unknown>>(
  db: () => Database,
  table: string,
  data: T
): T {
  const columns = Object.keys(data).join(', ');
  const values = Object.keys(data)
    .map(k => `@${k}`)
    .join(', ');
  const stmt = db().prepare(
    `INSERT INTO ${table} (${columns}) VALUES (${values})`
  );
  stmt.run(data);
  return data;
}

/**
 * Update a row. Merges data into existing, runs UPDATE.
 * Returns the updated object or undefined if not found.
 */
export function updateRow<T extends Record<string, unknown>>(
  db: () => Database,
  table: string,
  id: string,
  data: Partial<T>,
  existing: T
): T | undefined {
  const setClauses = Object.keys(data)
    .filter(k => k !== 'id')
    .map(k => `${k} = @${k}`);
  if (setClauses.length === 0) return existing;
  const stmt = db().prepare(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = @id`
  );
  stmt.run({ ...data, id });
  return { ...existing, ...data } as T;
}
