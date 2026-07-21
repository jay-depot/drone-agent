import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function ConfigGetBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const key = state.arguments.key as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… config.get(${key ? `"${key}"` : ''})`}
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

  // With a key: { key, value, source }
  if (typeof parsed.key === 'string') {
    const key = parsed.key as string;
    const value = parsed.value;
    const source = (parsed.source as string) ?? 'unknown';
    const valueStr =
      typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ config.get: ${key} = ${valueStr}  (source: ${source})`}
      </Text>
    );
  }

  // Full config: has _provenance map
  if (parsed._provenance) {
    const keys = Object.keys(parsed).filter(k => k !== '_provenance');
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ config.get: all  (${keys.length} keys)`}
      </Text>
    );
  }

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ ${result}`}
    </Text>
  );
}
