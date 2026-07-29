import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function SelfImprovementInsightBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const action = state.arguments.action as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… self-improvement.insight("${action ?? ''}", ...)`}
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

  if (action === 'record') {
    const targetType = (parsed.targetType as string) ?? '';
    const targetId = (parsed.targetId as string) ?? '';
    return (
      <Text color={scheme.success} wrap="wrap">
        {`✓ self-improvement.insight: recorded for ${targetType} "${targetId}"`}
      </Text>
    );
  }

  if (action === 'list') {
    const insights = (parsed.insights ?? []) as Array<Record<string, unknown>>;
    const elements: ReactNode[] = [];
    elements.push(
      <Text key="header" color={scheme.toolResult} wrap="wrap">
        {'✓ self-improvement.insight: list'}
      </Text>
    );
    for (let i = 0; i < insights.length; i++) {
      const ins = insights[i];
      const tt = (ins.targetType as string) ?? '';
      const tid = (ins.targetId as string) ?? '';
      const count = (ins.entryCount as number) ?? 0;
      elements.push(
        <Text key={`insight-${i}`} wrap="wrap">
          {`  ${tt}/${tid} (${count} entr${count === 1 ? 'y' : 'ies'})`}
        </Text>
      );
    }
    elements.push(<Text key="trailing">{'\n'}</Text>);
    return <>{elements}</>;
  }

  if (action === 'recall') {
    const targetType = (parsed.targetType as string) ?? '';
    const targetId = (parsed.targetId as string) ?? '';
    const entries = (parsed.entries ?? []) as Array<Record<string, unknown>>;
    const elements: ReactNode[] = [];
    elements.push(
      <Text key="header" color={scheme.toolResult} wrap="wrap">
        {`✓ self-improvement.insight: recall ${targetType} "${targetId}"`}
      </Text>
    );
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const text = (entry.insight as string) ?? (entry.text as string) ?? '';
      elements.push(
        <Text key={`entry-${i}`} wrap="wrap">
          {`  - ${text}`}
        </Text>
      );
    }
    elements.push(
      <Text key="count" color={scheme.info} wrap="wrap">
        {`(${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`}
      </Text>
    );
    elements.push(<Text key="trailing">{'\n'}</Text>);
    return <>{elements}</>;
  }

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ ${result}`}
    </Text>
  );
}
