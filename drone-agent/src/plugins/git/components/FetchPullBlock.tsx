import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading } from './list.js';

type FetchPullResult = {
  command: 'fetch' | 'pull';
  success: boolean;
  explanation?: string;
};

export function FetchPullBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    const cmd = state.name.includes('pull') ? 'pull' : 'fetch';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… git ${cmd}...`}
      </Text>
    );
  }
  if (state.status === 'error') {
    const cmd = state.name.includes('pull') ? 'pull' : 'fetch';
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git ${cmd}: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as FetchPullResult | undefined;
  const command =
    parsed?.command ?? (state.name.includes('pull') ? 'pull' : 'fetch');
  const success = parsed?.success ?? false;
  const heading = `## git ${command}: ${success ? 'success' : 'fail'}`;
  const out: ReactNode[] = [renderHeading(heading, scheme)];
  if (parsed?.explanation) {
    // Show the real git output (e.g. "remote: Counting objects…") on both
    // success and failure — it was captured and must not be discarded.
    out.push(
      <Text color={success ? scheme.toolResult : scheme.error} wrap="wrap">
        {parsed.explanation}
      </Text>
    );
  }
  return <>{out}</>;
}
