import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withPathLock } from 'drone-swarm-common';
import type {
  Automation,
  Card,
  Column,
  Job,
  Limits,
  MoveRecord,
  Project,
} from '../board-types.js';
import {
  newAutomationId,
  newCardId,
  newColumnId,
  newProjectId,
} from '../ids.js';
import type { BoardStore } from './board-store.js';
import type { SchedulerStore } from './scheduler-store.js';

const HISTORY_LIMIT = 50;
const SEED_COLUMNS = ['Todo', 'In Progress', 'Done'];

interface IndexFile {
  version: number;
  projects: Array<{ id: string; name: string; updatedAt: number }>;
}

interface QueueFile {
  version: number;
  limits: Limits;
  jobs: Job[];
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await withPathLock(filePath, async () => {
    const tmp = `${filePath}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, filePath);
  });
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function now(): number {
  return Date.now();
}

/**
 * JSON-backed implementation of both board and scheduler stores.
 *
 * In-memory state is the source of truth; it is loaded once at construction and
 * every mutation persists through `withPathLock` plus a temp-file rename so
 * concurrent calls cannot interleave. The layout is one file per project plus
 * an index and one queue file, all under `dataDir`.
 */
export class JsonStore implements BoardStore, SchedulerStore {
  private readonly dataDir: string;
  private readonly projectsDir: string;
  private readonly indexFile: string;
  private readonly queueFile: string;

  private projects = new Map<string, Project>();
  private indexProjects: IndexFile['projects'] = [];
  private limits: Limits;
  private jobs: Job[] = [];

  /** card id → project id, maintained on load and every card write. */
  private readonly cardToProject = new Map<string, string>();
  /** session id → card id, maintained when a card gains a session. */
  private readonly sessionToCard = new Map<string, string>();

  private constructor(dataDir: string, seedLimits: Limits) {
    this.dataDir = dataDir;
    this.projectsDir = path.join(dataDir, 'projects');
    this.indexFile = path.join(dataDir, 'index.json');
    this.queueFile = path.join(dataDir, 'queue.json');
    this.limits = { ...seedLimits };
  }

  static async create(dataDir: string, seedLimits: Limits): Promise<JsonStore> {
    const store = new JsonStore(dataDir, seedLimits);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    await mkdir(this.projectsDir, { recursive: true });

    const index = await readJson<IndexFile>(this.indexFile);
    this.indexProjects = index?.projects ?? [];

    for (const entry of this.indexProjects) {
      const project = await readJson<Project>(
        path.join(this.projectsDir, `${entry.id}.json`)
      );
      if (project) this.registerProject(project);
    }

    const queue = await readJson<QueueFile>(this.queueFile);
    if (queue) {
      this.limits = queue.limits ?? this.limits;
      this.jobs = queue.jobs ?? [];
    }
    for (const job of this.jobs) {
      if (job.sessionId) this.sessionToCard.set(job.sessionId, job.cardId);
    }
  }

  private registerProject(project: Project): void {
    this.projects.set(project.id, project);
    for (const card of project.cards) {
      this.cardToProject.set(card.id, project.id);
      if (card.sessionId) this.sessionToCard.set(card.sessionId, card.id);
    }
  }

  private requireProject(projectId: string): Project | undefined {
    return this.projects.get(projectId);
  }

  private async persistIndex(): Promise<void> {
    const payload: IndexFile = { version: 1, projects: this.indexProjects };
    await writeJsonAtomic(this.indexFile, payload);
  }

  private async persistProject(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) return;
    await writeJsonAtomic(
      path.join(this.projectsDir, `${projectId}.json`),
      project
    );
    const entry = this.indexProjects.find(
      candidate => candidate.id === projectId
    );
    if (entry) {
      entry.name = project.name;
      entry.updatedAt = now();
    } else {
      this.indexProjects.push({
        id: projectId,
        name: project.name,
        updatedAt: now(),
      });
    }
    await this.persistIndex();
  }

  private async persistQueue(): Promise<void> {
    const payload: QueueFile = {
      version: 1,
      limits: this.limits,
      jobs: this.jobs,
    };
    await writeJsonAtomic(this.queueFile, payload);
  }

  private columnsInOrder(project: Project): Column[] {
    return [...project.columns].sort((a, b) => a.order - b.order);
  }

  private normalizePositions(project: Project, columnId: string): void {
    const inColumn = project.cards
      .filter(card => card.columnId === columnId)
      .sort((a, b) => a.position - b.position);
    inColumn.forEach((card, index) => {
      card.position = index;
    });
  }

  async listProjects(): Promise<
    Array<{ id: string; name: string; cardCount: number }>
  > {
    return [...this.projects.values()].map(project => ({
      id: project.id,
      name: project.name,
      cardCount: project.cards.length,
    }));
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async createProject(input: {
    name: string;
    defaultBeaconId?: string;
    defaultWorkingDir?: string;
  }): Promise<Project> {
    const columns: Column[] = SEED_COLUMNS.map((name, order) => ({
      id: newColumnId(),
      name,
      order,
    }));
    const project: Project = {
      id: newProjectId(),
      name: input.name,
      columns,
      cards: [],
      automations: [],
      ...(input.defaultBeaconId
        ? { defaultBeaconId: input.defaultBeaconId }
        : {}),
      ...(input.defaultWorkingDir
        ? { defaultWorkingDir: input.defaultWorkingDir }
        : {}),
    };
    this.projects.set(project.id, project);
    await this.persistProject(project.id);
    return project;
  }

  async updateProject(
    id: string,
    patch: Partial<
      Pick<Project, 'name' | 'defaultBeaconId' | 'defaultWorkingDir'>
    >
  ): Promise<Project | undefined> {
    const project = this.requireProject(id);
    if (!project) return undefined;
    if (patch.name !== undefined) project.name = patch.name;
    if (patch.defaultBeaconId !== undefined) {
      project.defaultBeaconId = patch.defaultBeaconId;
    }
    if (patch.defaultWorkingDir !== undefined) {
      project.defaultWorkingDir = patch.defaultWorkingDir;
    }
    await this.persistProject(id);
    return project;
  }

  async deleteProject(id: string): Promise<boolean> {
    const project = this.projects.get(id);
    if (!project) return false;
    for (const card of project.cards) {
      this.cardToProject.delete(card.id);
      if (card.sessionId) this.sessionToCard.delete(card.sessionId);
    }
    this.projects.delete(id);
    this.indexProjects = this.indexProjects.filter(entry => entry.id !== id);
    await this.persistIndex();
    return true;
  }

  async getCard(
    cardId: string
  ): Promise<{ project: Project; card: Card } | undefined> {
    const projectId = this.cardToProject.get(cardId);
    if (!projectId) return undefined;
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const card = project.cards.find(candidate => candidate.id === cardId);
    if (!card) return undefined;
    return { project, card };
  }

  async createCard(input: {
    projectId: string;
    title: string;
    description?: string;
    columnId?: string;
    actor: MoveRecord['actor'];
  }): Promise<Card | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const ordered = this.columnsInOrder(project);
    const columnId = input.columnId ?? ordered[0]?.id;
    if (!columnId || !project.columns.some(column => column.id === columnId)) {
      return undefined;
    }
    const card: Card = {
      id: newCardId(),
      title: input.title,
      columnId,
      position: 0,
      history: [
        {
          at: now(),
          actor: input.actor,
          fromColumnId: null,
          toColumnId: columnId,
        },
      ],
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    };
    project.cards.push(card);
    this.cardToProject.set(card.id, project.id);
    this.normalizePositions(project, columnId);
    await this.persistProject(project.id);
    return card;
  }

  async updateCard(input: {
    projectId: string;
    cardId: string;
    title?: string;
    description?: string;
  }): Promise<Card | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const card = project.cards.find(candidate => candidate.id === input.cardId);
    if (!card) return undefined;
    if (input.title !== undefined) card.title = input.title;
    if (input.description !== undefined) card.description = input.description;
    await this.persistProject(project.id);
    return card;
  }

  async setCardSession(input: {
    projectId: string;
    cardId: string;
    sessionId?: string;
    spawnId?: string;
    sessionStatus?: Card['sessionStatus'];
  }): Promise<Card | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const card = project.cards.find(candidate => candidate.id === input.cardId);
    if (!card) return undefined;
    if (input.sessionId !== undefined) {
      card.sessionId = input.sessionId;
      this.sessionToCard.set(input.sessionId, card.id);
    }
    if (input.spawnId !== undefined) card.spawnId = input.spawnId;
    if (input.sessionStatus !== undefined)
      card.sessionStatus = input.sessionStatus;
    await this.persistProject(project.id);
    return card;
  }

  async moveCard(input: {
    projectId: string;
    cardId: string;
    toColumnId: string;
    position?: number;
    actor: MoveRecord['actor'];
  }): Promise<{ card: Card; fromColumnId: string | null } | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const card = project.cards.find(candidate => candidate.id === input.cardId);
    if (!card) return undefined;
    if (!project.columns.some(column => column.id === input.toColumnId)) {
      return undefined;
    }
    const fromColumnId = card.columnId;
    card.columnId = input.toColumnId;
    card.history.push({
      at: now(),
      actor: input.actor,
      fromColumnId,
      toColumnId: input.toColumnId,
    });
    if (card.history.length > HISTORY_LIMIT) {
      card.history = card.history.slice(-HISTORY_LIMIT);
    }
    const target = project.cards
      .filter(candidate => candidate.columnId === input.toColumnId)
      .sort((a, b) => a.position - b.position)
      .filter(candidate => candidate.id !== card.id);
    const at = Math.max(
      0,
      Math.min(input.position ?? target.length, target.length)
    );
    target.splice(at, 0, card);
    target.forEach((candidate, index) => {
      candidate.position = index;
    });
    if (fromColumnId !== input.toColumnId) {
      this.normalizePositions(project, fromColumnId);
    }
    await this.persistProject(project.id);
    return { card, fromColumnId };
  }

  async addColumn(input: {
    projectId: string;
    name: string;
  }): Promise<Column | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const order = project.columns.length;
    const column: Column = { id: newColumnId(), name: input.name, order };
    project.columns.push(column);
    await this.persistProject(project.id);
    return column;
  }

  async updateColumn(input: {
    projectId: string;
    columnId: string;
    name?: string;
    order?: number;
  }): Promise<Column | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const column = project.columns.find(
      candidate => candidate.id === input.columnId
    );
    if (!column) return undefined;
    if (input.name !== undefined) column.name = input.name;
    if (input.order !== undefined) column.order = input.order;
    await this.persistProject(project.id);
    return column;
  }

  async deleteColumn(input: {
    projectId: string;
    columnId: string;
  }): Promise<boolean> {
    const project = this.requireProject(input.projectId);
    if (!project) return false;
    if (project.columns.length <= 1) return false;
    if (project.cards.some(card => card.columnId === input.columnId))
      return false;
    const next = project.columns.filter(column => column.id !== input.columnId);
    if (next.length === project.columns.length) return false;
    next
      .sort((a, b) => a.order - b.order)
      .forEach((column, order) => {
        column.order = order;
      });
    project.columns = next;
    await this.persistProject(project.id);
    return true;
  }

  async listAutomations(projectId: string): Promise<Automation[]> {
    return this.projects.get(projectId)?.automations ?? [];
  }

  async createAutomation(input: {
    projectId: string;
    automation: Omit<Automation, 'id'>;
  }): Promise<Automation | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    if (
      input.automation.when.from === '*' &&
      input.automation.when.to === '*'
    ) {
      return undefined;
    }
    const automation: Automation = {
      id: newAutomationId(),
      ...input.automation,
    };
    project.automations.push(automation);
    await this.persistProject(project.id);
    return automation;
  }

  async updateAutomation(input: {
    projectId: string;
    automationId: string;
    patch: Partial<Omit<Automation, 'id'>>;
  }): Promise<Automation | undefined> {
    const project = this.requireProject(input.projectId);
    if (!project) return undefined;
    const automation = project.automations.find(
      candidate => candidate.id === input.automationId
    );
    if (!automation) return undefined;
    const from = input.patch.when?.from ?? automation.when.from;
    const to = input.patch.when?.to ?? automation.when.to;
    if (from === '*' && to === '*') return undefined;
    if (input.patch.name !== undefined) automation.name = input.patch.name;
    if (input.patch.enabled !== undefined)
      automation.enabled = input.patch.enabled;
    if (input.patch.when !== undefined) automation.when = { from, to };
    if (input.patch.then !== undefined) automation.then = input.patch.then;
    await this.persistProject(project.id);
    return automation;
  }

  async deleteAutomation(input: {
    projectId: string;
    automationId: string;
  }): Promise<boolean> {
    const project = this.requireProject(input.projectId);
    if (!project) return false;
    const before = project.automations.length;
    project.automations = project.automations.filter(
      candidate => candidate.id !== input.automationId
    );
    if (project.automations.length === before) return false;
    await this.persistProject(project.id);
    return true;
  }

  getCardProjectId(cardId: string): string | undefined {
    return this.cardToProject.get(cardId);
  }

  getCardIdForSession(sessionId: string): string | undefined {
    return this.sessionToCard.get(sessionId);
  }

  async getLimits(): Promise<Limits> {
    return { ...this.limits };
  }

  async setLimits(patch: Partial<Limits>): Promise<Limits> {
    this.limits = { ...this.limits, ...patch };
    await this.persistQueue();
    return { ...this.limits };
  }

  async listJobs(): Promise<Job[]> {
    return this.jobs.map(job => ({ ...job }));
  }

  async enqueueJob(job: Job): Promise<void> {
    this.jobs.push(job);
    await this.persistQueue();
  }

  async updateJob(
    jobId: string,
    patch: Partial<Job>
  ): Promise<Job | undefined> {
    const job = this.jobs.find(candidate => candidate.id === jobId);
    if (!job) return undefined;
    Object.assign(job, patch);
    if (patch.sessionId) this.sessionToCard.set(patch.sessionId, job.cardId);
    await this.persistQueue();
    return { ...job };
  }
}

/** Create and load a JSON store under `dataDir`. */
export async function createJsonStore(
  dataDir: string,
  seedLimits: Limits
): Promise<JsonStore> {
  return JsonStore.create(dataDir, seedLimits);
}
