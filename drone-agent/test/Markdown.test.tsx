/**
 * Tests for Markdown component — syntax highlighting, inline codespan, etc.
 *
 * The renderHighlightedTree function was recently changed to use raw ANSI
 * escape codes (avoiding Yoga layout bugs from nested <Text> elements).
 * These tests verify:
 * - No stray "undefined" strings in syntax-highlighted output
 * - Code blocks render their text content correctly
 * - Plaintext code blocks render without issues
 * - Inline codespan still works
 *
 * Note: ANSI color codes emitted by renderHighlightedTree are consumed by
 * Ink's rendering pipeline and do not appear as raw escape sequences in the
 * test output. Color correctness is verified by visual inspection in a real
 * terminal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Markdown } from '../src/tui/components/Markdown.js';

type RenderInst = ReturnType<typeof render>;

/**
 * Poll until `lastFrame()` satisfies `predicate` or `timeoutMs` elapses.
 *
 * Ink renders asynchronously; a fixed `setTimeout(0)` is NOT a reliable
 * barrier and flakes on slower CI runners (lastFrame() returns the empty
 * pre-render frame). We instead wait for the specific content to actually
 * appear in the output.
 */
async function waitUntilFrame(
  inst: RenderInst,
  predicate: (frame: string) => boolean,
  timeoutMs = 1000
): Promise<string> {
  const start = Date.now();
  let frame = inst.lastFrame() ?? '';
  while (!predicate(frame) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
    frame = inst.lastFrame() ?? '';
  }
  return frame;
}

