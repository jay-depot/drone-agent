import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading, renderList, type ListItem } from './list.js';

type AddResult = {
  files: ListItem[];
};

export function AddBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git add...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git add: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as AddResult | undefined;
  const out: ReactNode[] = [renderHeading('## git add', scheme)];
  if (parsed?.files?.length) {
    out.push(...renderList(parsed.files, scheme));
  } else {
    out.push(
      <Text color={scheme.toolResult} wrap="wrap">
        {'No changes staged'}
      </Text>
    );
  }
  return <>{out}</>;
}
