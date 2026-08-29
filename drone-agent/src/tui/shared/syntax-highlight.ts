/**
 * Shared syntax highlighting helpers for TUI components.
 *
 * Extracts the lowlight-based highlighting logic used by Markdown.tsx
 * so that other components (e.g. FileReadBlock) can reuse it without
 * duplicating the lowlight instance, color maps, or rendering functions.
 *
 * Token styling is modeled as {@link SyntaxStyle} — an optional color plus
 * independent bold/italic/underline attributes — rather than encoding
 * attributes inside color strings. This lets attribute-only styles (e.g.
 * italic comments) avoid foreground colors entirely, so they can never
 * collide with the code background, and lets user configs express real
 * colors (hex, 256-color) instead of being silently coerced to white.
 */

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { createLowlight, common } from 'lowlight';
import React from 'react';

export const lowlight = createLowlight(common);

// Minimal structural types for the lowlight highlight tree (a hast AST).
// Defined locally rather than importing `hast` (a transitive dep) so the
// module stays self-contained.
export type HighlightNode =
  | {
      type: 'element';
      properties?: { className?: Array<string | number> };
      children: HighlightNode[];
    }
  | { type: 'text'; value: string }
  // Catch-all for other hast node kinds (comment, doctype, ...) so a real
  // lowlight tree (which can contain them) is assignable.
  | { type: string; value?: string; children?: HighlightNode[] };
export type HighlightRoot = { type: 'root'; children: HighlightNode[] };

/** Foreground/attribute styling applied to one highlight.js token class. */
export type SyntaxStyle = {
  /**
   * Any Ink/chalk-compatible color: a named base color ('magenta'), a hex
   * string ('#ff8800'), or a 256-color index ('203').
   */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

/**
 * Highlight class name → style. Keys match highlight.js class names with
 * the `hljs-` prefix stripped (e.g. `keyword`, `selector-class`).
 */
export type SyntaxTheme = Record<string, SyntaxStyle>;

/**
 * Default theme. Comment styling is deliberately italic-only: a gray
 * foreground on the gray code background shares a palette slot in common
 * terminals and renders invisible. Attribute-only styles carry no
 * foreground, so collisions with the background are impossible.
 */
export const DEFAULT_SYNTAX_THEME: SyntaxTheme = {
  keyword: { color: 'magenta' },
  function: { color: 'cyan' },
  'function-variable': { color: 'cyan' },
  string: { color: 'green' },
  number: { color: 'yellow' },
  comment: { italic: true },
  variable: { color: 'blue' },
  attr: { color: 'yellow' },
  tag: { color: 'magenta' },
  built_in: { color: 'cyan' },
  literal: { color: 'yellow' },
  selector: { color: 'yellow' },
  'selector-class': { color: 'yellow' },
  'selector-id': { color: 'yellow' },
  property: { color: 'blue' },
  title: { color: 'cyan' },
  params: { color: 'white' },
  sub: { color: 'gray' },
  sup: { color: 'gray' },
  emphasis: { italic: true },
  strong: { bold: true },
};

/**
 * Previous string-valued palette. Kept exported until FileReadBlock
 * migrates to SyntaxTheme natively; values feed normalizeLegacyColors.
 */
export const SYNTAX_COLORS: Record<string, string> = {
  keyword: 'magenta',
  function: 'cyan',
  'function-variable': 'cyan',
  string: 'green',
  number: 'yellow',
  comment: 'gray',
  emphasis: 'italic',
  strong: 'bold',
  variable: 'blue',
  attr: 'yellow',
  tag: 'magenta',
  built_in: 'cyan',
  literal: 'yellow',
  selector: 'yellow',
  'selector-class': 'yellow',
  'selector-id': 'yellow',
  property: 'blue',
  title: 'cyan',
  params: 'white',
  sub: 'gray',
  sup: 'gray',
};

const ANSI_COLORS: Record<string, string> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
};

type SyntaxAttribute = 'bold' | 'italic' | 'underline';

const ATTRIBUTE_SGR: Record<SyntaxAttribute, { open: string; close: string }> =
  {
    bold: { open: '1', close: '22' },
    italic: { open: '3', close: '23' },
    underline: { open: '4', close: '24' },
  };

const ATTRIBUTE_OPEN_ORDER: SyntaxAttribute[] = ['bold', 'italic', 'underline'];

const ATTRIBUTE_CLOSE_ORDER: SyntaxAttribute[] = [
  'underline',
  'italic',
  'bold',
];

/**
 * Translate a color string to a foreground SGR parameter list, or null when
 * unparseable. Supports hex (#rgb/#rrggbb → 38;2;r;g;b), decimal 256-color
 * indices (0–255 → 38;5;n), and named base colors via ANSI_COLORS.
 */
function foregroundSgr(color: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const expanded =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map(c => c + c)
            .join('')
        : hex[1];
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return `38;2;${r};${g};${b}`;
  }
  if (/^\d{1,3}$/.test(color)) {
    const index = Number(color);
    return index <= 255 ? `38;5;${index}` : null;
  }
  return ANSI_COLORS[color] ?? null;
}

/**
 * Opening SGR sequence for a style: attributes in fixed order, then
 * foreground. Returns '' when the style carries nothing emit-able
 * (including an unparseable color — such text inherits the ambient
 * foreground instead of being forced to a fixed fallback).
 */
