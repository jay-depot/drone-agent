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
});
