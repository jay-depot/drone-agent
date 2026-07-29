import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function PersonaListBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'… persona.list()'}
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

  const personas = (parsed.personas ?? []) as Array<Record<string, unknown>>;
  const activePersona = parsed.activePersona as string | null;
  const count = personas.length;

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {`✓ persona.list: ${count} persona${count === 1 ? '' : 's'}`}
    </Text>
  );

  elements.push(
    <Text key="active" color={scheme.info} wrap="wrap">
      {`  active: ${activePersona ?? '(none)'}`}
    </Text>
  );

  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    const id = (p.id as string) ?? '';
    const desc = (p.description as string) ?? '';
    elements.push(
      <Text key={`persona-${i}`} wrap="wrap">
        {`  - ${id}  (${desc})`}
      </Text>
    );
  }

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
