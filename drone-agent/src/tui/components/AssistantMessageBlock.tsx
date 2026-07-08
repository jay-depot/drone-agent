/**
 * Live-updating assistant message block for the tail region and scrollback.
 *
 * Renders the assistant message as Markdown (via the shared Markdown
 * component) so formatting (headings, lists, code) is preserved both
 * while streaming and in the committed <Static> scrollback. The text is
 * wrapped in a single colored element for soft-wrap consistency.
 *
 * The block is padded above and below with a `---` separator rule so the
 * assistant's response is visually delimited from the surrounding log.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import { Markdown } from './Markdown.js';

/** Top/bottom padding rule for assistant responses. */
const ASSISTANT_SEPARATOR = '\n\n---\n\n';

export function AssistantMessageBlock({
  content,
  scheme,
}: {
  content: string;
  scheme: DroneColorScheme;
}): ReactNode {
  return (
    <>
      <Text>{ASSISTANT_SEPARATOR}</Text>
      <Markdown color={scheme.info}>{content}</Markdown>
      <Text>{ASSISTANT_SEPARATOR}</Text>
    </>
  );
}
