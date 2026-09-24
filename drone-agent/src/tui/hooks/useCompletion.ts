/**
 * Completion state for the TUI input line.
 *
 * Owns the "is the menu open / which candidates / which is selected" state and
 * recomputes candidates from the pure helpers in `completion.ts` whenever the
 * value or caret changes while open. The parent (App) drives it: Tab opens it,
 * Up/Down navigate, Enter accepts, Escape closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DroneReferenceContext,
  DroneSkillsCapability,
  DroneSlashCommand,
} from 'drone-core';
import {
  applyCompletion,
  detectCompletionContext,
  listFileCandidates,
  listSlashCandidates,
  listSkillCandidates,
  type CompletionItem,
} from '../completion.js';

/** Maximum rows the menu renders. */
export const MENU_LIMIT = 10;

export type CompletionAccept = {
  value: string;
  caret: number;
  reopen: boolean;
};

export function useCompletion(opts: {
  value: string;
  caret: number;
  engine: {
    getSlashCommands: () => DroneSlashCommand[];
    getCapability: <T>(pluginId: string) => T | undefined;
  };
  cwd: string;
  homedir: string;
}): {
  open: boolean;
  items: CompletionItem[];
  index: number;
  openAt: () => void;
  move: (delta: number) => void;
  accept: () => CompletionAccept | null;
  close: () => void;
} {
  const { value, caret, engine, cwd, homedir } = opts;

  const [requested, setRequested] = useState(false);
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [index, setIndex] = useState(0);
  const seqRef = useRef(0);

  const compute = useCallback(
    (v: string, c: number): Promise<CompletionItem[]> => {
      const ctx = detectCompletionContext(v, c);
      const refCtx: DroneReferenceContext = { cwd, homedir };
      if (ctx.kind === 'slash') {
        return Promise.resolve(listSlashCandidates(ctx.prefix, engine));
      }
      if (ctx.kind === 'skill') {
        const skills = engine.getCapability<DroneSkillsCapability>('skills');
        return Promise.resolve(listSkillCandidates(ctx.prefix, skills));
      }
      if (ctx.kind === 'file') {
        return listFileCandidates(ctx.prefix, refCtx);
      }
      return Promise.resolve([]);
    },
    [engine, cwd, homedir]
  );

  // Recompute while open, guarding against stale async results.
  useEffect(() => {
    if (!requested) {
      return;
    }
    const seq = ++seqRef.current;
    void compute(value, caret).then(result => {
      if (seq !== seqRef.current) {
        return;
      }
      setItems(result);
      setIndex(prev =>
        result.length === 0 ? 0 : Math.min(prev, result.length - 1)
      );
    });
  }, [requested, value, caret, compute]);

  const openAt = useCallback(() => {
    seqRef.current += 1;
    setIndex(0);
    setItems([]);
    setRequested(true);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setIndex(prev => {
        if (items.length === 0) return 0;
        const next = prev + delta;
        return Math.max(0, Math.min(items.length - 1, next));
      });
    },
    [items.length]
  );

  const accept = useCallback((): CompletionAccept | null => {
    if (items.length === 0) {
      return null;
    }
    const item = items[index] ?? items[0];
    const ctx = detectCompletionContext(value, caret);
    const result = applyCompletion(value, caret, ctx, item);
    const reopen = item.reopen === true;
    setRequested(reopen);
    if (!reopen) {
      seqRef.current += 1;
      setItems([]);
    } else {
      setIndex(0);
    }
    return { ...result, reopen };
  }, [items, index, value, caret]);

  const close = useCallback(() => {
    seqRef.current += 1;
    setRequested(false);
    setItems([]);
  }, []);

  // The menu is "open" only when it has something to show; an empty candidate
  // set leaves Enter free to submit.
  return {
    open: requested && items.length > 0,
    items,
    index,
    openAt,
    move,
    accept,
    close,
  };
}
