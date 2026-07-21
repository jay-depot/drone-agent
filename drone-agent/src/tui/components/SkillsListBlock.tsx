import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function SkillsListBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'… skills.list()'}
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

  const skills = (parsed.skills ?? []) as Array<Record<string, unknown>>;
  const count = (parsed.count as number) ?? skills.length;

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {`✓ skills.list: ${count} skill${count === 1 ? '' : 's'}`}
    </Text>
  );

  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const id = (s.id as string) ?? '';
    const desc = (s.description as string) ?? '';
    elements.push(
      <Text key={`skill-${i}`} wrap="wrap">
        {`  - ${id}  (${desc})`}
      </Text>
    );
  }

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