describe('Markdown', () => {
  let instance: RenderInst | null = null;
  afterEach(() => {
    instance?.cleanup();
    instance = null;
  });

  describe('bare code fences (plain text by design)', () => {
    it('renders a bare fence as unstyled white text with no background or lang label', async () => {
      // Bare ``` fences carry an empty lang from marked. This is the
      // intentional plain-text path: no highlighting, no code background,
      // no language label. Contrast with the ```ts width-mode tests, whose
      // frames carry \u001b[100m...\u001b[49m background runs.
      const md = ['```', 'plain content line', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f =>
        f.includes('plain content line')
      );

      expect(frame).toContain('\u001b[37mplain content line\u001b[39m');
      expect(frame).not.toMatch(
        new RegExp(
          String.fromCharCode(27) +
            '\\[100m +' +
            String.fromCharCode(27) +
            '\\[49m'
        )
      );
      expect(frame).not.toContain('\u001b[100m');
    });
  });

  describe('code blocks with syntax highlighting', () => {
    it('renders a TSX code block without stray "undefined" strings', async () => {
      const md = ['```tsx', 'const x: number = 42;', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('const'));

      // The actual source text should be present
      expect(frame).toContain('const');
      expect(frame).toContain('x');
      expect(frame).toContain('number');
      expect(frame).toContain('42');

      // The literal string "undefined" must NOT appear
      expect(frame).not.toContain('undefined');
    });

    it('renders a JS code block without stray "undefined" strings', async () => {
      const md = [
        '```js',
        'function greet(name) {',
        '  return `Hello, ${name}!`;',
        '}',
        '```',
      ].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('function'));

      expect(frame).toContain('function');
      expect(frame).toContain('greet');
      expect(frame).toContain('Hello');
      expect(frame).not.toContain('undefined');
    });

    it('renders a Python code block without stray "undefined" strings', async () => {
      const md = [
        '```python',
        'def hello():',
        '    print("world")',
        '```',
      ].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('def'));

      expect(frame).toContain('def');
      expect(frame).toContain('hello');
      expect(frame).toContain('world');
      expect(frame).not.toContain('undefined');
    });

    it('renders a code block with mixed element and text tokens correctly', async () => {
      // This snippet produces both element nodes (with className) and text
      // nodes (plain value) in the lowlight AST, exercising both helpers.
      const md = ['```tsx', 'const x: number = 42;', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('const'));

      // Verify the full line is rendered contiguously (no gaps from
      // element nodes that were previously rendered as "undefined")
      expect(frame).toContain('const');
      expect(frame).toContain('x');
      expect(frame).toContain('number');
      expect(frame).toContain('42');
    });
  });

  describe('plaintext code blocks', () => {
    it('renders a plaintext code block without "undefined" strings', async () => {
      const md = ['```', 'just some plain text', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f =>
        f.includes('just some plain text')
      );

      expect(frame).toContain('just some plain text');
      expect(frame).not.toContain('undefined');
    });
  });

  describe('background padding', () => {
    it('pads shorter lines to match the longest line width', async () => {
      // Lines of different lengths — the shorter line should be padded
      // with trailing spaces so the background fills the full width.
      const md = ['```tsx', 'const x: number = 42;', 'short', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('short'));

      // Both lines should be present
      expect(frame).toContain('const');
      expect(frame).toContain('x');
      expect(frame).toContain('number');
      expect(frame).toContain('42');
      expect(frame).toContain('short');

      // No stray "undefined" strings
      expect(frame).not.toContain('undefined');
    });

    it('renders a single-line code block without issues', async () => {
      const md = ['```tsx', 'const x = 1;', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('const'));

      expect(frame).toContain('const');
      expect(frame).toContain('x');
      expect(frame).toContain('1');
      expect(frame).not.toContain('undefined');
    });
  });

  describe('custom syntax colors', () => {
    it('accepts a custom syntaxColors prop without errors', async () => {
      const md = ['```tsx', 'const x: number = 42;', '```'].join('\n');
      const customColors = { keyword: 'red', number: 'blue' };

      const inst = render(
        <Markdown syntaxColors={customColors}>{md}</Markdown>
      );
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('const'));

      expect(frame).toContain('const');
      expect(frame).toContain('x');
      expect(frame).toContain('number');
      expect(frame).toContain('42');
      expect(frame).not.toContain('undefined');
    });
  });

  describe('inline codespan', () => {
    it('renders inline code with backticks', async () => {
      const md = 'Use the `npm install` command.';

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('npm install'));

      expect(frame).toContain('npm install');
      expect(frame).not.toContain('undefined');
    });
  });

  describe('foreground/background collision regressions', () => {
    it('codespan inside bold emits no foreground color after its background', async () => {
      // The old implementation hardcoded color="black" on the codespan.
      // Under bold (SGR 1 active from the parent), terminals with
      // bold-promotion render black as bright black — the same palette
      // slot as the gray background — making the text invisible.
      const md = 'A **bold claim** about `identifierName` here.';

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f =>
        f.includes('identifierName')
      );

      expect(frame).toContain('\u001b[100m');
      expect(frame).not.toContain('\u001b[30m');
      expect(frame).toContain('identifierName');
    });

    it('default comment styling never emits gray-on-gray', async () => {
      const md = ['```ts', '// a comment', 'const x = 1;', '```'].join('\n');

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('comment'));

      expect(frame).toContain('// a comment');
      // Comments are italic-only by default: no bright-black foreground
      // touching the comment text that would sit on the bright-black
      // background (the block border legitimately uses \e[90m).
      expect(frame).not.toContain('90m// a comment');
      expect(frame).toContain('\u001b[3m// a comment\u001b[23m');
    });

    it('honors a custom codeBackground for inline codespans', async () => {
      const md = 'Run `make all` to build.';

      const inst = render(<Markdown codeBackground="red">{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('make all'));

      expect(frame).toContain('\u001b[41mmake all\u001b[49m');
    });

    it('emits truecolor SGR for hex syntax colors', async () => {
      const md = ['```ts', '// hex colored', '```'].join('\n');
      const syntaxColors = {
        comment: { color: '#ff8800' },
      } as unknown as Record<string, string>;

      const inst = render(
        <Markdown syntaxColors={syntaxColors}>{md}</Markdown>
      );
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('hex colored'));

      expect(frame).toContain('\u001b[38;2;255;136;0m// hex colored\u001b[39m');
    });

    it('emits 256-color SGR for decimal indices', async () => {
      const md = ['```ts', '// indexed', '```'].join('\n');
      const syntaxColors = {
        comment: { color: '203' },
      } as unknown as Record<string, string>;

      const inst = render(
        <Markdown syntaxColors={syntaxColors}>{md}</Markdown>
      );
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('indexed'));

      expect(frame).toContain('\u001b[38;5;203m// indexed\u001b[39m');
    });

    it('maps legacy strong/emphasis entries to real attribute SGR', async () => {
      // Markdown fences reliably produce hljs-strong tokens; TS comments
      // do not (they lex as hljs-comment regardless of emphasis markers).
      const md = ['```md', '**loud**', '```'].join('\n');
      const syntaxColors = { strong: 'bold', emphasis: 'italic' };

      const inst = render(
        <Markdown syntaxColors={syntaxColors}>{md}</Markdown>
      );
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('loud'));

      expect(frame).toContain('\u001b[1m**loud**\u001b[22m');
    });

    it('renders blockquotes containing inline markup without [object Object]', async () => {
      const md = '> A **bold** thought with `code`.';

      const inst = render(<Markdown>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('thought'));

      expect(frame).toContain('bold');
      expect(frame).toContain('code');
      expect(frame).not.toContain('[object Object]');
    });
  });

  describe('code block width mode', () => {
    // SGR pair bounding the 'gray' code background:
    // \u001b[100m ... \u001b[49m. Built via fromCharCode
    // (same no-control-regex workaround the renderer uses).
    const bgPair = new RegExp(
      String.fromCharCode(27) + '\\[100m +' + String.fromCharCode(27) + '\\[49m'
    );
    it('pads content to ceil(L / (columns - 4)) * (columns - 4) using inner width, not terminal width', async () => {
      const md = ['```ts', 'x'.repeat(40), '```'].join('\n');

      const inst = render(<Markdown columns={30}>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('x'.repeat(40)));

      // Inner width = 30 - 4 (border 2 + paddingX 2) = 26.
      // ceil(40 / 26) * 26 = 52, so 12 trailing spaces sit inside the
      // background run. Legacy maxWidth (40) would emit no padding; a
      // terminal-width computation (96) would emit 56 spaces. The exact
      // run, bounded by the background SGR pair, discriminates all three
      // (box-fill spaces cannot satisfy it).
      const bg = '\u001b[100m';
      expect(frame).toContain(
        bg + 'x'.repeat(40) + ' '.repeat(12) + '\u001b[49m'
      );
      expect(frame).not.toContain(bg + 'x'.repeat(40) + ' '.repeat(13));
    });

    it('pads short lines and blank lines to one full inner-width row each', async () => {
      const md = ['```ts', 'ab', '', '```'].join('\n');

      const inst = render(<Markdown columns={30}>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('ab'));

      // Both lines fill exactly one inner-width row (26 columns): the
      // short line text+fill, the blank line as a full-width background
      // band (ink drops zero-width text, so a 0-padded blank would vanish).
      expect(frame).toContain('\u001b[100mab' + ' '.repeat(24) + '\u001b[49m');
      expect(frame).toMatch(bgPair);
    });

    it('wraps a very long line with the fill landing inside the last wrapped row', async () => {
      // Inner width 26: a 100-char line pads to ceil(100/26)*26 = 104,
      // exceeding the 96 columns available inside the 100-column test
      // terminal, so ink hard-wraps it. The remainder row must be
      // text-bearing; the blank line paints exactly one inner-width band.
      const md = ['```ts', 'x'.repeat(100), '', '```'].join('\n');

      const inst = render(<Markdown columns={30}>{md}</Markdown>);
      instance = inst;
      const frame = await waitUntilFrame(inst, f => f.includes('x'.repeat(90)));

      // First wrapped row is fully filled at the 96-column content width,
      // inside its own background pair.
      expect(frame).toContain('\u001b[100m' + 'x'.repeat(96) + '\u001b[49m');
      // Exactly one space-only background band (the blank line's row).
      expect(frame.match(new RegExp(bgPair.source, 'g'))).toHaveLength(1);
    });
  });
});
