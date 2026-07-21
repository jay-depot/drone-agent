import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function FileListBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const path =
      typeof state.arguments.path === 'string' ? state.arguments.path : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${path}`}
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
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {path}
    </Text>
  );

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    const type = typeof item.type === 'string' ? item.type : 'file';

    if (type === 'directory') {
      elements.push(
        <Text key={`item-${i}`} color={scheme.info} wrap="wrap">
          {'📁 '}
          {name}
          {'/'}
        </Text>
      );
    } else {
      elements.push(
        <Text key={`item-${i}`} wrap="wrap">
          {'📄 '}
          {name}
        </Text>
      );
    }
  }

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
