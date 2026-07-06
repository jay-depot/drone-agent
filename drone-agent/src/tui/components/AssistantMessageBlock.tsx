/**
 * Live-updating assistant message block for the tail region.
 *
 * Shows the assistant message as it streams in, wrapped in a plain
 * `<Text wrap="wrap">` element for proper wrapping behavior.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';

export function AssistantMessageBlock({
  content,
}: {
  content: string;
}): ReactNode {
  return <Text wrap="wrap">{content}</Text>;
}
