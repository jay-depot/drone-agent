import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function FileGlobBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const pattern =
      typeof state.arguments.pattern === 'string'
        ? state.arguments.pattern
        : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${pattern}`}
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

  const pattern = typeof parsed.pattern === 'string' ? parsed.pattern : '';
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {pattern}
    </Text>
  );

  for (let i = 0; i < matches.length; i++) {
    const match = String(matches[i]);
    elements.push(
      <Text key={`match-${i}`} wrap="wrap">
        {match}
      </Text>
    );
  }

  elements.push(
    <Text key="count" color={scheme.info} wrap="wrap">
      {`(${matches.length} match${matches.length === 1 ? '' : 'es'})`}
    </Text>
  );

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
