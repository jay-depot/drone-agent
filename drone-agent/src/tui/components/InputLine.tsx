/**
 * The bottom input line.
 *
 * Uses the custom `MultilineTextInput` component which supports
 * Shift+Enter for newlines and plain Enter for submit.
 */

import { Box, Text } from 'ink';
import { MultilineTextInput } from './MultilineTextInput.js';
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
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}
