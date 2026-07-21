import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';
import {
  lowlight,
  SYNTAX_COLORS,
  renderHighlightedTree,
  extToLang,
} from '../shared/syntax-highlight.js';

export function FileReadBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  const indicator =
    state.status === 'running' ? '…' : state.status === 'error' ? '✗' : '✓';

  if (state.status === 'running') {
    const path =
      typeof state.arguments.path === 'string' ? state.arguments.path : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`${indicator} ${path}`}
      </Text>
    );
  }

  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ ${state.name}: ${state.result ?? ''}`}
      </Text>
    );
  }

  const result = state.result ?? '';
  const parsed = tryParseJson(result);
  if (!parsed) {
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ ${result}`}
      </Text>
    );
  }

  const path = typeof parsed.path === 'string' ? parsed.path : '';
  const totalLines =
    typeof parsed.totalLines === 'number' ? parsed.totalLines : 0;
  const startLine = typeof parsed.startLine === 'number' ? parsed.startLine : 1;
  const endLine = typeof parsed.endLine === 'number' ? parsed.endLine : 0;
  const content = typeof parsed.content === 'string' ? parsed.content : '';

  const header = `✓ ${path} (${startLine}–${endLine} of ${totalLines} lines)`;

  // Syntax-highlight the first 5 lines
  const contentLines = content.split('\n');
  const previewLines = contentLines.slice(0, 5);
  const previewCode = previewLines.join('\n');

  // Infer language from file extension
  const ext = path.split('.').pop() ?? '';
  const lang = extToLang(ext);

  let highlighted: ReactNode = null;
  if (previewCode.length > 0) {
    try {
      const tree = lowlight.highlight(lang, previewCode);
      highlighted = renderHighlightedTree(tree, 'gray', SYNTAX_COLORS);
    } catch {
      highlighted = <Text color="white">{previewCode}</Text>;
    }
  }

  return (
    <>
      <Text color={scheme.toolResult} wrap="wrap">
        {header}
      </Text>
      {highlighted && <>{highlighted}</>}
      <Text color="gray">{'==='}</Text>
      <Text>{'\n'}</Text>
    </>
  );
}
