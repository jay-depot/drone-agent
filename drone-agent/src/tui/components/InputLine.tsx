/**
 * The bottom input line.
 *
 * Uses the custom `MultilineTextInput` component which supports
 * Shift+Enter for newlines and plain Enter for submit.
 *
 * Renders an optional LLM working indicator (a trigram character)
 * to the left of the prompt label.
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
  llmFrame,
  llmColor,
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
  /**
   * Current frame of the LLM working animation. When undefined, no
   * indicator is rendered.
   */
  llmFrame?: string;
  /**
   * Color for the LLM working indicator. When the LLM is idle this
   * should be a dim color (e.g. 'gray'); when active it should match
   * the current border/accent color.
   */
  llmColor?: string;
}): JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={scheme.border}
      paddingX={1}
      flexDirection="row"
    >
      {llmFrame ? <Text color={llmColor}>{llmFrame} </Text> : null}
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
