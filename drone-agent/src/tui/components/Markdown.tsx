/**
 * Markdown rendering for the TUI.
 *
 * Uses `marked` to parse markdown into tokens, then renders them as Ink
 * components. Supports:
 * - Bold, italic, strikethrough, inline code, links
 * - Code blocks with syntax highlighting (lowlight)
 * - Headers, blockquotes, lists, horizontal rules
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import React from 'react';
import { marked } from 'marked';
import {
  lowlight,
  SYNTAX_COLORS,
  renderHighlightedTree,
  extractTokenText,
  getTokenColor,
} from '../shared/syntax-highlight.js';

interface MarkdownProps {
  /** Markdown content to render */
  children: string;
  /** Optional color scheme for text (defaults to white) */
  color?: string;
  /** Optional background for inline code */
  codeBackground?: string;
  /** Optional syntax highlighting color overrides (defaults to SYNTAX_COLORS) */
  syntaxColors?: Record<string, string>;
}

/**
 * Main Markdown component - parses and renders markdown content.
 */
export function Markdown({
  children,
  color = 'white',
  codeBackground = 'gray',
  syntaxColors = SYNTAX_COLORS,
}: MarkdownProps): React.JSX.Element {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokens = marked.lexer(children) as unknown as any[];
  return (
    <Box flexDirection="column">
      {tokens.map((token: any, index: number) => (
        <React.Fragment key={index}>
          {renderToken(
            token,
            color,
            codeBackground,
            syntaxColors,
            `root-${index}`
          )}
        </React.Fragment>
      ))}
    </Box>
  );
}

/**
 * Render a single token (or sequence of tokens) to Ink components.
 */
function renderToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  color: string,
  codeBackground: string,
  syntaxColors: Record<string, string>,
  keyPrefix: string
): ReactNode {
  const textColor = token.type === 'paragraph' ? color : undefined;

  switch (token.type) {
    case 'heading':
      return renderHeading(token, textColor ?? color, keyPrefix);

    case 'paragraph':
      return (
        <Text color={textColor}>
          {token.tokens
            ?.map((t: any, i: number) =>
              renderInlineToken(t, color, `${keyPrefix}-p-${i}`)
            )
            .flat()}
        </Text>
      );

    case 'blockquote':
      return renderBlockquote(token, textColor ?? color, keyPrefix);

    case 'list':
      return renderList(token, textColor ?? color, keyPrefix);

    case 'code':
      return renderCodeBlock(token, codeBackground, syntaxColors);

    case 'hr':
      return <Text color="gray">{'-'.repeat(80)}</Text>;

    case 'html':
    case 'space':
      return null;

    default:
      // For any unmatched token, try to render as text
      if (token.text) {
        return <Text color={textColor}>{token.text}</Text>;
      }
      return null;
  }
}

/**
 * Render inline tokens (strong, em, codespan, link, etc.)
 */
function renderInlineToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  defaultColor: string,
  keyPrefix: string
): ReactNode[] {
  const key = `${keyPrefix}-${token.type ?? 'inline'}`;

  switch (token.type) {
    case 'strong':
      return [
        <Text bold key={key}>
          {token.tokens?.flatMap((t: any, i: number) =>
            renderInlineToken(t, defaultColor, `${keyPrefix}-strong-${i}`)
          )}
        </Text>,
      ];

    case 'emphasis':
      return [
        <Text italic key={key}>
          {token.tokens?.flatMap((t: any, i: number) =>
            renderInlineToken(t, defaultColor, `${keyPrefix}-em-${i}`)
          )}
        </Text>,
      ];

    case 'codespan':
      return [
        <Text key={key} backgroundColor="gray" color="black">
          {token.text}
        </Text>,
      ];

    case 'link':
      return [
        <Text key={key} color="cyan" underline>
          {token.tokens?.flatMap((t: any, i: number) =>
            renderInlineToken(t, 'cyan', `${keyPrefix}-link-${i}`)
          )}
          {token.href && <Text color="gray"> ({token.href})</Text>}
        </Text>,
      ];

    case 'text':
      return [token.text ?? ''];

    case 'br':
      return ['\n'];

    case 'del':
      return [
        <Text strikethrough key={key}>
          {token.tokens?.flatMap((t: any, i: number) =>
            renderInlineToken(t, defaultColor, `${keyPrefix}-del-${i}`)
          )}
        </Text>,
      ];

    default:
      return [token.text ?? ''];
  }
}

/**
 * Render a heading with appropriate sizing.
 */
function renderHeading(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  color: string,
  keyPrefix: string
): ReactNode {
  const depth = token.depth ?? 1;

  return (
    <Text bold color={color} wrap="wrap">
      <Text bold>{'#'.repeat(depth)} </Text>
      {token.tokens?.flatMap((t: any, i: number) =>
        renderInlineToken(t, color, `${keyPrefix}-h-${i}`)
      )}
    </Text>
  );
}

/**
 * Render a blockquote with a left border.
 */
function renderBlockquote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  color: string,
  keyPrefix: string
): ReactNode {
  const content =
    token.text ||
    token.tokens
      ?.flatMap((t: any, i: number) =>
        renderInlineToken(t, color, `${keyPrefix}-bq-${i}`)
      )
      .join('') ||
    '';

  return (
    <Box flexDirection="row">
      <Text color="gray">│ </Text>
      <Box flexDirection="column">
        <Text italic color={color}>
          {content}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Render a list (ordered or unordered).
 */
function renderList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  color: string,
  keyPrefix: string
): ReactNode {
  const isOrdered = token.ordered ?? false;
  const items = token.items ?? [];

  return (
    <Box flexDirection="column">
      {items.map((item: any, index: number) => (
        <Text key={`${keyPrefix}-li-${index}`} color={color}>
          {isOrdered ? `${index + 1}. ` : '• '}
          {renderListItemContent(item, color, `${keyPrefix}-li-${index}`)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Marked list items are objects (e.g. { text, tokens }) rather than arrays.
 * Handle both the standard object form and any legacy/edge array form safely.
 */
function renderListItemContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  color: string,
  keyPrefix: string
): ReactNode {
  if (Array.isArray(item)) {
    return item.flatMap((t: any, i: number) =>
      renderInlineToken(t, color, `${keyPrefix}-arr-${i}`)
    );
  }

  if (item?.tokens) {
    return item.tokens.flatMap((t: any, i: number) =>
      renderInlineToken(t, color, `${keyPrefix}-tok-${i}`)
    );
  }

  return item?.text ?? '';
}

/**
 * Render a code block with syntax highlighting.
 */
function renderCodeBlock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  codeBackground: string,
  syntaxColors: Record<string, string>
): ReactNode {
  const code = token.text ?? '';
  const lang = token.lang ?? 'plaintext';

  // Try to highlight, fallback to plain text
  let highlighted: ReactNode;

  try {
    const tree = lowlight.highlight(lang, code);
    highlighted = renderHighlightedTree(tree, codeBackground, syntaxColors);
  } catch {
    // Language not found or highlight failed
    highlighted = <Text color="white">{code}</Text>;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginY={1}
    >
      {lang !== 'plaintext' && (
        <Text color="gray" bold>
          {lang}
        </Text>
      )}
      <Box flexDirection="column">{highlighted}</Box>
    </Box>
  );
}
