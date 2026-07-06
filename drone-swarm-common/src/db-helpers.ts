/**
 * Generic CRUD helpers for SQLite database operations.
 *
 * These helpers reduce boilerplate in entity-specific database modules.
 * The `db` parameter is a thunk (() => Database.Database) so that
 * callers can pass `getDatabase` without worrying about initialization order.
 *
 * The `Database.Database` type comes from `better-sqlite3` which is a
 * dependency of the consuming packages (drone-beacon, drone-coordinator),
 * not of drone-swarm-common itself. We use `any` for the db parameter
 * to avoid requiring the type in this package.
 */

/**
 * Get a single row by ID from any table.
 */
export function getRow<T>(db: () => any, table: string, id: string): T | undefined {
  const stmt = db().prepare(`SELECT * FROM ${table} WHERE id = ?`);
  return stmt.get(id) as T | undefined;
}

/**
 * List rows from a table with optional filter, params, and orderBy.
 */
export function listRows<T>(
  db: () => any,
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
export function deleteRow(db: () => any, table: string, id: string): boolean {
  const stmt = db().prepare(`DELETE FROM ${table} WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Create a row. The data object's keys become the named parameters.
 * Returns the data object back.
 */
export function createRow<T extends Record<string, unknown>>(
  db: () => any,
  table: string,
  data: T
): T {
  const columns = Object.keys(data).join(', ');
  const values = Object.keys(data).map(k => `@${k}`).join(', ');
  const stmt = db().prepare(`INSERT INTO ${table} (${columns}) VALUES (${values})`);
  stmt.run(data);
  return data;
}

/**
 * Update a row. Merges data into existing, runs UPDATE.
 * Returns the updated object or undefined if not found.
 */
export function updateRow<T extends Record<string, unknown>>(
  db: () => any,
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
