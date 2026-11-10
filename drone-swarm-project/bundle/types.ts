/** Minimal board types the bundle reads over the action API. */

export interface Column {
  id: string;
  name: string;
  order: number;
}

export interface MoveRecord {
  at: number;
  actor: 'user' | 'agent' | 'automation';
  fromColumnId: string | null;
  toColumnId: string;
}

export interface Card {
  id: string;
  title: string;
  description?: string;
  columnId: string;
  position: number;
  history?: MoveRecord[];
  sessionId?: string;
  sessionStatus?: 'running' | 'ended' | 'failed';
}

export interface Project {
  id: string;
  name: string;
  columns: Column[];
  cards: Card[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  cardCount: number;
}

export interface Job {
  id: string;
  projectId: string;
  cardId: string;
  state: string;
  prompt: string;
  createdAt: number;
  error?: string;
}

export interface Limits {
  maxConcurrentSessions: number;
  maxDailySessions: number;
}

export interface ActionReply<T> {
  ok: boolean;
  status?: number;
  body?: T;
}
