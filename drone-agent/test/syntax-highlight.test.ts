/**
 * Tests for syntax-highlight shared helpers.
 *
 * renderHighlightedTree embeds raw ANSI SGR sequences in its emitted line
 * strings, so the collision-prone behaviors (fg on background slots,
 * attribute handling, unparseable-color fallbacks) are asserted against
 * those literal escape sequences rather than visual output.
 */

import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import {
  DEFAULT_SYNTAX_THEME,
  SYNTAX_COLORS,
  normalizeLegacyColors,
  renderHighlightedTree,
  type HighlightNode,
} from '../src/tui/shared/syntax-highlight.js';

/** Minimal lowlight-AST-shaped token for building fake trees. */
function elementToken(classNames: string[], value: string): HighlightNode {
  return {
    type: 'element',
    properties: { className: classNames },
    children: [{ type: 'text', value }],
  };
}

/**
 * Pull the per-line strings out of renderHighlightedTree's returned
 * fragment. Each line is a <Text> whose children are [styledLine, padding].
 * A fragment with a single child stores that child directly rather than in
 * an array, so normalize both shapes.
 */
function renderedLines(result: ReactElement): string[] {
  const lines: string[] = [];
  const children = Array.isArray(result.props.children)
    ? result.props.children
    : [result.props.children];
  for (const child of children) {
    const textChild = child.props.children[0] as string;
    const paddingChild = child.props.children[1] as string;
    lines.push(textChild + paddingChild);
  }
  return lines;
}

describe('normalizeLegacyColors', () => {
  it('returns the default theme for undefined', () => {
    expect(normalizeLegacyColors(undefined)).toEqual(DEFAULT_SYNTAX_THEME);
  });

  it('returns the default theme for an empty map', () => {
    expect(normalizeLegacyColors({})).toEqual(DEFAULT_SYNTAX_THEME);
  });

  it('passes plain color values through as { color }', () => {
    const theme = normalizeLegacyColors({ keyword: 'red', title: '#00ff00' });
    expect(theme.keyword).toEqual({ color: 'red' });
    expect(theme.title).toEqual({ color: '#00ff00' });
  });

  it('converts attribute-valued entries to attribute styles', () => {
    const theme = normalizeLegacyColors({
      strong: 'bold',
      emphasis: 'italic',
      link: 'underline',
    });
    expect(theme.strong).toEqual({ bold: true });
    expect(theme.emphasis).toEqual({ italic: true });
    expect(theme.link).toEqual({ underline: true });
  });

  it('preserves unknown keys (map semantics)', () => {
    const theme = normalizeLegacyColors({ 'hljs-weird': 'chartreuse' });
    expect(theme['hljs-weird']).toEqual({ color: 'chartreuse' });
  });

  it('leaves already-object values untouched', () => {
    const style = { color: 'cyan', bold: true };
    const theme = normalizeLegacyColors({
      fn: style as unknown as string,
    });
    expect(theme.fn).toEqual(style);
  });
});

describe('DEFAULT_SYNTAX_THEME', () => {
  it('styles comments with italic and no foreground color', () => {
    expect(DEFAULT_SYNTAX_THEME.comment).toEqual({ italic: true });
  });

  it('maps legacy strong/emphasis entries to real attributes', () => {
    expect(DEFAULT_SYNTAX_THEME.strong).toEqual({ bold: true });
    expect(DEFAULT_SYNTAX_THEME.emphasis).toEqual({ italic: true });
  });

  it('contains no gray-on-gray pair: comment differs from legacy gray', () => {
    expect(SYNTAX_COLORS.comment).toBe('gray');
    expect(DEFAULT_SYNTAX_THEME.comment.color).toBeUndefined();
  });
});

describe('renderHighlightedTree SGR emission', () => {
  it('emits truecolor SGR for hex colors', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-comment'], '// hi')] },
        'gray',
        { comment: { color: '#ff8800' } }
      )
    );
    expect(lines).toEqual(['\u001b[38;2;255;136;0m// hi\u001b[39m']);
  });

  it('emits truecolor SGR for shorthand hex colors', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-keyword'], 'const')] },
        'gray',
        { keyword: { color: '#f80' } }
      )
    );
    expect(lines[0]).toContain('\u001b[38;2;255;136;0mconst\u001b[39m');
  });

  it('emits 256-color SGR for decimal indices', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-number'], '42')] },
        'gray',
        { number: { color: '203' } }
      )
    );
    expect(lines[0]).toBe('\u001b[38;5;203m42\u001b[39m');
  });

  it('rejects out-of-range 256-color indices by omitting the foreground', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-number'], '42')] },
        'gray',
        { number: { color: '999' } }
      )
    );
    expect(lines[0]).toBe('42');
  });

  it('emits named base colors via the ANSI map', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-string'], '"x"')] },
        'gray',
        { string: { color: 'green' } }
      )
    );
    expect(lines[0]).toBe('\u001b[32m"x"\u001b[39m');
  });

  it('emits bold and italic attributes with proper reset codes', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-strong'], 'loud')] },
        'gray',
        { strong: { bold: true, italic: true } }
      )
    );
    expect(lines[0]).toBe('\u001b[1;3mloud\u001b[23;22m');
  });

  it('emits no foreground SGR for unparseable colors (inherits ambient)', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-variable'], 'x')] },
        'gray',
        { variable: { color: 'not-a-color' } }
      )
    );
    expect(lines[0]).toBe('x');
  });

  it('renders attribute-only styles (default comments) with no fg at all', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-comment'], '// c')] },
        'gray',
        undefined
      )
    );
    expect(lines[0]).toBe('\u001b[3m// c\u001b[23m');
  });

  it('accepts the legacy string map directly', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [elementToken(['hljs-strong'], 'b')] },
        'gray',
        SYNTAX_COLORS
      )
    );
    expect(lines[0]).toBe('\u001b[1mb\u001b[22m');
  });

  it('resolves styles from the first matching hljs class', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        {
          children: [elementToken(['hljs-string', 'hljs-keyword'], 'both')],
        },
        'gray',
        { string: { color: 'green' }, keyword: { color: 'red' } }
      )
    );
    expect(lines[0]).toContain('\u001b[32mboth\u001b[39m');
  });

  it('leaves unclassed tokens unstyled', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        { children: [{ type: 'text', value: 'plain' }] },
        'gray',
        undefined
      )
    );
    expect(lines[0]).toBe('plain');
  });
});

describe('renderHighlightedTree padding', () => {
  it('pads short lines to the longest visible width with bare spaces', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        {
          children: [
            elementToken(['hljs-keyword'], 'const'),
            { type: 'text', value: '\n' },
            elementToken([], 'ab'),
          ],
        },
        'gray',
        { keyword: { color: 'magenta' } }
      )
    );
    // "const" is 5 visible columns; "ab" gets 3 trailing spaces, none of
    // which sit inside an SGR run.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('\u001b[35mconst\u001b[39m');
    expect(lines[1]).toBe('ab   ');
  });

  it('never places padding inside a foreground SGR run', () => {
    const lines = renderedLines(
      renderHighlightedTree(
        {
          children: [
            elementToken(['hljs-comment'], '// x'),
            { type: 'text', value: '\n' },
            elementToken([], 'y'),
          ],
        },
        'gray',
        undefined
      )
    );
    expect(lines[1]).toMatch(/y {3}$/);
    expect(lines[1].endsWith('\u001b[39m')).toBe(false);
  });
});
