/**
 * Hook for the LLM working indicator animation.
 *
 * Cycles through a set of animation frames while the LLM is active.
 * Resets to the idle frame (index 0) when the LLM becomes idle.
 *
 * The caller computes `llmColor` from the active scheme:
 *   `isLlmActive ? scheme.border : 'gray'`
 */

import { useEffect, useState } from 'react';

const LLM_WORKING_FRAMES = ['○', '◔', '◑', '◕', '●'];

export function useLlmIndicator(): {
  isLlmActive: boolean;
  llmFrame: string;
  setIsLlmActive: (active: boolean) => void;
} {
  const [isLlmActive, setIsLlmActive] = useState<boolean>(false);
  const [llmFrameIndex, setLlmFrameIndex] = useState<number>(0);

  // LLM working indicator: cycle through animation frames while active.
  // When the LLM becomes idle, reset the frame index to 0 (the idle frame).
  useEffect(() => {
    if (!isLlmActive) {
      setLlmFrameIndex(0);
      return;
    }
    const id = setInterval(() => {
      setLlmFrameIndex(prev => (prev + 1) % LLM_WORKING_FRAMES.length);
    }, 250);
    return () => clearInterval(id);
  }, [isLlmActive]);

  const llmFrame = LLM_WORKING_FRAMES[llmFrameIndex];

  return { isLlmActive, llmFrame, setIsLlmActive };
}
