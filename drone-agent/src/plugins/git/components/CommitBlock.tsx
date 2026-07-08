import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading } from './list.js';

type CommitResult = {
  success: boolean;
  hash?: string;
  message?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  explanation?: string;
};

export function CommitBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git commit...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git commit: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as CommitResult | undefined;
  if (!parsed || parsed.success === false) {
    const out: ReactNode[] = [renderHeading('## git commit: fail', scheme)];
    out.push(
      <Text color={scheme.error} wrap="wrap">
        {parsed?.explanation ?? result}
      </Text>
    );
    return <>{out}</>;
  }

  const out: ReactNode[] = [];
  if (parsed.hash) {
    out.push(renderHeading(`## git commit ${parsed.hash.slice(0, 8)}`, scheme));
  } else {
    out.push(renderHeading('## git commit', scheme));
  }
  if (parsed.message) {
    out.push(<Text wrap="wrap">{parsed.message}</Text>);
  }
  if (
    typeof parsed.filesChanged === 'number' ||
    typeof parsed.insertions === 'number' ||
    typeof parsed.deletions === 'number'
  ) {
    const stats = [
      parsed.filesChanged !== undefined ? `${parsed.filesChanged} files` : null,
      parsed.insertions !== undefined ? `+${parsed.insertions}` : null,
      parsed.deletions !== undefined ? `-${parsed.deletions}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    out.push(
      <Text dimColor wrap="wrap">
        {stats}
      </Text>
    );
  }
  return <>{out}</>;
}
