import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

/**
 * One-line render for `file__read_image` results. The base64 image data lives
 * in the structured `images[]` channel, never in the content string, so this
 * only surfaces the path / mime type / size metadata.
 */
export function FileReadImageBlock({
  state,
}: {
  state: ToolRenderState;
}): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const path =
      typeof state.arguments.path === 'string' ? state.arguments.path : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… file__read_image ${path}`}
      </Text>
    );
  }

  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ ${state.name}: ${state.result ?? ''}`}
      </Text>
    );
  }

  const result = state.result ?? '';
  const parsed = tryParseJson(result);
  const path = parsed && typeof parsed.path === 'string' ? parsed.path : '';
  const mimeType =
    parsed && typeof parsed.mimeType === 'string' ? parsed.mimeType : '';
  const size = parsed && typeof parsed.size === 'number' ? parsed.size : 0;

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ file__read_image ${path} (${mimeType}, ${size} bytes) [Image attached]`}
    </Text>
  );
}
