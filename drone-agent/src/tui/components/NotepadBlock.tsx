import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';
import { Markdown } from './Markdown.js';

export function NotepadBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const action = state.arguments.action as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… notepad.manage("${action ?? ''}", ...)`}
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

  const action = state.arguments.action as string | undefined;

  if (action === 'clear') {
    return (
      <Text color={scheme.info} wrap="wrap">
        {'✓ notepad.clear'}
      </Text>
    );
  }

  // set or append — show the content from arguments as markdown
  const content = state.arguments.content as string | undefined;
  const actionLabel = action === 'set' ? 'set' : 'append';

  if (content) {
    return (
      <>
        <Text color={scheme.success} wrap="wrap">
          {`✓ notepad.${actionLabel}`}
        </Text>
        <Markdown
          color={scheme.info}
          syntaxColors={state.syntaxColors}
          codeBackground={state.codeBackground}
        >
          {content}
        </Markdown>
        <Text>{'\n'}</Text>
      </>
    );
  }

  return (
    <Text color={scheme.success} wrap="wrap">
      {`✓ notepad.${actionLabel}`}
    </Text>
  );
}
