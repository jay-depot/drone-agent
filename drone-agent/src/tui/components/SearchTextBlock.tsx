import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function SearchTextBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const pattern =
      typeof state.arguments.pattern === 'string'
        ? state.arguments.pattern
        : '';
    const searchPath =
      typeof state.arguments.path === 'string' ? state.arguments.path : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${pattern} in ${searchPath}`}
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

  const pattern = typeof parsed.pattern === 'string' ? parsed.pattern : '';
  const searchPath =
    typeof parsed.searchPath === 'string' ? parsed.searchPath : '';
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const resultCount =
    typeof parsed.resultCount === 'number'
      ? parsed.resultCount
      : results.length;
  const truncated = parsed.truncated === true;

  const elements: ReactNode[] = [];
  elements.push(
    <Text key="header" color={scheme.toolResult} wrap="wrap">
      {`${pattern} in ${searchPath}`}
    </Text>
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i] as Record<string, unknown>;
    const file = typeof r.file === 'string' ? r.file : '';
    const line = typeof r.line === 'number' ? r.line : 0;
    const content = typeof r.content === 'string' ? r.content : '';

    elements.push(
      <Text key={`result-${i}`} wrap="wrap">
        <Text color={scheme.info}>{`${file}:${line}`}</Text>
        {'  '}
        {content}
      </Text>
    );
  }

  const countText = `(${resultCount} match${resultCount === 1 ? '' : 'es'})`;
  if (truncated) {
    elements.push(
      <Text key="count" color={scheme.warning} wrap="wrap">
        {`${countText} [truncated]`}
      </Text>
    );
  } else {
    elements.push(
      <Text key="count" color={scheme.info} wrap="wrap">
        {countText}
      </Text>
    );
  }

  elements.push(<Text key="trailing">{'\n'}</Text>);
  return <>{elements}</>;
}
