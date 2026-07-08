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
import { createLowlight, common } from 'lowlight';

/**
 * Create lowlight instance with common languages.
 * The 'common' preset includes all popular languages (javascript, typescript,
 * python, rust, go, json, bash, yaml, html, css, sql, markdown, etc.)
 */
const lowlight = createLowlight(common);

/**
 * Color mapping for syntax highlighting.
 * Terminal-friendly colors that work in most environments.
 */
const SYNTAX_COLORS: Record<string, string> = {
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

interface MarkdownProps {
  /** Markdown content to render */
  children: string;
  /** Optional color scheme for text (defaults to white) */
  color?: string;
  /** Optional background for inline code */
  codeBackground?: string;
}

/**
 * Main Markdown component - parses and renders markdown content.
 */
export function Markdown({
  children,
  color = 'white',
  codeBackground = 'gray',
}: MarkdownProps): React.JSX.Element {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokens = marked.lexer(children) as unknown as any[];
  return (
    <Box flexDirection="column">
      {tokens.map((token: any, index: number) => (
        <React.Fragment key={index}>
          {renderToken(token, color, codeBackground)}
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
  codeBackground: string
): ReactNode {
  const textColor = token.type === 'paragraph' ? color : undefined;

  switch (token.type) {
    case 'heading':
      return renderHeading(token, textColor ?? color);

    case 'paragraph':
      return (
        <Text color={textColor}>
          {token.tokens?.map((t: any) => renderInlineToken(t, color)).flat()}
        </Text>
      );

    case 'blockquote':
      return renderBlockquote(token, textColor ?? color);

    case 'list':
      return renderList(token, textColor ?? color);

    case 'code':
      return renderCodeBlock(token, codeBackground);

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
  defaultColor: string
): ReactNode[] {
  switch (token.type) {
    case 'strong':
      return [
        <Text bold key={token.raw}>
          {token.tokens?.flatMap((t: any) =>
            renderInlineToken(t, defaultColor)
          )}
        </Text>,
      ];

    case 'emphasis':
      return [
        <Text italic key={token.raw}>
          {token.tokens?.flatMap((t: any) =>
            renderInlineToken(t, defaultColor)
          )}
        </Text>,
      ];

    case 'codespan':
      return [
        <Text key={token.raw} backgroundColor="gray" color="black">
          {token.text}
        </Text>,
      ];

    case 'link':
      return [
        <Text key={token.raw} color="cyan" underline>
          {token.tokens?.flatMap((t: any) => renderInlineToken(t, 'cyan'))}
          {token.href && <Text color="gray"> ({token.href})</Text>}
        </Text>,
      ];

    case 'text':
      return [token.text ?? ''];

    case 'br':
      return ['\n'];

    case 'del':
      return [
        <Text strikethrough key={token.raw}>
          {token.tokens?.flatMap((t: any) =>
            renderInlineToken(t, defaultColor)
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
  color: string
): ReactNode {
  const depth = token.depth ?? 1;

  return (
    <Text bold color={color} wrap="wrap">
      <Text bold>{'#'.repeat(depth)} </Text>
      {token.tokens?.flatMap((t: any) => renderInlineToken(t, color))}
    </Text>
  );
}

/**
 * Render a blockquote with a left border.
 */
function renderBlockquote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  color: string
): ReactNode {
  const content =
    token.text ||
    token.tokens?.flatMap((t: any) => renderInlineToken(t, color)).join('') ||
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
  color: string
): ReactNode {
  const isOrdered = token.ordered ?? false;
  const items = token.items ?? [];

  return (
    <Box flexDirection="column">
      {items.map((item: any, index: number) => (
        <Text key={index} color={color}>
          {isOrdered ? `${index + 1}. ` : '• '}
          {item.flatMap((t: any) => renderInlineToken(t, color))}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Render a code block with syntax highlighting.
 */
function renderCodeBlock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: any,
  codeBackground: string
): ReactNode {
  const code = token.text ?? '';
  const lang = token.lang ?? 'plaintext';

  // Try to highlight, fallback to plain text
  let highlighted: ReactNode;

  try {
    const tree = lowlight.highlight(lang, code);
    highlighted = renderHighlightedTree(tree, codeBackground);
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

/**
 * Render lowlight syntax tree to Ink components.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderHighlightedTree(tree: any, backgroundColor: string): ReactNode {
  const lines = tree.children;

  return (
    <>
      {lines.map((line: any, lineIndex: number) => (
        <Text key={lineIndex} backgroundColor={backgroundColor}>
          {line.children
            ? line.children.map((token: any, tokenIndex: number) => {
                const color = SYNTAX_COLORS[token.type] || 'white';
                return (
                  <Text key={tokenIndex} color={color}>
                    {token.value}
                  </Text>
                );
              })
            : line.value}
        </Text>
      ))}
    </>
  );
}
