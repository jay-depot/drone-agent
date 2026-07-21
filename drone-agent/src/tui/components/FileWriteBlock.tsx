import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function FileWriteBlock({
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
  const path =
    parsed && typeof parsed.path === 'string'
      ? parsed.path
      : typeof state.arguments.path === 'string'
        ? state.arguments.path
        : '';

  return (
    <Text color={scheme.success} wrap="wrap">
      {`✓ Wrote ${path}`}
    </Text>
  );
}
