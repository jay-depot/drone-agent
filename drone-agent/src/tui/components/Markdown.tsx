/**
 * Markdown rendering for the TUI.
 *
 * Uses `marked` to parse markdown into tokens, then renders them as Ink
 * components. Supports:
 * - Bold, italic, strikethrough, inline code, links
 * - Code blocks with syntax highlighting (lowlight)
 * - Headers, blockquotes, lists, horizontal rules
 */

import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import React from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { lowlight, renderHighlightedTree } from '../shared/syntax-highlight.js';

interface MarkdownProps {
  /** Markdown content to render */
  children: string;
  /** Optional color scheme for text (defaults to white) */
  color?: string;
  /** Optional background for inline code */
  codeBackground?: string;
  /** Optional syntax highlighting overrides; omitted keys (or the whole
   * prop) fall back to DEFAULT_SYNTAX_THEME, whose attribute-only comment
   * style cannot collide with the code background. */
  syntaxColors?: Record<string, string>;
  /** Terminal columns override for code-block width computation. When
   * omitted, the component reads `stdout.columns` itself. Exists as an
   * explicit seam for tests and for callers that already know their
   * effective width. */
  columns?: number;
}

/**
 * Main Markdown component - parses and renders markdown content.
 */
export function Markdown({
  children,
  color = 'white',
  codeBackground = 'gray',
  syntaxColors,
  columns,
}: MarkdownProps): React.JSX.Element {
  const { stdout } = useStdout();
  const effectiveColumns = columns ?? stdout.columns;
  const tokens = marked.lexer(children);
  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <React.Fragment key={index}>
          {renderToken(
            token,
            color,
            codeBackground,
            syntaxColors,
            `root-${index}`,
            effectiveColumns
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
  token: Token,
  color: string,
  codeBackground: string,
  syntaxColors: Record<string, string> | undefined,
  keyPrefix: string,
  columns: number | undefined
): ReactNode {
  const textColor = token.type === 'paragraph' ? color : undefined;

  switch (token.type) {
    case 'heading':
      return renderHeading(
        token as Tokens.Heading,
        textColor ?? color,
        codeBackground,
        keyPrefix
      );

    case 'paragraph':
      return (
        <Text color={textColor}>
          {token.tokens
            ?.map((t, i) =>
              renderInlineToken(t, color, codeBackground, `${keyPrefix}-p-${i}`)
            )
            .flat()}
        </Text>
      );

    case 'blockquote':
      return renderBlockquote(token as Tokens.Blockquote, textColor ?? color);

    case 'list':
      return renderList(
        token as Tokens.List,
        textColor ?? color,
        codeBackground,
        keyPrefix
      );

    case 'code':
      return renderCodeBlock(
        token as Tokens.Code,
        codeBackground,
        syntaxColors,
        columns
      );

    case 'hr':
      return <Text color="gray">{'-'.repeat(80)}</Text>;

    case 'html':
    case 'space':
      return null;

    default:
      // For any unmatched token, try to render as text
      if ('text' in token && token.text) {
        return <Text color={textColor}>{token.text}</Text>;
      }
      return null;
  }
}

/**
 * Render inline tokens (strong, em, codespan, link, etc.)
 *
 * `codeBackground` rides along so nested codespans (e.g. inside bold or
 * emphasis) can draw their background without forcing a foreground color:
 * a hardcoded foreground here collides with terminal bold-promotion (fg
 * black renders as bright black — the same palette slot as the gray
 * background) and made text invisible.
 */
function renderInlineToken(
  token: Token,
  defaultColor: string,
  codeBackground: string,
  keyPrefix: string
): ReactNode[] {
  const key = `${keyPrefix}-${token.type ?? 'inline'}`;

  switch (token.type) {
    case 'strong':
      return [
        <Text bold key={key}>
          {token.tokens?.flatMap((t, i) =>
            renderInlineToken(
              t,
              defaultColor,
              codeBackground,
              `${keyPrefix}-strong-${i}`
            )
          )}
        </Text>,
      ];

    case 'emphasis':
      return [
        <Text italic key={key}>
          {token.tokens?.flatMap((t, i) =>
            renderInlineToken(
              t,
              defaultColor,
              codeBackground,
              `${keyPrefix}-em-${i}`
            )
          )}
        </Text>,
      ];

    case 'codespan':
      return [
        <Text key={key} backgroundColor={codeBackground}>
          {token.text}
        </Text>,
      ];

    case 'link':
      return [
        <Text key={key} color="cyan" underline>
          {token.tokens?.flatMap((t, i) =>
            renderInlineToken(
              t,
              'cyan',
              codeBackground,
              `${keyPrefix}-link-${i}`
            )
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
          {token.tokens?.flatMap((t, i) =>
            renderInlineToken(
              t,
              defaultColor,
              codeBackground,
              `${keyPrefix}-del-${i}`
            )
          )}
        </Text>,
      ];

    default:
      // br, escape, checkbox and other text-less inline tokens render empty.
      return ['text' in token ? (token.text ?? '') : ''];
  }
}

/**
 * Render a heading with appropriate sizing.
 */
function renderHeading(
  token: Tokens.Heading,
  color: string,
  codeBackground: string,
  keyPrefix: string
): ReactNode {
  const depth = token.depth ?? 1;

  return (
    <Text bold color={color} wrap="wrap">
      <Text bold>{'#'.repeat(depth)} </Text>
      {token.tokens?.flatMap((t, i) =>
        renderInlineToken(t, color, codeBackground, `${keyPrefix}-h-${i}`)
      )}
    </Text>
  );
}

/**
 * Render a blockquote with a left border.
 *
 * Blockquote content uses `token.text` (marked's raw text form); joining
 * rendered inline nodes into a string instead would stringify React
 * elements to "[object Object]".
 */
function renderBlockquote(token: Tokens.Blockquote, color: string): ReactNode {
  const content = token.text ?? '';

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
  token: Tokens.List,
  color: string,
  codeBackground: string,
  keyPrefix: string
): ReactNode {
  const isOrdered = token.ordered ?? false;
  const items = token.items ?? [];

  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Text key={`${keyPrefix}-li-${index}`} color={color}>
          {isOrdered ? `${index + 1}. ` : '• '}
          {renderListItemContent(
            item,
            color,
            codeBackground,
            `${keyPrefix}-li-${index}`
          )}
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
  item: Tokens.ListItem,
  color: string,
  codeBackground: string,
  keyPrefix: string
): ReactNode {
  if (Array.isArray(item)) {
    return item.flatMap((t, i) =>
      renderInlineToken(t, color, codeBackground, `${keyPrefix}-arr-${i}`)
    );
  }

  if (item?.tokens) {
    return item.tokens.flatMap((t, i) =>
      renderInlineToken(t, color, codeBackground, `${keyPrefix}-tok-${i}`)
    );
  }

  return item?.text ?? '';
}

/**
 * Render a code block with syntax highlighting.
 *
 * The code box contributes border (2 columns) + paddingX (2 columns) of
 * chrome, so the content width available to highlighted lines is
 * `columns - 4` (the container-subtraction convention documented on
 * renderHighlightedTree). Undefined/non-positive columns falls back to
 * that function's legacy maxWidth mode.
 */
function renderCodeBlock(
  token: Tokens.Code,
  codeBackground: string,
  syntaxColors: Record<string, string> | undefined,
  columns: number | undefined
): ReactNode {
  const code = token.text ?? '';
  const lang = token.lang ?? 'plaintext';
  const contentWidth =
    typeof columns === 'number' && columns > 0 ? columns - 4 : undefined;

  // Try to highlight, fallback to plain text
  let highlighted: ReactNode;

  try {
    const tree = lowlight.highlight(lang, code);
    highlighted = renderHighlightedTree(
      tree,
      codeBackground,
      syntaxColors,
      contentWidth
    );
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
