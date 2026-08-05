import type React from 'react';
/**
 * The bottom input line.
 *
 * Uses the custom `MultilineTextInput` component which supports
 * Shift+Enter for newlines and plain Enter for submit.
 *
 * Renders an optional LLM working indicator (a trigram character)
 * to the left of the prompt label.
 *
 * The effective text width passed to MultilineTextInput is the
 * terminal width minus:
 *   - 2 for the border (left + right border chars)
 *   - 2 for paddingX={1} (left + right padding)
 *   - the LLM indicator width (if present)
 *   - the prompt label width (if present)
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
  disabled,
  columns,
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
  /**
   * When true, the input is disabled and won't process keystrokes.
   * Used when an elicitation question is active.
   */
  disabled?: boolean;
  /** Terminal width for visual line calculation. */
  columns: number;
}): React.JSX.Element {
  const textWidth =
    columns -
    4 -
    (llmFrame ? 2 : 0) -
    (promptLabel ? promptLabel.length : 0);

  return (
    <Box
      borderStyle="single"
      borderColor={scheme.border}
      paddingX={1}
      flexDirection="row"
      flexGrow={0}
    >
      <Box flexGrow={0}>
        {llmFrame ? <Text color={llmColor}>{llmFrame} </Text> : null}
      </Box>
      <Box flexGrow={0}>
        {promptLabel ? (
          <Text color={scheme.userInput}>{promptLabel}</Text>
        ) : null}
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          columns={textWidth}
          focus={!disabled}
        />
      </Box>
    </Box>
  );
}
