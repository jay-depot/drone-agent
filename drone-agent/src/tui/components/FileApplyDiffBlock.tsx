import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function FileApplyDiffBlock({
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
  const summary = parsed.summary as
    | { additions?: number; deletions?: number; hunks?: number }
    | undefined;
  const additions = summary?.additions ?? 0;
  const deletions = summary?.deletions ?? 0;
  const hunks = summary?.hunks ?? 0;

  return (
    <>
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ ${path}`}
      </Text>
      <Text wrap="wrap">
        <Text color={scheme.success}>+{additions}</Text>{' '}
        <Text color={scheme.error}>-{deletions}</Text>
        {` across ${hunks} hunk${hunks === 1 ? '' : 's'}`}
      </Text>
      <Text>{'\n'}</Text>
    </>
  );
}
