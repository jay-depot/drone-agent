import { describe, it, expect } from 'vitest';
import { nameStatusToItems } from '../src/plugins/git/types.js';

// `nameStatusToItems` consumes `git diff --name-status` (tab-separated),
// NOT `git status --porcelain` (space-separated). These tests lock that in.
describe('nameStatusToItems', () => {
  it('parses tab-separated M/A/D lines with real paths', () => {
    const out = nameStatusToItems(
      'M\tsrc/a.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\n'
    );
    expect(out).toEqual([
      { kind: 'modified', path: 'src/a.ts' },
      { kind: 'added', path: 'src/new.ts' },
      { kind: 'removed', path: 'src/old.ts' },
    ]);
  });

  it('parses rename/copy as removed(old) + added(new) pairs', () => {
    const out = nameStatusToItems('R050\tsrc/old.ts\tsrc/new.ts\n');
    expect(out).toEqual([
      { kind: 'removed', path: 'src/old.ts' },
      { kind: 'added', path: 'src/new.ts' },
    ]);
  });

  it('does NOT choke on porcelain output (no `??` -> modified mislabel)', () => {
    // This is the exact format restore.ts used to feed in by mistake.
    const porcelain = ' M src/foo.ts\nA  src/bar.ts\n?? new.ts\n';
    // Our parser keys off the TAB; porcelain has none, so these lines are
    // skipped (not mislabeled as modified). That is the safe behavior.
    expect(nameStatusToItems(porcelain)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(nameStatusToItems('')).toEqual([]);
  });

  it('handles a mixed rename + modified batch', () => {
    const out = nameStatusToItems('M\ta.ts\nR100\tb.ts\tc.ts\nA\td.ts\n');
    expect(out).toEqual([
      { kind: 'modified', path: 'a.ts' },
      { kind: 'removed', path: 'b.ts' },
      { kind: 'added', path: 'c.ts' },
      { kind: 'added', path: 'd.ts' },
    ]);
  });
});
