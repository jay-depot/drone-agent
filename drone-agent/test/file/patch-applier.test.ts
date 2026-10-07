import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  type ChangeZoneLine,
  type PatchHunk,
} from '../../src/shared/patch-applier.js';
import { makeHunk } from './setup.js';

describe('applyPatch — basic operations', () => {
  it('replaces lines with context-anchored match', () => {
    const lines = [
      'def greet():',
      '    """Say hello"""',
      '    print("hello")',
      '',
      'def farewell():',
      '    print("goodbye")',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def greet():'],
        contextBefore: ['def greet():'],
        oldLines: ['    """Say hello"""', '    print("hello")'],
        newLines: ['    """Say hello"""', '    print("hi there")'],
        contextAfter: ['', 'def farewell():'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.appliedHunks[0].fuzz).toBe(0);
  });

  it('pure insertion (empty oldLines) locates via contextBefore', () => {
    const lines = [
      'def add(a, b):',
      '    return a + b',
      '',
      'def subtract(a, b):',
      '    return a - b',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def add(a, b):'],
        contextBefore: ['def add(a, b):'],
        oldLines: [],
        newLines: ['    """Add two numbers"""'],
        contextAfter: ['    return a + b', ''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('pure deletion (empty newLines)', () => {
    const lines = [
      'def old_func():',
      '    # deprecated',
      '    pass',
      '',
      'def new_func():',
      '    pass',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def old_func():'],
        contextBefore: ['def old_func():'],
        oldLines: ['    # deprecated', '    pass'],
        newLines: [],
        contextAfter: ['', 'def new_func():'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('context disambiguates between duplicate oldLines blocks', () => {
    const lines = [
      'class MathUtils:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
      '    def multiply(self, a, b):',
      '        return a * b',
      '',
      'class StringUtils:',
      '    def add(self, a, b):',
      '        return a + b',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['    def add(self, a, b):'],
        oldLines: ['        return a + b'],
        newLines: ['        """Add two numbers"""', '        return a + b'],
        contextAfter: ['', '    def multiply(self, a, b):'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('no anchors, unique oldLines — step 1 match applies', () => {
    const lines = [
      'line1',
      'line2',
      'target_before',
      'target_old',
      'target_after',
      'line6',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['target_before'],
        oldLines: ['target_old'],
        newLines: ['target_new'],
        contextAfter: ['target_after'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });
});

describe('applyPatch — fuzzy matching (step 1.5 aggressive fuzz)', () => {
  it('fuzz level 1: trailing whitespace differences (step 1 finds it)', () => {
    const lines = ['def foo():  ', '    pass  ', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def foo():'],
        contextBefore: ['def foo():'],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
  });

  it('fuzz level 100: internal whitespace differences (step 1.5 aggressive)', () => {
    // File has `def  foo ( ) :` (extra spaces); oldLines has `def foo():`.
    // Step 1 exact match fails; step 1.5 aggressive collapse matches.
    const lines = ['def  foo ( ) :', '    pass', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def foo():'],
        oldLines: ['def foo():', '    pass'],
        newLines: ['def foo():', '    return 42'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
  });

  it('step 1.5 handles line-break reflow (1-line oldLines ↔ multi-line file)', () => {
    // File has a function call wrapped across 3 lines; oldLines is 1 line.
    // The collapse must match exactly (punctuation is preserved), so the
    // file's wrapped form must collapse to the same string as oldLines.
    const lines = ['foo(a,', '  b,', '  c)', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['foo(a, b, c)'],
        newLines: ['foo(a, b, c, d)'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
    // The 3-line file span should have been replaced with the new 1-line.
    expect(result.patchedLines).toEqual(['foo(a, b, c, d)', '']);
  });

  it('step 1.5 handles line-break join (multi-line oldLines ↔ 1-line file)', () => {
    // File has a single-line call; oldLines is wrapped across 3 lines.
    // oldLines must collapse to the same string as the file line.
    const lines = ['foo(a, b, c)', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['foo(a,', '  b,', '  c)'],
        newLines: ['foo(a, b, c, d)'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
    expect(result.patchedLines).toEqual(['foo(a, b, c, d)', '']);
  });
});

describe('applyPatch — error handling (Type 1/2/3 failures)', () => {
  it('Type 2: reports old code not found when oldLines absent from file', () => {
    const lines = ['def foo():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    nonexistent_old_line'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type2');
    expect(result.errors[0].message).toContain('not found');
  });

  it('Type 1: reports multiple matches when oldLines appears more than once', () => {
    const lines = ['    pass', '', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type1');
    expect(result.errors[0].matchSites).toBeDefined();
    expect(result.errors[0].matchSites!.length).toBe(2);
  });

  it('Type 1: cheat sheet includes reworked hunks', () => {
    const lines = ['    pass', '', '    pass', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    const sites = result.errors[0].matchSites!;
    for (const site of sites) {
      expect(site.reworkedHunk).toContain('@@');
      expect(site.reworkedHunk).toContain('-    pass');
      expect(site.reworkedHunk).toContain('+    return 42');
    }
  });

  it('Type 2: suggests closest file spans via Levenshtein', () => {
    // oldLines has a typo; the file has the correct spelling.
    const lines = ['def foo():', '    return 42', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    return 43'],
        newLines: ['    return 99'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors[0].failureType).toBe('type2');
    const suggestions = result.errors[0].suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    // Closest suggestion should be near `    return 42`.
    expect(suggestions[0].content).toContain('return 42');
  });
});

describe('applyPatch — multiple hunks (top-to-bottom)', () => {
  it('applies multiple hunks top-to-bottom', () => {
    const lines = [
      'def first():',
      '    pass',
      '',
      'def second():',
      '    pass',
      '',
      'def third():',
      '    pass',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def first():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def second():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: ['def third():'],
        oldLines: ['    pass'],
        newLines: ['    return 3'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(2);
  });

  it('later hunks see earlier hunks changes', () => {
    // First hunk changes `    pass` (first occurrence) to `    return 1`.
    // Second hunk targets the remaining `    pass` — now unique.
    const lines = ['def good():', '    pass', '', 'def bad():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def good():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def bad():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 2'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    // After first hunk applies, only one `    pass` remains, so second applies.
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(2);
  });

  it('reports partial success: one hunk applies, one fails', () => {
    const lines = ['def good():', '    pass', '', 'def bad():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def good():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def bad():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    nonexistent_old'],
        newLines: ['    return 2'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type2');
  });
});

describe('applyPatch — edge cases', () => {
  it('handles empty file with pure insertion (no context)', () => {
    const lines: string[] = [];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: [],
        newLines: ['first line'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    // Empty file with empty oldLines and no context → inserts at start.
    expect(result.success).toBe(true);
    expect(result.patchedLines).toEqual(['first line']);
  });

  it('handles single-line file — replacing the only line', () => {
    const lines = ['the only line'];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['the only line'],
        newLines: ['replacement line'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('handles file with trailing newline (empty last line)', () => {
    const lines = ['line1', 'line2', ''];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['line1'],
        oldLines: ['line2', ''],
        newLines: ['line2', 'line3', ''],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
  });
});

describe('applyPatch — lineHint tie-breaking', () => {
  it('lineHint breaks ties between otherwise-equivalent matches', () => {
    const lines = ['    pass', '', '    pass', '', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
        lineHint: 3, // closest to the second `    pass` (line 3)
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(1);
    // Second `    pass` is at line 3 (1-based).
    expect(result.appliedHunks[0].appliedAtLine).toBe(3);
  });
});

describe('applyPatch — interleaved context (regression)', () => {
  it('preserves interleaved context lines in the change zone', () => {
    const lines = ['keep1', 'old1', 'keep2', 'old2', 'keep3'];

    const changeZone: ChangeZoneLine[] = [
      { kind: '-', content: 'old1' },
      { kind: '+', content: 'new1' },
      { kind: ' ', content: 'keep2' },
      { kind: '-', content: 'old2' },
      { kind: '+', content: 'new2' },
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: [],
        contextBefore: ['keep1'],
        changeZone,
        oldLines: ['old1', 'keep2', 'old2'],
        newLines: ['new1', 'keep2', 'new2'],
        contextAfter: ['keep3'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.patchedLines).toEqual([
      'keep1',
      'new1',
      'keep2',
      'new2',
      'keep3',
    ]);
  });
});
