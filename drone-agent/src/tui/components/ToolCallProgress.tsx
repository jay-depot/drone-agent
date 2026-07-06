/**
 * Live-updating tool call component for the tail region.
 *
 * Shows the tool name, arguments, and a status indicator while executing.
 * When the result arrives, shows the result preview.
 *
 * The entire block is wrapped in a single `<Text color={...} wrap="wrap">`
 * element, fixing the soft-wrap color bug: Ink applies the color to every
 * wrapped continuation line, not just the first line.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';

/** Maximum chars rendered in a tool argument or result preview. */
const PREVIEW_MAX = 200;

function preview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function ToolCallProgress({
  name,
  args,
  result,
  status,
  scheme,
}: {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
  scheme: DroneColorScheme;
}): ReactNode {
  const color =
    status === 'error'
      ? scheme.error
      : status === 'done'
        ? scheme.toolResult
        : scheme.toolCall;

  const indicator = status === 'running' ? '…' : status === 'error' ? '✗' : '✓';
  const argsPreview = preview(JSON.stringify(args), PREVIEW_MAX);

  const text = `${indicator} ${name}(${argsPreview})`;
  const resultText = result ? `\n${preview(result, 500)}` : '';

  return (
    <Text color={color} wrap="wrap">
      {text}
      {resultText}
    </Text>
  );
}
