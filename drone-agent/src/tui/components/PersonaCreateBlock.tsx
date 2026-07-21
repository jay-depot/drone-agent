import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function PersonaCreateBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'… persona.create(...)'}
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
  const message =
    parsed && typeof parsed.message === 'string'
      ? (parsed.message as string)
      : 'Workflow completed.';

  return (
    <Text color={scheme.success} wrap="wrap">
      {`✓ persona.create: ${message}`}
    </Text>
  );
}
