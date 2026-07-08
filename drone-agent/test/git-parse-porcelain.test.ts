import { describe, it, expect } from 'vitest';
import { parsePorcelain } from '../src/plugins/git/parse-porcelain.js';

describe('parsePorcelain', () => {
  it('classifies a staged modification in the staged bucket', () => {
    const r = parsePorcelain('M  src/file.ts\n');
    expect(r.staged).toEqual(['M src/file.ts']);
    expect(r.unstaged).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('classifies an unstaged modification in the unstaged bucket (the regression)', () => {
    // Leading space in column 0 = not staged. This is the exact bug that
    // produced "M AGENTS.md reported as staged" when the whole record was trimmed.
    const r = parsePorcelain(' M src/file.ts\n');
    expect(r.unstaged).toEqual(['M src/file.ts']);
    expect(r.staged).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('keeps a leading-space column intact when given raw untrimmed input', () => {
    const r = parsePorcelain(' M src/file.ts\n');
    expect(r.entries[0].index).toBe('');
    expect(r.entries[0].worktree).toBe('M');
  });

  it('classifies untracked files', () => {
    const r = parsePorcelain('?? new.txt\n?? dir/other.ts\n');
    expect(r.untracked).toEqual(['new.txt', 'dir/other.ts']);
    expect(r.staged).toEqual([]);
    expect(r.unstaged).toEqual([]);
  });

  it('handles renames with -> syntax', () => {
    const r = parsePorcelain('R  old.ts -> new.ts\n');
    expect(r.staged).toEqual(['R old.ts -> new.ts']);
    expect(r.entries[0].to).toBe('new.ts');
  });

  it('handles unmerged (conflict) entries', () => {
    const r = parsePorcelain('UU src/conflict.ts\n');
    expect(r.staged).toEqual(['U src/conflict.ts']);
    expect(r.unstaged).toEqual(['U src/conflict.ts']);
  });

  it('handles a fully clean tree', () => {
    const r = parsePorcelain('');
    expect(r.staged).toEqual([]);
    expect(r.unstaged).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('handles mixed staged and unstaged across files', () => {
    const r = parsePorcelain('M  staged.ts\n M unstaged.ts\n?? untracked.ts\n');
    expect(r.staged).toEqual(['M staged.ts']);
    expect(r.unstaged).toEqual(['M unstaged.ts']);
    expect(r.untracked).toEqual(['untracked.ts']);
  });
});
