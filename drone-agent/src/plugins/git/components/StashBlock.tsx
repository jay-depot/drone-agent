import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading, renderList, type ListItem } from './list.js';

type StashResult = {
  action: string;
  files: ListItem[];
  message?: string;
};

export function StashBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git stash...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git stash: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as StashResult | undefined;
  const action = parsed?.action ?? 'list';
  const out: ReactNode[] = [renderHeading(`## git stash ${action}`, scheme)];
  if (parsed?.message) {
    out.push(
      <Text dimColor wrap="wrap">
        {parsed.message}
      </Text>
    );
  }
  if (parsed?.files?.length) {
    out.push(...renderList(parsed.files, scheme));
  } else if (action === 'list') {
    out.push(
      <Text color={scheme.toolResult} wrap="wrap">
        {'No stashes'}
      </Text>
    );
  }
  return <>{out}</>;
}
