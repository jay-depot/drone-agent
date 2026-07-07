import { describe, expect, it } from 'vitest';
import { deleteRow, getRow, listRows } from '../src/db-helpers.js';

describe('db-helpers', () => {
  it('getRow returns the selected row', () => {
    const row = { id: 'a1', name: 'alpha' };
    const db = () => ({
      prepare: (_sql: string) => ({
        get: (_id: string) => row,
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    });

    expect(getRow<typeof row>(db, 'items', 'a1')).toEqual(row);
  });

  it('listRows supports filter params', () => {
    const rows = [{ id: 'a1' }, { id: 'a2' }];
    let preparedSql = '';
    const db = () => ({
      prepare: (sql: string) => {
        preparedSql = sql;
        return {
          all: (..._params: unknown[]) => rows,
          get: () => undefined,
          run: () => ({ changes: 0 }),
        };
      },
    });

    expect(
      listRows<{ id: string }>(db, 'items', {
        filter: 'WHERE type = ?',
        params: ['x'],
      })
    ).toEqual(rows);
    expect(preparedSql).toContain('WHERE type = ?');
  });

  it('deleteRow returns false when changes is missing', () => {
    const db = () => ({
      prepare: (_sql: string) => ({
        run: (_id: string) => ({}),
        get: () => undefined,
        all: () => [],
      }),
    });

    expect(deleteRow(db, 'items', 'a1')).toBe(false);
  });

  it('deleteRow returns false when run result is undefined', () => {
    const db = () => ({
      prepare: (_sql: string) => ({
        run: () => undefined,
        get: () => undefined,
        all: () => [],
      }),
    });

    expect(deleteRow(db, 'items', 'a1')).toBe(false);
  });
});
