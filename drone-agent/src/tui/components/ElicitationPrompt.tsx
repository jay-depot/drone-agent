import type React from 'react';
/**
 * Inline UI for an active elicitation question.
 *
 * Closed-set questions show a numbered list with the current picker
 * index highlighted; freeform questions use the enhanced
 * `MultilineTextInput` component with full cursor navigation.
 */

import { Box, Text } from 'ink';
import { useState } from 'react';
import type { DroneElicitationQuestion } from 'drone-core';
import { ColorTag, type DroneColorScheme } from '../theme.js';
import { MultilineTextInput } from './MultilineTextInput.js';
import type { SgrMouseEvent } from '../hooks/useSgrMouse.js';

export function ElicitationPrompt({
  question,
  pickerIndex,
  scheme,
  onSubmit,
  columns,
  mouseClick,
}: {
  question: DroneElicitationQuestion & { uiKey: string };
  pickerIndex: number;
  scheme: DroneColorScheme;
  onSubmit: (answer: string) => void;
  /** Terminal width for visual line calculation. */
  columns: number;
  /** Most recent SGR mouse click event (for click-to-position). */
  mouseClick?: SgrMouseEvent | null;
}): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={scheme.border}
      flexDirection="column"
      paddingX={1}
    >
      <Text>
        <ColorTag color={scheme.primary}>{question.prompt}</ColorTag>
      </Text>
      {question.freeform ? (
        <FreeformPrompt
          inputLabel={question.inputLabel ?? question.prompt}
          placeholder={question.placeholder}
          defaultValue={question.defaultValue}
          onSubmit={onSubmit}
          scheme={scheme}
          columns={columns}
          mouseClick={mouseClick}
        />
      ) : (
        <Box flexDirection="column">
          {(question.choices ?? []).map((choice, idx) => {
            const marker = idx === pickerIndex ? '▶' : ' ';
            const def =
              question.defaultValue === choice.value ? ' (default)' : '';
            return (
              <Text key={choice.value}>
                <ColorTag
                  color={scheme.userInput}
                >{`  ${marker} ${idx + 1}. ${choice.label}${def}`}</ColorTag>
              </Text>
            );
          })}
          <Text dimColor>
            ↑/↓ to move, Enter to confirm, 1-9 to jump, Esc to cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}

function FreeformPrompt({
  inputLabel,
  placeholder,
  defaultValue,
  onSubmit,
  scheme,
  columns,
  mouseClick,
}: {
  inputLabel: string;
  placeholder?: string;
  defaultValue?: string;
  onSubmit: (answer: string) => void;
  scheme: DroneColorScheme;
  columns: number;
  mouseClick?: SgrMouseEvent | null;
}): React.JSX.Element {
  const [value, setValue] = useState<string>(defaultValue ?? '');
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={scheme.userInput}>{inputLabel} </Text>
        <Box flexGrow={1}>
          <MultilineTextInput
            value={value}
            onChange={setValue}
            onSubmit={(v: string) => {
              if (v.trim().length === 0) return;
              onSubmit(v.trim());
            }}
            columns={columns}
            mouseClick={mouseClick}
            focus={true}
          />
        </Box>
      </Box>
      {placeholder ? <Text dimColor>{`(e.g. ${placeholder})`}</Text> : null}
      <Text dimColor>Enter to submit, Esc to cancel</Text>
    </Box>
  );
}
