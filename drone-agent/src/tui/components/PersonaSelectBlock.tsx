import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function PersonaSelectBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const id = state.arguments.id as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… persona.select("${id ?? ''}")`}
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

  // Error response from the tool (returned as done status with error: true)
  if (parsed.error === true) {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ persona.select: ${(parsed.message as string) ?? 'error'}`}
      </Text>
    );
  }

  const name =
    (parsed.name as string) ?? (parsed.activePersona as string) ?? '';

  if (parsed.activePersona === null) {
    return (
      <Text color={scheme.info} wrap="wrap">
        {'✓ persona.select: (none) → cleared'}
      </Text>
    );
  }

  return (
    <Text color={scheme.success} wrap="wrap">
      {`✓ persona.select: "${name}" → active`}
    </Text>
  );
}
