import type {
  Automation,
  Card,
  Column,
  MoveRecord,
  Project,
} from '../board-types.js';

/**
 * Board persistence contract. All board reads and writes go through this
 * interface so a future SQLite implementation can replace the JSON one without
 * touching the automations, scheduler, or handler code.
 */
export interface BoardStore {
  listProjects(): Promise<
    Array<{ id: string; name: string; cardCount: number }>
  >;
  getProject(id: string): Promise<Project | undefined>;
  createProject(input: {
    name: string;
    defaultBeaconId?: string;
    defaultWorkingDir?: string;
  }): Promise<Project>;
  updateProject(
    id: string,
    patch: Partial<
      Pick<Project, 'name' | 'defaultBeaconId' | 'defaultWorkingDir'>
    >
  ): Promise<Project | undefined>;
  deleteProject(id: string): Promise<boolean>;
  getCard(
    cardId: string
  ): Promise<{ project: Project; card: Card } | undefined>;
  createCard(input: {
    projectId: string;
    title: string;
    description?: string;
    columnId?: string;
    actor: MoveRecord['actor'];
  }): Promise<Card | undefined>;
  updateCard(input: {
    projectId: string;
    cardId: string;
    title?: string;
    description?: string;
  }): Promise<Card | undefined>;
  moveCard(input: {
    projectId: string;
    cardId: string;
    toColumnId: string;
    position?: number;
    actor: MoveRecord['actor'];
  }): Promise<{ card: Card; fromColumnId: string | null } | undefined>;
  addColumn(input: {
    projectId: string;
    name: string;
  }): Promise<Column | undefined>;
  updateColumn(input: {
    projectId: string;
    columnId: string;
    name?: string;
    order?: number;
  }): Promise<Column | undefined>;
  deleteColumn(input: {
    projectId: string;
    columnId: string;
  }): Promise<boolean>;
  listAutomations(projectId: string): Promise<Automation[]>;
  createAutomation(input: {
    projectId: string;
    automation: Omit<Automation, 'id'>;
  }): Promise<Automation | undefined>;
  updateAutomation(input: {
    projectId: string;
    automationId: string;
    patch: Partial<Omit<Automation, 'id'>>;
  }): Promise<Automation | undefined>;
  deleteAutomation(input: {
    projectId: string;
    automationId: string;
  }): Promise<boolean>;
  setCardSession(input: {
    projectId: string;
    cardId: string;
    sessionId?: string;
    spawnId?: string;
    sessionStatus?: Card['sessionStatus'];
  }): Promise<Card | undefined>;
  /** Synchronous lookup over the in-memory card-to-project map. */
  getCardProjectId(cardId: string): string | undefined;
  /** Synchronous lookup over the in-memory session-to-card map. */
  getCardIdForSession(sessionId: string): string | undefined;
}
