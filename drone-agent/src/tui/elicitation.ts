/**
 * TUI-side implementation of the `DroneElicitation` capability.
 *
 * The wizard asks questions one at a time. For each question the App
 * renders a focused sub-prompt inside the chat log: a numbered/arrow-key
 * picker for closed-set questions, or a plain text input for freeform.
 *
 * Because React owns the render loop, the elicitation closure can't
 * just `await userInput()` directly. Instead it asks the App to mount
 * a question component by calling one of the host callbacks. The host
 * resolves the promise when the user picks an option / submits text.
 *
 * `createTuiElicitation` is called by App on mount, wires the host
 * callbacks, and returns a `DroneElicitation` closure that
 * plugins/workflows can call. The host is also responsible for any
 * visual cleanup after each question (the question entries become
 * static chat log lines once they're committed).
 */

import type {
  DroneElicitation,
  DroneElicitationAnswers,
  DroneElicitationQuestion,
} from 'drone-core';

/**
 * Callback the host provides to render a question and resolve its
 * answer. Implementations live in App.tsx and use React state to
 * drive the picker / input UI.
 */
export type AskQuestionHandler = (
  question: DroneElicitationQuestion
) => Promise<string>;

export type TuiElicitationHost = {
  askQuestion: AskQuestionHandler;
};

/**
 * Validate a question before asking. Mirrors the readline host's
 * behavior so plugins get the same error semantics in both modes.
 */
function validateQuestion(question: DroneElicitationQuestion): void {
  const hasChoices =
    Array.isArray(question.choices) && question.choices.length > 0;
  if (hasChoices && question.freeform) {
    throw new Error(
      `Elicitation question "${question.id}" cannot set both "choices" and "freeform: true".`
    );
  }
  if (!hasChoices && !question.freeform) {
    throw new Error(
      `Elicitation question "${question.id}" must set either "choices" or "freeform: true".`
    );
  }
}

export function createTuiElicitation(
  host: TuiElicitationHost
): DroneElicitation {
  return {
    ask: async (questions): Promise<DroneElicitationAnswers> => {
      const answers: DroneElicitationAnswers = {};
      for (const question of questions) {
        validateQuestion(question);
        answers[question.id] = await host.askQuestion(question);
      }
      return answers;
    },
  };
}
