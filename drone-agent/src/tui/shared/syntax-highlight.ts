/**
 * Shared syntax highlighting helpers for TUI components.
 *
 * Extracts the lowlight-based highlighting logic used by Markdown.tsx
 * so that other components (e.g. FileReadBlock) can reuse it without
 * duplicating the lowlight instance, color maps, or rendering functions.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import { createLowlight, common } from 'lowlight';
import React from 'react';

export const lowlight = createLowlight(common);

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

export const ANSI_COLORS: Record<string, string> = {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTokenText(token: any): string {
  if (token.value) return token.value;
  if (token.children) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return token.children.map(extractTokenText).join('');
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTokenColor(
  token: any,
  syntaxColors: Record<string, string>
): string {
  if (token.properties?.className) {
    for (const cls of token.properties.className) {
      if (typeof cls === 'string' && cls.startsWith('hljs-')) {
        const key = cls.slice(5);
        if (syntaxColors[key]) return syntaxColors[key];
      }
    }
  }
  return 'white';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderHighlightedTree(
  tree: any,
  backgroundColor: string,
  syntaxColors: Record<string, string>
): ReactNode {
  let fullRendered = '';
  for (const token of tree.children ?? []) {
    const color = getTokenColor(token, syntaxColors);
    const ansiCode = ANSI_COLORS[color] || '37';
    const text = extractTokenText(token);
    if (text) fullRendered += `\u001b[${ansiCode}m${text}\u001b[39m`;
  }

  const lines = fullRendered.split('\n');

  const maxWidth = lines.reduce((max, line) => {
    const visible = line.replace(/\u001b\[\d+m/g, '');
    return Math.max(max, visible.length);
  }, 0);

  return React.createElement(
    React.Fragment,
    null,
    ...lines.map((line: string, lineIndex: number) => {
      const visibleLen = line.replace(/\u001b\[\d+m/g, '').length;
      const padding = ' '.repeat(Math.max(0, maxWidth - visibleLen));
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
