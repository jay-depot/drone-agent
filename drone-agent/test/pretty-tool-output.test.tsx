/**
 * Tests for the custom tool render components.
 *
 * Each component is rendered with a mock ToolRenderState using
 * ink-testing-library, and the output is checked for expected text.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ExecRunBlock } from '../src/tui/components/ExecRunBlock.js';
import { FileReadBlock } from '../src/tui/components/FileReadBlock.js';
import { FileWriteBlock } from '../src/tui/components/FileWriteBlock.js';
import { FileApplyDiffBlock } from '../src/tui/components/FileApplyDiffBlock.js';
import { FileListBlock } from '../src/tui/components/FileListBlock.js';
import { FileGlobBlock } from '../src/tui/components/FileGlobBlock.js';
import { SearchTextBlock } from '../src/tui/components/SearchTextBlock.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ToolRenderState } from 'drone-core';

const scheme = DEFAULT_GRAYSCALE_SCHEME;

function makeState(overrides: Partial<ToolRenderState> = {}): ToolRenderState {
  return {
    name: 'test__tool',
    arguments: {},
    status: 'done',
    scheme: scheme as unknown,
    ...overrides,
  };
}

// ── ExecRunBlock ─────────────────────────────────────────────────────

describe('ExecRunBlock', () => {
  it('shows running state with command', () => {
    const state = makeState({
      name: 'exec__run',
      arguments: { command: 'ls -la' },
      status: 'running',
    });
    const { lastFrame } = render(<ExecRunBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('exec__run $ ls -la');
  });

  it('shows done state with output lines', () => {
    const state = makeState({
      name: 'exec__run',
      arguments: { command: 'echo hello' },
      status: 'done',
      result: JSON.stringify({
        command: 'echo hello',
        cwd: '/tmp',
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
      }),
      outputLines: ['hello\n'],
    });
    const { lastFrame } = render(<ExecRunBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('exec__run $ echo hello');
    expect(lastFrame()).toContain('hello');
  });

  it('shows non-zero exit code', () => {
    const state = makeState({
      name: 'exec__run',
      arguments: { command: 'false' },
      status: 'done',
      result: JSON.stringify({
        command: 'false',
        cwd: '/tmp',
        exitCode: 1,
        stdout: '',
        stderr: '',
      }),
    });
    const { lastFrame } = render(<ExecRunBlock state={state} />);
    expect(lastFrame()).toContain('exit 1');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'exec__run',
      arguments: { command: 'bad-command' },
      status: 'error',
      result: 'exec__run failed: command not found',
    });
    const { lastFrame } = render(<ExecRunBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

describe('FileReadBlock width mode', () => {
  const stripAnsi = (s: string): string =>
    s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

  /** ANSI-stripped, non-empty rows of the rendered frame. */
  function frameRows(inst: { lastFrame: () => string | undefined }): string[] {
    return (inst.lastFrame() ?? '')
      .split('\n')
      .map(stripAnsi)
      .filter(row => row.length > 0);
  }

  it('wraps a line longer than columns into ceil(L/W) fully-filled rows', () => {
    // ink-testing-library renders at a fixed 100-column terminal; matching
    // state.columns to it means the padded line (ceil(150/100)*100 = 200)
    // hard-wraps into two rows of exactly 100 — the second carrying the
    // text remainder plus its background fill (no bare band).
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      columns: 100,
      result: JSON.stringify({
        path: '/tmp/test.ts',
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        content: 'x'.repeat(150),
      }),
    });
    const inst = render(<FileReadBlock state={state} />);
    const rows = frameRows(inst);
    expect(rows).toContain('x'.repeat(100));
    expect(rows).toContain('x'.repeat(50) + ' '.repeat(50));
  });

  it('fills short lines to the terminal width and blank lines as a full-width band', () => {
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      columns: 100,
      result: JSON.stringify({
        path: '/tmp/test.ts',
        totalLines: 3,
        startLine: 1,
        endLine: 3,
        content: 'ab\n\ncd',
      }),
    });
    const inst = render(<FileReadBlock state={state} />);
    const rows = frameRows(inst);
    expect(rows).toContain('ab' + ' '.repeat(98));
    expect(rows).toContain('cd' + ' '.repeat(98));
    // The blank line stays visible as exactly one full-width background
    // band (ink drops zero-width text, so a 0-padded blank would vanish).
    expect(rows).toContain(' '.repeat(100));
  });
});

// ── FileReadBlock ─────────────────────────────────────────────────────

