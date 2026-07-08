import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import { GitDiffBlock } from '../../../tui/components/GitDiffBlock.js';
import { renderHeading } from './list.js';

type ShowResult = {
  ref: string;
  path?: string;
  contentsOnly?: boolean;
  diff?: string;
  contents?: string;
  error?: string;
};

export function ShowBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git show...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ git show: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as ShowResult | undefined;
  if (!parsed) {
    return <>{GitDiffBlock({ state })}</>;
  }

  // Contents view (contentsOnly:true + path).
  if (
    parsed.contentsOnly &&
    parsed.path &&
    typeof parsed.contents === 'string'
  ) {
    const out: ReactNode[] = [
      renderHeading(`## git show ${parsed.ref}:${parsed.path}`, scheme),
    ];
    const lines = parsed.contents.split('\n');
    for (const line of lines) {
      out.push(
        <Text key={line} wrap="wrap">
          {line}
        </Text>
      );
    }
    return <>{out}</>;
  }

  if (parsed.error) {
    return (
      <Text color={scheme.error} wrap="wrap">
        {parsed.error}
      </Text>
    );
  }

  // Diff view: delegate to GitDiffBlock for consistent coloring.
  return <>{GitDiffBlock({ state })}</>;
}
