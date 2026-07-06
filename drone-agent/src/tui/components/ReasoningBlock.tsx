/**
 * Live-updating reasoning block for the tail region.
 *
 * Shows reasoning text as it streams in, wrapped in a single
 * `<Text color={...} wrap="wrap">` element for proper color
 * rendering across soft-wrapped lines.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';

export function ReasoningBlock({
  content,
  scheme,
}: {
  content: string;
  scheme: DroneColorScheme;
}): ReactNode {
  return (
    <Text color={scheme.reasoning} wrap="wrap">
      {`💭 ${content}`}
    </Text>
  );
}
