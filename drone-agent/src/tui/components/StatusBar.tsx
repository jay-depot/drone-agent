/**
 * Bottom-of-screen status bar.
 *
 * Left side: model, plugin count, tool count, context usage, persona.
 * Right side: current working directory (with $HOME shortened to `~`).
 *
 * Ink's `<Box>` doesn't accept `backgroundColor` in 5.x — only
 * `<Text>` does. So we set the background on the inner `<Text>` and
 * rely on the text spanning the full row width via a `<Spacer />`
 * in between.
 *
 * If the row overflows, yoga truncates from the right, which means
 * the cwd is the part that gets clipped first — same priority order
 * as the blessed version.
 */

import { Box, Spacer, Text } from 'ink';
import type { DroneColorScheme } from '../theme.js';

export function StatusBar({
  left,
  cwd,
  scheme,
}: {
  left: string;
  cwd: string;
  scheme: DroneColorScheme;
}): JSX.Element {
  return (
    <Box flexDirection="row" width="100%">
      <Text backgroundColor={scheme.statusBg} color={scheme.statusFg}>
        {left}
      </Text>
      <Spacer />
      <Text backgroundColor={scheme.statusBg} color={scheme.statusFg}>
        {cwd}
      </Text>
    </Box>
  );
}
