import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function ListToolsBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${state.name}`}
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

  const toolCount = typeof parsed.toolCount === 'number' ? parsed.toolCount : 0;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {`✓ ${state.name} — ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
    </Text>
  );

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const toolName =
      typeof tool === 'object' && tool !== null
        ? String((tool as Record<string, unknown>).name ?? '')
        : String(tool);
    const toolDesc =
      typeof tool === 'object' && tool !== null
        ? String((tool as Record<string, unknown>).description ?? '')
        : '';
    const line = toolDesc ? `  ${toolName} — ${toolDesc}` : `  ${toolName}`;
    elements.push(
      <Text key={`tool-${i}`} wrap="wrap">
        {line}
      </Text>
    );
  }

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
