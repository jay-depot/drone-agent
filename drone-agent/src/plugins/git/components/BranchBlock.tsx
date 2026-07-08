import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading } from './list.js';

type BranchResult = {
  action: string;
  name?: string;
  message?: string;
  current?: string;
  branches?: string[];
};

export function BranchBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git branch...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git branch: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as BranchResult | undefined;
  const action = parsed?.action ?? 'list';
  const name = parsed?.name ?? '';
  const out: ReactNode[] = [
    renderHeading(`## git branch ${action} ${name}`.trim(), scheme),
  ];

  if (action === 'list' && parsed?.branches?.length) {
    for (const b of parsed.branches) {
      const isCurrent = b === parsed.current;
      out.push(
        <Text
          key={b}
          color={isCurrent ? scheme.success : scheme.info}
          wrap="wrap"
        >
          {`  ${isCurrent ? '* ' : '  '}${b}`}
        </Text>
      );
    }
  } else if (parsed?.message) {
    out.push(
      <Text color={scheme.toolResult} wrap="wrap">
        {parsed.message}
      </Text>
    );
  }
  return <>{out}</>;
}
