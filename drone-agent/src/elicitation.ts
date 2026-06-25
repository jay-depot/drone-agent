import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type {
  DroneElicitation,
  DroneElicitationAnswers,
  DroneElicitationQuestion,
} from 'drone-core';

/**
 * Creates a readline-based elicitation implementation for non-TUI modes.
 */
export function createReadlineElicitation(): DroneElicitation & {
  close: () => void;
} {
  const rl: Interface = createInterface({ input, output });

  return {
    close: () => rl.close(),
    ask: async (questions: DroneElicitationQuestion[]) => {
      // Validate questions
      for (const question of questions) {
        if (
          question.choices &&
          question.choices.length > 0 &&
          question.freeform
        ) {
          throw new Error(
            'Invalid question: cannot set both "choices" and "freeform: true".'
          );
        }
        if (
          (!question.choices || question.choices.length === 0) &&
          !question.freeform
        ) {
          throw new Error(
            'Invalid question: must set either "choices" or "freeform: true".'
          );
        }
      }

      const answers: DroneElicitationAnswers = {};

      for (const question of questions) {
        if (question.choices && question.choices.length > 0) {
          const lines = question.choices.map(
            (c, i) => `  ${i + 1}. ${c.label}`
          );
          const prompt = [
            question.prompt,
            ...lines,
            `Enter choice [1-${question.choices.length}]`,
            question.defaultValue ? ` (default: ${question.defaultValue})` : '',
            ': ',
          ].join('\n');

          const raw = await rl.question(prompt);
          const trimmed = raw.trim();
          if (trimmed.length === 0 && question.defaultValue) {
            answers[question.id] = question.defaultValue;
          } else {
            const idx = parseInt(trimmed, 10) - 1;
            if (!isNaN(idx) && idx >= 0 && idx < question.choices.length) {
              answers[question.id] = question.choices[idx].value;
            } else {
              answers[question.id] = question.defaultValue ?? '';
            }
          }
        } else if (question.freeform) {
          const label = question.inputLabel ?? '';
          const placeholder = question.placeholder ?? '';
          const prompt = `${question.prompt}${placeholder ? ` (${placeholder})` : ''}${label ? `\n${label}` : ''}: `;
          const raw = await rl.question(prompt);
          const trimmed = raw.trim();
          answers[question.id] =
            trimmed.length > 0 ? trimmed : (question.defaultValue ?? '');
        }
      }

      return answers;
    },
  };
}
