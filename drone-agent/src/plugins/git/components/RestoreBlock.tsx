import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading, renderList, type ListItem } from './list.js';

type RestoreResult = {
  staged: boolean;
  files: ListItem[];
};

export function RestoreBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git restore...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git restore: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as RestoreResult | undefined;
  const heading = parsed?.staged ? '## git restore --staged' : '## git restore';
  const out: ReactNode[] = [renderHeading(heading, scheme)];
  if (parsed?.files?.length) {
    out.push(...renderList(parsed.files, scheme));
  } else {
    out.push(
      <Text color={scheme.toolResult} wrap="wrap">
        {'Nothing to restore'}
      </Text>
    );
  }
  return <>{out}</>;
}
