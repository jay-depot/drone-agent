import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';
import { Markdown } from './Markdown.js';

export function SkillsRecallBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const id = state.arguments.id as string | undefined;
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… skills.recall("${id ?? ''}")`}
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

  const id = (parsed.id as string) ?? '';
  const body = (parsed.body as string) ?? '';

  if (body) {
    return (
      <>
        <Text color={scheme.toolResult} wrap="wrap">
          {`✓ skills.recall: "${id}"`}
        </Text>
        <Markdown
          color={scheme.info}
          syntaxColors={state.syntaxColors}
          codeBackground={state.codeBackground}
        >
          {body}
        </Markdown>
        <Text>{'\n'}</Text>
      </>
    );
  }

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ skills.recall: "${id}"`}
    </Text>
  );
}
