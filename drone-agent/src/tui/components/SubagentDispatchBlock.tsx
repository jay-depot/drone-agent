import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { Markdown } from './Markdown.js';

const DIVIDER = '\n\n─────────────────────────────────────\n\n';

function parseLastAction(
  outputLines?: string[]
): { kind: string; content: string } | null {
  if (!outputLines || outputLines.length === 0) return null;
  const last = outputLines[outputLines.length - 1];
  const colonIdx = last.indexOf(':');
  if (colonIdx === -1) return { kind: 'unknown', content: last };
  return { kind: last.slice(0, colonIdx), content: last.slice(colonIdx + 1) };
}

function extractResult(json: string): string {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.error === 'string') return parsed.error;
    return json;
  } catch {
    return json;
  }
}

function renderLastAction(
  action: { kind: string; content: string },
  scheme: DroneColorScheme
): ReactNode {
  switch (action.kind) {
    case 'reasoning':
      return (
        <Text color={scheme.reasoning} wrap="wrap">
          {action.content}
        </Text>
      );
    case 'tool':
      return (
        <Text color={scheme.toolCall} wrap="wrap">
          ⚡ {action.content}
        </Text>
      );
    case 'msg':
      return (
        <Text color={scheme.info} wrap="wrap">
          {action.content}
        </Text>
      );
    case 'done':
      return <Markdown color={scheme.info}>{action.content}</Markdown>;
    case 'error':
      return (
        <Text color={scheme.error} wrap="wrap">
          ✗ {action.content}
        </Text>
      );
    default:
      return <Text wrap="wrap">{action.content}</Text>;
  }
}

export function SubagentDispatchBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const persona =
    typeof state.arguments.persona === 'string'
      ? state.arguments.persona
      : undefined;
  const task =
    typeof state.arguments.task === 'string' ? state.arguments.task : '';
  const lastAction = parseLastAction(state.outputLines);

  const indicator =
    state.status === 'running' ? '…' : state.status === 'error' ? '✗' : '✓';
  const headerColor = state.status === 'error' ? scheme.error : scheme.info;
  const header = `subagent__dispatch${persona ? ` - ${persona}` : ''}`;

  return (
    <>
      <Text color={headerColor} wrap="wrap">
        {indicator} {header}
      </Text>
      <Markdown color={scheme.info}>{task}</Markdown>
      <Text>{DIVIDER}</Text>
      {state.status === 'running' &&
        lastAction &&
        renderLastAction(lastAction, scheme)}
      {state.status === 'done' && (
        <Markdown color={scheme.info}>
          {extractResult(state.result ?? '')}
        </Markdown>
      )}
      {state.status === 'error' && (
        <Text color={scheme.error} wrap="wrap">
          {state.result ?? 'Subagent failed'}
        </Text>
      )}
      <Text>{'\n'}</Text>
    </>
  );
}
