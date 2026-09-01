/**
 * Hook for managing elicitation state.
 *
 * When a workflow / plugin asks the user a question, this hook manages
 * the active question UI state and the promise that resolves when the
 * user commits an answer. It wires the engine's `setElicitation`
 * capability on mount.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { DroneElicitationQuestion } from 'drone-core';
import type { DronePluginEngine } from '../../runtime/plugin-engine.js';
import { createTuiElicitation } from '../elicitation.js';

/**
 * Initial picker highlight for a question: the choice matching
 * `defaultValue`, or 0 when there is no match (or the question is
 * freeform — no picker at all).
 *
 * The default and the initial highlight must AGREE: mutation confirms
 * use a safety default of 'no', and plain-output mode treats an empty
 * Enter as the default ("decline"). If the TUI picker highlighted
 * index 0 ('yes') instead, reflex-Enter in the TUI would silently
 * ACCEPT — the mirror-image of the plain-mode trap that made the
 * swarm-memory bootstrap's cron confirm look like a yes.
 */
export function initialPickerIndex(
  question: DroneElicitationQuestion | null
): number {
  if (!question || question.freeform) {
    return 0;
  }
  const choices = question.choices ?? [];
  const defaultIdx = choices.findIndex(
    choice => choice.value === question.defaultValue
  );
  return defaultIdx >= 0 ? defaultIdx : 0;
}

export function useElicitation(
  engine: Pick<DronePluginEngine, 'setElicitation'>
): {
  activeQuestion: (DroneElicitationQuestion & { uiKey: string }) | null;
  pickerIndex: number;
  setPickerIndex: Dispatch<SetStateAction<number>>;
  commitAnswer: (answer: string) => void;
  cancelQuestion: () => void;
} {
  const [activeQuestion, setActiveQuestion] = useState<
    (DroneElicitationQuestion & { uiKey: string }) | null
  >(null);
  const [pickerIndex, setPickerIndex] = useState<number>(0);
  const questionResolveRef = useRef<((value: string) => void) | null>(null);
  const questionRejectRef = useRef<((reason: Error) => void) | null>(null);

  // Wire the elicitation capability exactly once on mount.
  useEffect(() => {
    if (!engine.setElicitation) return;
    const askQuestion = (
      question: DroneElicitationQuestion
    ): Promise<string> => {
      // If a question is already active, reject the previous one to
      // avoid hangs.
      if (questionResolveRef.current) {
        const prev = questionRejectRef.current;
        questionResolveRef.current = null;
        questionRejectRef.current = null;
        if (prev) prev(new Error('Superseded by a new elicitation question.'));
      }
      const uiKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPickerIndex(initialPickerIndex(question));
      setActiveQuestion({ ...question, uiKey });
      return new Promise<string>((resolve, reject) => {
        questionResolveRef.current = resolve;
        questionRejectRef.current = reject;
      });
    };
    engine.setElicitation(createTuiElicitation({ askQuestion }));
    return () => {
      // Reject any in-flight question on unmount.
      if (questionResolveRef.current) {
        const reject = questionRejectRef.current;
        questionResolveRef.current = null;
        questionRejectRef.current = null;
        if (reject)
          reject(new Error('TUI unmounted before question was answered.'));
      }
      engine.setElicitation?.(undefined);
    };
  }, [engine]);

  const commitAnswer = useCallback((answer: string) => {
    const resolve = questionResolveRef.current;
    questionResolveRef.current = null;
    questionRejectRef.current = null;
    setActiveQuestion(null);
    setPickerIndex(0);
    if (resolve) resolve(answer);
  }, []);

  const cancelQuestion = useCallback(() => {
    const reject = questionRejectRef.current;
    questionResolveRef.current = null;
    questionRejectRef.current = null;
    setActiveQuestion(null);
    setPickerIndex(0);
    if (reject) reject(new Error('Elicitation cancelled.'));
  }, []);

  return {
    activeQuestion,
    pickerIndex,
    setPickerIndex,
    commitAnswer,
    cancelQuestion,
  };
}
