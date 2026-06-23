/**
 * Hook for managing chat log entries.
 *
 * Maintains a list of committed log entries with a monotonic id counter.
 * Provides `appendEntry` for structured entries and `log` as a shorthand
 * for plain text entries.
 */

import { useCallback, useRef, useState } from 'react';
import type { ChatEntry } from '../types.js';

export function useChatLog(): {
  entries: ChatEntry[];
  appendEntry: (entry: Omit<ChatEntry, 'id'>) => void;
  log: (text: string, kind?: ChatEntry['kind']) => void;
} {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const entryIdCounter = useRef<number>(0);

  const appendEntry = useCallback(
    (entry: Omit<ChatEntry, 'id'>) => {
      entryIdCounter.current += 1;
      const id = `e${Date.now()}-${entryIdCounter.current}`;
      setEntries(prev => [...prev, { ...entry, id }]);
    },
    [entryIdCounter]
  );

  const log = useCallback(
    (text: string, kind: ChatEntry['kind'] = 'plain') => {
      appendEntry({ text, kind });
    },
    [appendEntry]
  );

  return { entries, appendEntry, log };
}
