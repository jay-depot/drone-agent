import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function UnmountToolBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const toolArg =
    typeof state.arguments.tool === 'string' ? state.arguments.tool : '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${state.name}(${toolArg})`}
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

  if (parsed.success === true) {
    const toolName = String(parsed.tool ?? toolArg);
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ ${toolName}`}
      </Text>
    );
  }

  const errorMsg = parsed.error ? String(parsed.error) : 'Unknown error';
  return (
    <Text color={scheme.error} wrap="wrap">
      {`✗ ${errorMsg}`}
    </Text>
  );
}
