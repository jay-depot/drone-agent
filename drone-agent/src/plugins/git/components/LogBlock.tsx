import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading } from './list.js';

type LogEntry = {
  hash: string;
  author: string;
  date: string;
  message: string;
};

type LogResult = {
  path?: string;
  entries: LogEntry[];
};

export function LogBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git log...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git log: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as LogResult | undefined;
  const heading = parsed?.path ? `## git log ${parsed.path}` : '## git log';
  const out: ReactNode[] = [renderHeading(heading, scheme)];
  if (parsed?.entries?.length) {
    for (const e of parsed.entries) {
      out.push(
        <Text key={e.hash} wrap="wrap">
          <Text color={scheme.info}>{`${e.hash.slice(0, 8)}`}</Text>
          {` — ${e.message}`}
        </Text>
      );
      out.push(
        <Text key={`${e.hash}-meta`} dimColor wrap="wrap">
          {`    ${e.author} · ${e.date}`}
        </Text>
      );
    }
  } else {
    out.push(
      <Text color={scheme.toolResult} wrap="wrap">
        {'No commits'}
      </Text>
    );
  }
  return <>{out}</>;
}