function sgrOpen(style: SyntaxStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  for (const attribute of ATTRIBUTE_OPEN_ORDER) {
    if (style[attribute]) parts.push(ATTRIBUTE_SGR[attribute].open);
  }
  if (style.color) {
    const fg = foregroundSgr(style.color);
    if (fg) parts.push(fg);
  }
  return parts.length > 0 ? `\u001b[${parts.join(';')}m` : '';
}

/**
 * Closing SGR sequence mirroring {@link sgrOpen}: foreground reset first,
 * then attribute resets in reverse-open order.
 */
function sgrClose(style: SyntaxStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.color && foregroundSgr(style.color)) parts.push('39');
  for (const attribute of ATTRIBUTE_CLOSE_ORDER) {
    if (style[attribute]) parts.push(ATTRIBUTE_SGR[attribute].close);
  }
  return parts.length > 0 ? `\u001b[${parts.join(';')}m` : '';
}

/**
 * Coerce either color format into a SyntaxTheme. Accepts the legacy
 * `Record<string, string>` shape (values 'bold'/'italic'/'underline'
 * become attributes, anything else becomes `{ color }`) and passes
 * already-object values through as-is. Undefined/empty yields the
 * default theme.
 */
function toTheme(colors: Record<string, unknown> | undefined): SyntaxTheme {
  if (!colors || Object.keys(colors).length === 0) return DEFAULT_SYNTAX_THEME;
  const theme: SyntaxTheme = {};
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'object' && value !== null) {
      theme[key] = value as SyntaxStyle;
    } else if (value === 'bold') {
      theme[key] = { bold: true };
    } else if (value === 'italic') {
      theme[key] = { italic: true };
    } else if (value === 'underline') {
      theme[key] = { underline: true };
    } else if (typeof value === 'string') {
      theme[key] = { color: value };
    }
  }
  return theme;
}

/**
 * Normalize a legacy string-valued color map ({@link SYNTAX_COLORS} shape,
 * also the `tui.syntaxHighlighting.colors` config shape) into a
 * {@link SyntaxTheme}. Values equal to 'bold'/'italic'/'underline' become
 * the corresponding attribute; every other value becomes `{ color: value }`.
 * Undefined/empty input yields {@link DEFAULT_SYNTAX_THEME}.
 */
export function normalizeLegacyColors(
  colors?: Record<string, string>
): SyntaxTheme {
  return toTheme(colors);
}

export function extractTokenText(token: HighlightNode): string {
  if ('value' in token && token.value) return token.value;
  if ('children' in token && token.children) {
    return token.children.map(extractTokenText).join('');
  }
  return '';
}

function resolveTokenStyle(
  token: Extract<HighlightNode, { type: 'element' }>,
  theme: SyntaxTheme
): SyntaxStyle {
  const className = token.properties?.className;
  if (className) {
    for (const cls of className) {
      if (typeof cls === 'string' && cls.startsWith('hljs-')) {
        const style = theme[cls.slice(5)];
        if (style) return style;
      }
    }
  }
  return {};
}

/**
 * Render a lowlight highlight tree as Ink <Text> lines carrying raw ANSI
 * SGR sequences. Accepts either color format (legacy string map or
 * {@link SyntaxTheme}); the third parameter is normalized once up front.
 *
 * Each line is padded with trailing spaces so the background fills the
 * rows the line will occupy when soft-wrapped. Without `width`, lines pad
 * to the longest line's visible width (legacy mode). With `width` (the
 * container's available content width in terminal columns — callers
 * subtract their own chrome, e.g. a bordered code box passes
 * `columns - 4`), each line pads to `ceil(visibleLength / width) *
 * width`: a line then soft-wraps into exactly `ceil(L/width)` rows, every
 * one fully background-filled (no bare spill row), and blank lines pad to
 * zero so they render as true empty rows. The padding deliberately
 * carries no foreground SGR — a foreground on padding spaces is pointless
 * and is exactly how fg/bg collisions previously crept in.
 */
export function renderHighlightedTree(
  tree: HighlightRoot,
  backgroundColor: string,
  colors?: Record<string, string> | SyntaxTheme
  ,
  width?: number
): ReactElement {
  const theme = toTheme(colors as Record<string, unknown> | undefined);

  let fullRendered = '';
  for (const token of tree.children ?? []) {
    const style =
      token.type === 'element' && 'properties' in token
        ? resolveTokenStyle(token, theme)
        : {};
    const text = extractTokenText(token);
    if (text) fullRendered += `${sgrOpen(style)}${text}${sgrClose(style)}`;
  }

  const lines = fullRendered.split('\n');

  const visibleLength = (line: string): number =>
    line.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
      .length;

  const maxWidth = lines.reduce(
    (max, line) => Math.max(max, visibleLength(line)),
    0
  );
  const widthMode = typeof width === 'number' && width > 0;
  const fillWidth = widthMode ? width : maxWidth;

  return React.createElement(
    React.Fragment,
    null,
    ...lines.map((line: string, lineIndex: number) => {
      const lineLen = visibleLength(line);
      const padTarget = widthMode
        ? Math.ceil(lineLen / fillWidth) * fillWidth
        : fillWidth;
      const padding = ' '.repeat(Math.max(0, padTarget - lineLen));
      return React.createElement(
        Text,
        { key: lineIndex, backgroundColor },
        line,
        padding
      );
    })
  );
}

/** Map a file extension to a lowlight language name. */
export function extToLang(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    xml: 'xml',
    dockerfile: 'dockerfile',
  };
  return map[ext.toLowerCase()] ?? 'plaintext';
}
