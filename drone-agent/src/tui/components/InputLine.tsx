/**
 * The bottom input line.
 *
 * Wraps `ink-text-input`. Submits the current value to the parent
 * (which clears its own value state). Esc on an empty input is the
 * global quit signal — that lives in App so it shares the useApp()
 * exit() instance; here we just expose a `value` / `onChange` /
 * `onSubmit` trio.
 */

import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { DroneColorScheme } from '../theme.js';

export function InputLine({
  value,
  onChange,
  onSubmit,
  scheme,
  promptLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  scheme: DroneColorScheme;
  /**
   * Optional prompt label, e.g. `drone> ` or `unix-beard> `. Rendered
   * before the input. Mirrors the readline-mode prompt label so the
   * two modes feel consistent.
   */
  promptLabel?: string;
}): JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={scheme.border}
      paddingX={1}
      flexDirection="row"
    >
      {promptLabel ? <Text color={scheme.userInput}>{promptLabel}</Text> : null}
      <Box flexGrow={1}>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}
