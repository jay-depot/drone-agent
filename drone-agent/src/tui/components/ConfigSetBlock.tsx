import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function ConfigSetBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const key = state.arguments.key as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… config.set("${key ?? ''}", ...)`}
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

  const key = (parsed.key as string) ?? '';
  const scope = (parsed.scope as string) ?? 'project';

  return (
    <Text color={scheme.success} wrap="wrap">
      {`✓ config.set: ${key} → ${scope} scope  (restart to apply)`}
    </Text>
  );
}
