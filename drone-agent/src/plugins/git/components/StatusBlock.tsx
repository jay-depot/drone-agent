import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { renderHeading } from './list.js';

type StatusResult = {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
};

export function StatusBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git status...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git status: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as StatusResult | undefined;
  if (!parsed || typeof parsed !== 'object') {
    return <Text wrap="wrap">{result}</Text>;
  }

  // Defensive: a malformed result could be missing these arrays.
  const staged = Array.isArray(parsed.staged) ? parsed.staged : [];
  const unstaged = Array.isArray(parsed.unstaged) ? parsed.unstaged : [];
  const untracked = Array.isArray(parsed.untracked) ? parsed.untracked : [];

  const out: ReactNode[] = [];
  out.push(renderHeading('## git status', scheme));
  if (parsed.branch) {
    out.push(
      <Text key="branch" dimColor wrap="wrap">
        {`On branch ${parsed.branch}`}
      </Text>
    );
  }
  if (staged.length > 0) {
    out.push(
      <Text key="staged-h" color={scheme.info} bold wrap="wrap">
        {'Staged:'}
      </Text>
    );
    for (const f of staged) {
      out.push(
        <Text key={`s-${f}`} color={scheme.info} wrap="wrap">
          {`  + ${f}`}
        </Text>
      );
    }
  }
  if (unstaged.length > 0) {
    out.push(
      <Text key="unstaged-h" color={scheme.warning} bold wrap="wrap">
        {'Unstaged:'}
      </Text>
    );
    for (const f of unstaged) {
      out.push(
        <Text key={`u-${f}`} color={scheme.warning} wrap="wrap">
          {`  ~ ${f}`}
        </Text>
      );
    }
  }
  if (untracked.length > 0) {
    out.push(
      <Text key="untracked-h" color={scheme.error} bold wrap="wrap">
        {'Untracked:'}
      </Text>
    );
    for (const f of untracked) {
      out.push(
        <Text key={`t-${f}`} color={scheme.error} wrap="wrap">
          {`  ? ${f}`}
        </Text>
      );
    }
  }
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    out.push(
      <Text color={scheme.success} wrap="wrap">
        {'Working tree clean'}
      </Text>
    );
  }
  return <>{out}</>;
}
