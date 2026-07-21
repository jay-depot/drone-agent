import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

export function ExecRunBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const command =
    typeof state.arguments.command === 'string' ? state.arguments.command : '';

  const indicator =
    state.status === 'running' ? '…' : state.status === 'error' ? '✗' : '✓';

  let exitCode: number | null = null;
  if (state.status === 'done' && state.result) {
    const parsed = tryParseJson(state.result);
    if (parsed && typeof parsed.exitCode === 'number') {
      exitCode = parsed.exitCode;
    }
  }

  const isNonZeroExit = exitCode !== null && exitCode !== 0;
  const headerColor =
    state.status === 'error' || isNonZeroExit ? scheme.error : scheme.info;

  const headerLine = isNonZeroExit
    ? `${indicator} exec__run $ ${command}  (exit ${exitCode})`
    : `${indicator} exec__run $ ${command}`;

  const outputLines = state.outputLines ?? [];

  return (
    <>
      <Text color={headerColor} wrap="wrap">
        {headerLine}
      </Text>
      {outputLines.length > 0 && (
        <Text wrap="wrap">{outputLines.join('')}</Text>
      )}
      <Text>{'\n'}</Text>
    </>
  );
}
