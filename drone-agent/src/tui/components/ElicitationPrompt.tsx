/**
 * Inline UI for an active elicitation question.
 *
 * Closed-set questions show a numbered list with the current picker
 * index highlighted; freeform questions reuse a minimal text input
 * that commits on Enter.
 */

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { DroneElicitationQuestion } from 'drone-core';
import { ColorTag, type DroneColorScheme } from '../theme.js';

export function ElicitationPrompt({
  question,
  pickerIndex,
  scheme,
  onSubmit,
}: {
  question: DroneElicitationQuestion & { uiKey: string };
  pickerIndex: number;
  scheme: DroneColorScheme;
  onSubmit: (answer: string) => void;
}): JSX.Element {
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
}: {
  inputLabel: string;
  placeholder?: string;
  defaultValue?: string;
  onSubmit: (answer: string) => void;
  scheme: DroneColorScheme;
}): JSX.Element {
  const [value, setValue] = useState<string>(defaultValue ?? '');
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={scheme.userInput}>{inputLabel} </Text>
        <FreeformInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      {placeholder ? <Text dimColor>{`(e.g. ${placeholder})`}</Text> : null}
      <Text dimColor>Enter to submit, Esc to cancel</Text>
    </Box>
  );
}

/**
 * Minimal inline text input that doesn't conflict with the main
 * chat input. We can't use ink-text-input here because the main
 * InputLine already owns the global focus for the chat composer;
 * nesting two TextInputs is unreliable. Instead we listen for the
 * 'input' keystroke via the parent's useInput and append to a
 * local string. Enter commits, Esc cancels.
 *
 * To avoid stepping on the parent's useInput, the parent only
 * intercepts arrow/return/esc while a freeform question is active,
 * letting printable characters fall through to this component via
 * a separate useInput mounted here.
 */
function FreeformInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (answer: string) => void;
}): JSX.Element {
  useInput((inputChar, key) => {
    // Enter alone → submit
    if (key.return && !key.shift) {
      if (value.trim().length === 0) return; // ignore empty submit
      onSubmit(value.trim());
      return;
    }
    // Ctrl+J (inputChar === '\n' with !key.return) → insert newline at end
    if (inputChar === '\n' && !key.return) {
      onChange(value + '\n');
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl && inputChar === 'u') {
      onChange('');
      return;
    }
    // Filter out control characters that would render as garbage.
    if (inputChar && !key.ctrl && !key.meta && inputChar.length > 0) {
      onChange(value + inputChar);
    }
  });
  return <Text>{value.length > 0 ? value : ' '}</Text>;
}
