import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';
import { Markdown } from './Markdown.js';

export function MemoryManageBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const action = state.arguments.action as string | undefined;
    const key = state.arguments.key as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… memory.manage("${action ?? ''}", "${key ?? ''}")`}
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
  const key = (parsed.key as string) ?? (state.arguments.key as string) ?? '';

  if (action === 'store') {
    const tags = Array.isArray(parsed.tags) ? (parsed.tags as string[]) : [];
    const tagStr = tags.length > 0 ? `  (tags: [${tags.join(', ')}])` : '';
    return (
      <Text color={scheme.success} wrap="wrap">
        {`✓ memory.store: "${key}"${tagStr}`}
      </Text>
    );
  }

  if (action === 'recall') {
    const entry = parsed.entry as Record<string, unknown> | undefined;
    const value =
      (entry?.value as string | undefined) ??
      (parsed.value as string | undefined);
    if (value) {
      return (
        <>
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ memory.recall: "${key}"`}
          </Text>
          <Markdown color={scheme.info}>{value}</Markdown>
          <Text>{'\n'}</Text>
        </>
      );
    }
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ memory.recall: "${key}"`}
      </Text>
    );
  }

  if (action === 'delete') {
    const removed = parsed.removed;
    return (
      <Text color={scheme.success} wrap="wrap">
        {`✓ memory.delete: "${key}"  (removed: ${String(removed)})`}
      </Text>
    );
  }

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ ${result}`}
    </Text>
  );
}
