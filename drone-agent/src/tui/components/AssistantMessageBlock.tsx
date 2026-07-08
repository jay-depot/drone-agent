/**
 * Live-updating assistant message block for the tail region and scrollback.
 *
 * Renders the assistant message as Markdown (via the shared Markdown
 * component) so formatting (headings, lists, code) is preserved both
 * while streaming and in the committed <Static> scrollback. The text is
 * wrapped in a single colored element for soft-wrap consistency.
 */

import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import { Markdown } from './Markdown.js';

export function AssistantMessageBlock({
  content,
  scheme,
}: {
  content: string;
  scheme: DroneColorScheme;
}): ReactNode {
  return <Markdown color={scheme.info}>{content}</Markdown>;
}
