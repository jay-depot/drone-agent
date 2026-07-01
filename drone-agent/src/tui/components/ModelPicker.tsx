import type React from 'react';
/**
 * Hand-rolled first-run model picker.
 *
 * Renders an arrow-key-driven list of available Ollama models. Reaches
 * the previously selected model on Enter. The parent receives the
 * selection via `onSelect(model)`. The picker is mounted *outside* the
 * chat TUI: `src/index.ts` renders it via `render(...).waitUntilExit()`
 * before mounting the chat.
 *
 * We hand-roll rather than pull in `ink-select-input` to keep the dep
 * list minimal. The picker is ~50 lines; no need for a third-party
 * abstraction over it.
 */

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

export function ModelPicker({
  models,
  current,
  onSelect,
  headerText = 'No user config found — pick a default Ollama model.',
}: {
  models: string[];
  /** Currently active model (highlighted in the list). */
  current?: string;
  /** Called with the chosen model id, or with the existing first item if the user just presses Enter. */
  onSelect: (model: string) => void;
  headerText?: string;
}): React.JSX.Element {
  const initialIndex =
    current !== undefined ? Math.max(0, models.indexOf(current)) : 0;
  const [highlight, setHighlight] = useState<number>(initialIndex);

  useInput((input, key) => {
    if (key.upArrow) {
      setHighlight(prev => (prev - 1 + models.length) % models.length);
      return;
    }
    if (key.downArrow) {
      setHighlight(prev => (prev + 1) % models.length);
      return;
    }
    if (key.return) {
      const chosen = models[highlight] ?? models[0];
      onSelect(chosen);
      return;
    }
    if (input.length > 0) {
      // Number-key shortcut: 1..9 jumps to that index.
      const num = Number.parseInt(input, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= models.length) {
        setHighlight(num - 1);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text>{headerText}</Text>
      <Text> </Text>
      <Text>Available models:</Text>
      {models.map((model, index) => {
        const isHighlighted = index === highlight;
        const isCurrent = model === current;
        const cursor = isHighlighted ? '> ' : '  ';
        const tag = isCurrent ? ' (current)' : '';
        return (
          <Text key={model}>{`${cursor}[${index + 1}] ${model}${tag}`}</Text>
        );
      })}
      <Text> </Text>
      <Text>
        Use ↑/↓ to choose, Enter to confirm, or type a number 1–{models.length}.
      </Text>
    </Box>
  );
}
