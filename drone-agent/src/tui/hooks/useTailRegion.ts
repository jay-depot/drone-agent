/**
 * Hook for managing the tail region — a set of live-updating items
 * that get committed to <Static> when they complete.
 *
 * Provides:
 * - `items`: the current set of live TailItems (for rendering in the tail)
 * - `addItem(item)`: add a new tail item, returns its id
 * - `updateItem(id, component, toEntry)`: update an existing item's live component
 * - `commitItem(id)`: remove from tail and return an Omit<ChatEntry, 'id'> for the caller
 * - `commitAll()`: commit all items and return entries
 * - `clear()`: remove all items without committing (for error recovery)
 * - `getItem(id)`: peek at an item's current state
 *
 * Each item has a stable id that serves as its React key. When committed,
 * the item is removed from the tail and its `toEntry()` is called to produce
 * the chat entry data (without id — the caller assigns the id via log/appendEntry).
 */

import { useCallback, useRef, useState } from 'react';
import type { ChatEntry, TailItem } from '../types.js';

export function useTailRegion(): {
  items: TailItem[];
  addItem: (
    kind: TailItem['kind'],
    component: React.ReactNode,
    toEntry: () => Omit<ChatEntry, 'id'>
  ) => string;
  updateItem: (
    id: string,
    component: React.ReactNode,
    toEntry: () => Omit<ChatEntry, 'id'>
  ) => void;
  commitItem: (id: string) => Omit<ChatEntry, 'id'>;
  commitAll: () => Omit<ChatEntry, 'id'>[];
  clear: () => void;
  getItem: (id: string) => TailItem | undefined;
} {
  const [items, setItems] = useState<TailItem[]>([]);
  const idCounter = useRef<number>(0);
  const itemsRef = useRef<Map<string, TailItem>>(new Map());

  const addItem = useCallback(
    (
      kind: TailItem['kind'],
      component: React.ReactNode,
      toEntry: () => Omit<ChatEntry, 'id'>
    ): string => {
      idCounter.current += 1;
      const id = `tail-${Date.now()}-${idCounter.current}`;
      const item: TailItem = { id, kind, component, toEntry };
      itemsRef.current.set(id, item);
      setItems(prev => [...prev, item]);
      return id;
    },
    []
  );

  const updateItem = useCallback(
    (
      id: string,
      component: React.ReactNode,
      toEntry: () => Omit<ChatEntry, 'id'>
    ): void => {
      const existing = itemsRef.current.get(id);
      if (!existing) return;
      const updated: TailItem = { ...existing, component, toEntry };
      itemsRef.current.set(id, updated);
      setItems(prev => prev.map(item => (item.id === id ? updated : item)));
    },
    []
  );

  const commitItem = useCallback((id: string): Omit<ChatEntry, 'id'> => {
    const item = itemsRef.current.get(id);
    if (!item) {
      throw new Error(`Cannot commit unknown tail item: ${id}`);
    }
    const entry = item.toEntry();
    itemsRef.current.delete(id);
    setItems(prev => prev.filter(i => i.id !== id));
    return entry;
  }, []);

  const commitAll = useCallback((): Omit<ChatEntry, 'id'>[] => {
    const entries: Omit<ChatEntry, 'id'>[] = [];
    for (const [id] of itemsRef.current) {
      try {
        entries.push(commitItem(id));
      } catch {
        // Item may have been already committed; skip
      }
    }
    return entries;
  }, [commitItem]);

  const clear = useCallback((): void => {
    itemsRef.current.clear();
    setItems([]);
  }, []);

  const getItem = useCallback((id: string): TailItem | undefined => {
    return itemsRef.current.get(id);
  }, []);

  return { items, addItem, updateItem, commitItem, commitAll, clear, getItem };
}
