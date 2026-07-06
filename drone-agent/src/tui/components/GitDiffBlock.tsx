/**
 * Custom tool render component for git diff output in the tail region.
 *
 * Renders the diff with colored +/- indicators using Ink's `<Text color={...}>`,
 * fixing the soft-wrap color bug: each line group is wrapped in a single
 * `<Text color={...} wrap="wrap">` element so Ink applies the color to every
 * soft-wrapped continuation line.
 *
 * The component receives a ToolRenderState with scheme cast to DroneColorScheme.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function renderDiffLines(diff: string, scheme: DroneColorScheme): ReactNode[] {
  const lines = diff.split('\n');
  const elements: ReactNode[] = [];
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    let color: string | undefined;
    let prefix = ' ';

    if (line.startsWith('+')) {
      color = scheme.success;
      prefix = '+';
    } else if (line.startsWith('-')) {
      color = scheme.error;
      prefix = '-';
    } else if (line.startsWith('@@')) {
      color = scheme.info;
      prefix = ' ';
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      color = scheme.info;
      prefix = ' ';
    }

    if (color) {
      elements.push(
        <Text key={lineNum} color={color} wrap="wrap">
          {`${prefix}${line.slice(1)}`}
        </Text>
      );
    } else {
      elements.push(
        <Text key={lineNum} wrap="wrap">
          {line}
        </Text>
      );
    }
  }

  return elements;
}

export function GitDiffBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  // Parse the JSON result to extract the diff field
  let diffContent = result;
  const parsed = tryParseJson(result);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.diff && typeof obj.diff === 'string') {
      diffContent = obj.diff;
    } else if (
      obj.path !== undefined &&
      (obj.written === true || obj.patched === true)
    ) {
      return (
        <Text color={scheme.toolResult} wrap="wrap">
          {`✓ Applied diff to ${obj.path}`}
        </Text>
      );
    }
  }

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} git diff...
      </Text>
    );
  }

  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ ${state.name}: ${result}`}
      </Text>
    );
  }

  const elements = renderDiffLines(diffContent, scheme);
  return <>{elements}</>;
}