describe('FileReadBlock', () => {
  it('shows running state with path', () => {
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/test.ts' },
      status: 'running',
    });
    const { lastFrame } = render(<FileReadBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('file__read /tmp/test.ts');
  });

  it('shows done state with header and preview', () => {
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      result: JSON.stringify({
        path: '/tmp/test.ts',
        totalLines: 10,
        startLine: 1,
        endLine: 10,
        content: 'line1\nline2\nline3\nline4\nline5\nline6',
      }),
    });
    const { lastFrame } = render(<FileReadBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('file__read /tmp/test.ts');
    expect(lastFrame()).toContain('1–10 of 10 lines');
    expect(lastFrame()).toContain('===');
  });

  it('shows at most 10 preview lines', () => {
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      result: JSON.stringify({
        path: '/tmp/test.ts',
        totalLines: 20,
        startLine: 1,
        endLine: 20,
        content: Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
          '\n'
        ),
      }),
    });
    const { lastFrame } = render(<FileReadBlock state={state} />);
    expect(lastFrame()).toContain('line1');
    expect(lastFrame()).toContain('line10');
    // line11 should not appear in the preview
    expect(lastFrame()).not.toContain('line11');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'file__read',
      arguments: { path: '/tmp/nonexistent.ts' },
      status: 'error',
      result: 'file__read: path not found',
    });
    const { lastFrame } = render(<FileReadBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── FileWriteBlock ───────────────────────────────────────────────────

describe('FileWriteBlock', () => {
  it('shows running state with path', () => {
    const state = makeState({
      name: 'file__write',
      arguments: { path: '/tmp/test.ts' },
      status: 'running',
    });
    const { lastFrame } = render(<FileWriteBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('file__write /tmp/test.ts');
  });

  it('shows done state with Wrote prefix', () => {
    const state = makeState({
      name: 'file__write',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      result: JSON.stringify({ path: '/tmp/test.ts', written: true }),
    });
    const { lastFrame } = render(<FileWriteBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('Wrote /tmp/test.ts');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'file__write',
      arguments: { path: '/tmp/readonly' },
      status: 'error',
      result: 'file__write: permission denied',
    });
    const { lastFrame } = render(<FileWriteBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── FileApplyDiffBlock ───────────────────────────────────────────────

describe('FileApplyDiffBlock', () => {
  it('shows running state with path', () => {
    const state = makeState({
      name: 'file__apply_diff',
      arguments: { path: '/tmp/test.ts' },
      status: 'running',
    });
    const { lastFrame } = render(<FileApplyDiffBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('file__apply_diff /tmp/test.ts');
  });

  it('shows done state with summary', () => {
    const state = makeState({
      name: 'file__apply_diff',
      arguments: { path: '/tmp/test.ts' },
      status: 'done',
      result: JSON.stringify({
        path: '/tmp/test.ts',
        patched: true,
        summary: { hunks: 2, additions: 5, deletions: 3 },
        diff: '--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,5 @@',
      }),
    });
    const { lastFrame } = render(<FileApplyDiffBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('file__apply_diff /tmp/test.ts');
    expect(lastFrame()).toContain('+5');
    expect(lastFrame()).toContain('-3');
    expect(lastFrame()).toContain('2 hunks');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'file__apply_diff',
      arguments: { path: '/tmp/test.ts' },
      status: 'error',
      result: 'file__apply_diff: hunk 1 failed to apply',
    });
    const { lastFrame } = render(<FileApplyDiffBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── FileListBlock ────────────────────────────────────────────────────

describe('FileListBlock', () => {
  it('shows running state with path', () => {
    const state = makeState({
      name: 'file__list',
      arguments: { path: '/tmp' },
      status: 'running',
    });
    const { lastFrame } = render(<FileListBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('file__list /tmp');
  });

  it('shows done state with directory listing', () => {
    const state = makeState({
      name: 'file__list',
      arguments: { path: '/tmp' },
      status: 'done',
      result: JSON.stringify({
        path: '/tmp',
        items: [
          { name: 'subdir', type: 'directory', size: null },
          { name: 'file.txt', type: 'file', size: 100 },
        ],
      }),
    });
    const { lastFrame } = render(<FileListBlock state={state} />);
    expect(lastFrame()).toContain('file__list /tmp');
    expect(lastFrame()).toContain('📁');
    expect(lastFrame()).toContain('subdir/');
    expect(lastFrame()).toContain('📄');
    expect(lastFrame()).toContain('file.txt');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'file__list',
      arguments: { path: '/tmp/nonexistent' },
      status: 'error',
      result: 'file__list: path not found',
    });
    const { lastFrame } = render(<FileListBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── FileGlobBlock ────────────────────────────────────────────────────

describe('FileGlobBlock', () => {
  it('shows running state with pattern', () => {
    const state = makeState({
      name: 'file__glob',
      arguments: { pattern: '**/*.ts' },
      status: 'running',
    });
    const { lastFrame } = render(<FileGlobBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('file__glob **/*.ts');
  });

  it('shows done state with matches and count', () => {
    const state = makeState({
      name: 'file__glob',
      arguments: { pattern: '**/*.ts' },
      status: 'done',
      result: JSON.stringify({
        pattern: '**/*.ts',
        cwd: '/tmp',
        matches: ['/tmp/a.ts', '/tmp/b.ts'],
      }),
    });
    const { lastFrame } = render(<FileGlobBlock state={state} />);
    expect(lastFrame()).toContain('file__glob **/*.ts');
    expect(lastFrame()).toContain('/tmp/a.ts');
    expect(lastFrame()).toContain('/tmp/b.ts');
    expect(lastFrame()).toContain('(2 matches)');
  });

  it('shows singular count for one match', () => {
    const state = makeState({
      name: 'file__glob',
      arguments: { pattern: '*.md' },
      status: 'done',
      result: JSON.stringify({
        pattern: '*.md',
        cwd: '/tmp',
        matches: ['/tmp/readme.md'],
      }),
    });
    const { lastFrame } = render(<FileGlobBlock state={state} />);
    expect(lastFrame()).toContain('(1 match)');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'file__glob',
      arguments: { pattern: '**/*.ts' },
      status: 'error',
      result: 'file__glob: cwd is not a directory',
    });
    const { lastFrame } = render(<FileGlobBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── SearchTextBlock ──────────────────────────────────────────────────

describe('SearchTextBlock', () => {
  it('shows running state with pattern and path', () => {
    const state = makeState({
      name: 'search__text',
      arguments: { pattern: 'TODO', path: '/tmp' },
      status: 'running',
    });
    const { lastFrame } = render(<SearchTextBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('TODO in /tmp');
  });

  it('shows done state with results', () => {
    const state = makeState({
      name: 'search__text',
      arguments: { pattern: 'TODO', path: '/tmp' },
      status: 'done',
      result: JSON.stringify({
        pattern: 'TODO',
        searchPath: '/tmp',
        resultCount: 2,
        truncated: false,
        results: [
          { file: '/tmp/a.ts', line: 10, content: '// TODO: fix me' },
          { file: '/tmp/b.ts', line: 20, content: '// TODO: refactor' },
        ],
      }),
    });
    const { lastFrame } = render(<SearchTextBlock state={state} />);
    expect(lastFrame()).toContain('TODO in /tmp');
    expect(lastFrame()).toContain('/tmp/a.ts:10');
    expect(lastFrame()).toContain('// TODO: fix me');
    expect(lastFrame()).toContain('/tmp/b.ts:20');
    expect(lastFrame()).toContain('// TODO: refactor');
    expect(lastFrame()).toContain('(2 matches)');
  });

  it('shows truncated indicator when truncated', () => {
    const state = makeState({
      name: 'search__text',
      arguments: { pattern: 'TODO', path: '/tmp' },
      status: 'done',
      result: JSON.stringify({
        pattern: 'TODO',
        searchPath: '/tmp',
        resultCount: 50,
        truncated: true,
        results: [{ file: '/tmp/a.ts', line: 10, content: '// TODO: fix me' }],
      }),
    });
    const { lastFrame } = render(<SearchTextBlock state={state} />);
    expect(lastFrame()).toContain('[truncated]');
  });

  it('does not show truncated indicator when not truncated', () => {
    const state = makeState({
      name: 'search__text',
      arguments: { pattern: 'TODO', path: '/tmp' },
      status: 'done',
      result: JSON.stringify({
        pattern: 'TODO',
        searchPath: '/tmp',
        resultCount: 1,
        truncated: false,
        results: [{ file: '/tmp/a.ts', line: 10, content: '// TODO: fix me' }],
      }),
    });
    const { lastFrame } = render(<SearchTextBlock state={state} />);
    expect(lastFrame()).not.toContain('[truncated]');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'search__text',
      arguments: { pattern: 'TODO', path: '/tmp' },
      status: 'error',
      result: 'search__text: command failed',
    });
    const { lastFrame } = render(<SearchTextBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});
