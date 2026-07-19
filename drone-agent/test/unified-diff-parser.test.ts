import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/shared/unified-diff-parser.js';

describe('parseUnifiedDiff', () => {
  // ── Basic parsing ──────────────────────────────────────────────────

  it('parses a basic single-hunk diff', () => {
    const diff = [
      '@@ -5,7 +5,7 @@ function foo():',
      '     a',
      '     b',
      '-    return c',
      '+    return d',
      '     e',
      '     f',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);

    const hunk = hunks[0];
    expect(hunk.anchors).toEqual(['function foo():']);
    expect(hunk.lineHint).toBe(5);
    expect(hunk.sectionHeading).toBe('function foo():');
    expect(hunk.contextBefore).toEqual(['    a', '    b']);
    expect(hunk.oldLines).toEqual(['    return c']);
    expect(hunk.newLines).toEqual(['    return d']);
    expect(hunk.contextAfter).toEqual(['    e', '    f']);
  });

  it('extracts context lines after the change zone correctly', () => {
    const diff = ['@@ -1,4 +1,4 @@', ' before', '-old', '+new', ' after'].join(
      '\n'
    );

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);

    const hunk = hunks[0];
    expect(hunk.contextBefore).toEqual(['before']);
    expect(hunk.oldLines).toEqual(['old']);
    expect(hunk.newLines).toEqual(['new']);
    expect(hunk.contextAfter).toEqual(['after']);
  });

  // ── Multi-hunk ─────────────────────────────────────────────────────

  it('parses a multi-hunk diff', () => {
    const diff = [
      '@@ -1,3 +1,3 @@ section_one',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
      '@@ -10,2 +10,2 @@ section_two',
      ' x',
      '-y',
      '+Y',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);

    expect(hunks[0].sectionHeading).toBe('section_one');
    expect(hunks[0].lineHint).toBe(1);
    expect(hunks[0].oldLines).toEqual(['b']);
    expect(hunks[0].newLines).toEqual(['B']);

    expect(hunks[1].sectionHeading).toBe('section_two');
    expect(hunks[1].lineHint).toBe(10);
    expect(hunks[1].oldLines).toEqual(['y']);
    expect(hunks[1].newLines).toEqual(['Y']);
  });

  // ── Section headings ───────────────────────────────────────────────

  it('captures section headings from @@ headers', () => {
    const diff = [
      '@@ -5,7 +5,7 @@ def foo():',
      '     pass',
      '-    old',
      '+    new',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0].sectionHeading).toBe('def foo():');
    expect(hunks[0].anchors).toEqual(['def foo():']);
  });

  it('handles @@ headers without section headings', () => {
    const diff = ['@@ -10,4 +10,4 @@', ' a', '-b', '+B'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0].sectionHeading).toBeUndefined();
    expect(hunks[0].anchors).toEqual([]);
  });

  // ── Line number extraction ─────────────────────────────────────────

  it('extracts lineHint from header', () => {
    const diff = ['@@ -42,3 +44,2 @@', ' a', '-b', '+B'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0].lineHint).toBe(42);
  });

  it('handles headers without explicit line counts (implied 1)', () => {
    const diff = ['@@ -10 +12 @@', '-old', '+new'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0].lineHint).toBe(10);
    expect(hunks[0].oldLines).toEqual(['old']);
    expect(hunks[0].newLines).toEqual(['new']);
  });

  // ── Pure insertion ─────────────────────────────────────────────────

  it('parses pure insertion hunks (empty oldLines)', () => {
    const diff = ['@@ -1,0 +1,3 @@', '+line1', '+line2', '+line3'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toEqual([]);
    expect(hunks[0].newLines).toEqual(['line1', 'line2', 'line3']);
    expect(hunks[0].contextBefore).toEqual([]);
    expect(hunks[0].contextAfter).toEqual([]);
  });

  // ── Pure deletion ──────────────────────────────────────────────────

  it('parses pure deletion hunks (empty newLines)', () => {
    const diff = ['@@ -3,3 +0,0 @@', '-gone1', '-gone2', '-gone3'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toEqual(['gone1', 'gone2', 'gone3']);
    expect(hunks[0].newLines).toEqual([]);
  });

  // ── No-newline markers ─────────────────────────────────────────────

  it('silently drops \\ No newline at end of file markers', () => {
    const diff = [
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      '\\ No newline at end of file',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toEqual(['b']);
    expect(hunks[0].newLines).toEqual(['B']);
  });

  // ── Empty input ────────────────────────────────────────────────────

  it('returns empty array for empty string', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseUnifiedDiff('   \n  \n')).toEqual([]);
  });

  // ── Context before/after without changes ───────────────────────────

  it('handles context-only diff with no changes', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' a', ' b', ' c'].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toEqual([]);
    expect(hunks[0].newLines).toEqual([]);
    expect(hunks[0].contextBefore).toEqual(['a', 'b', 'c']);
    expect(hunks[0].contextAfter).toEqual([]);
  });

  // ── Realistic multi-hunk with git-diff style headers ───────────────

  it('ignores leading file headers from git diff output', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,4 +1,4 @@',
      '-line1',
      '+LINE1',
      ' line2',
      ' line3',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldLines).toEqual(['line1']);
    expect(hunks[0].newLines).toEqual(['LINE1']);
  });

  // ── Interleaved context inside the change zone ────────────────────

  it('preserves interleaved context lines in the change zone', () => {
    const diff = [
      '@@ -1,6 +1,6 @@',
      ' keep1',
      '-old1',
      '+new1',
      ' keep2',
      '-old2',
      '+new2',
      ' keep3',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].contextBefore).toEqual(['keep1']);
    // oldLines = old version of change zone = `-` lines + interleaved ` ` lines.
    expect(hunks[0].oldLines).toEqual(['old1', 'keep2', 'old2']);
    // newLines = new version of change zone = `+` lines + interleaved ` ` lines.
    expect(hunks[0].newLines).toEqual(['new1', 'keep2', 'new2']);
    expect(hunks[0].contextAfter).toEqual(['keep3']);
    // changeZone preserves the typed structure for rendering.
    expect(hunks[0].changeZone).toEqual([
      { kind: '-', content: 'old1' },
      { kind: '+', content: 'new1' },
      { kind: ' ', content: 'keep2' },
      { kind: '-', content: 'old2' },
      { kind: '+', content: 'new2' },
    ]);
  });
});
