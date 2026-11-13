/**
 * Domain types for the `drone-swarm-project` board.
 *
 * A **project** is a namespace that owns ordered **columns** and a collection
 * of **cards**. Moving a card between columns can match an **automation**, which
 * enqueues a **job** that starts an agent session.
 */

/** An ordered column within a project. */
export interface Column {
  id: string;
  name: string;
  order: number;
  isTerminal?: boolean;
}

/** One entry in a card's movement history. */
export interface MoveRecord {
  at: number;
  actor: 'user' | 'agent' | 'automation';
  fromColumnId: string | null;
  toColumnId: string;
}

/** A unit of work on the board. */
export interface Card {
  id: string;
  title: string;
  description?: string;
  columnId: string;
  position: number;
  /** Bounded to the last 50 moves. */
  history: MoveRecord[];
  sessionId?: string;
  spawnId?: string;
  sessionStatus?: 'running' | 'ended' | 'failed';
}

/** The action an automation performs when its transition matches. */
export interface AutomationThen {
  action: 'launch-session';
  personaId: string;
  model?: string;
  promptTemplate: string;
}

/**
 * A per-project rule that starts a session on a column transition.
 * `when.from`/`when.to` are column ids or `*`; `*` is allowed on one side only.
 */
export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  when: { from: string; to: string };
  then: AutomationThen;
}

/** A namespace owning columns, cards, and automations. */
export interface Project {
  id: string;
  name: string;
  /**
   * Inherited by every automation in this project. A per-automation override is
   * reserved for a later version.
   */
  defaultBeaconId?: string;
  /** Inherited by every automation in this project (see `defaultBeaconId`). */
  defaultWorkingDir?: string;
  columns: Column[];
  cards: Card[];
  automations: Automation[];
}

/** Lifecycle state of a queued spawn job. */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** A queued or started spawn. */
export interface Job {
  id: string;
  projectId: string;
  cardId: string;
  ruleId: string;
  /** Rendered at enqueue time. */
  prompt: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  spawnId?: string;
  agentId?: string;
  sessionId?: string;
  instructionSent?: boolean;
  error?: string;
}

/** Node-wide speed limits. */
export interface Limits {
  maxConcurrentSessions: number;
  maxDailySessions: number;
}
