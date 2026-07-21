import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function MemoryBrowseBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const action = state.arguments.action as string | undefined;
    const filter =
      (state.arguments.prefix as string) ??
      (state.arguments.query as string) ??
      '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… memory.browse("${action ?? ''}", ${filter ? `"${filter}"` : ''})`}
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

  const action = state.arguments.action as string | undefined;
  const entries = (parsed.entries ?? parsed.results ?? []) as Array<
    Record<string, unknown>
  >;
  const count = (parsed.count as number) ?? entries.length;

  const elements: ReactNode[] = [];

  if (action === 'list') {
    const prefix = (parsed.prefix as string | null) ?? '';
    elements.push(
      <Text key="header" color={scheme.toolResult} wrap="wrap">
        {`✓ memory.list${prefix ? ` (prefix: "${prefix}")` : ''}`}
      </Text>
    );
  } else if (action === 'search') {
    const query = parsed.query as string;
    elements.push(
      <Text key="header" color={scheme.toolResult} wrap="wrap">
        {`✓ memory.search "${query}"`}
      </Text>
    );
  } else {
    elements.push(
      <Text key="header" color={scheme.toolResult} wrap="wrap">
        {`✓ memory.browse`}
      </Text>
    );
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const key = (entry.key as string) ?? (entry.id as string) ?? '';
    const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const tagStr = tags.length > 0 ? `  (tags: [${tags.join(', ')}])` : '';
    elements.push(
      <Text key={`entry-${i}`} wrap="wrap">
        {`  ${key}${tagStr}`}
      </Text>
    );
  }

  elements.push(
    <Text key="count" color={scheme.info} wrap="wrap">
      {`(${count} ${action === 'search' ? (count === 1 ? 'result' : 'results') : (count === 1 ? 'entry' : 'entries')})`}
    </Text>
  );

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
