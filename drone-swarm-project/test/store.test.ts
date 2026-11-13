import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore, JsonStore } from '../src/store/json-store.js';

async function withStore(
  fn: (store: JsonStore, dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsp-store-'));
  try {
    const store = await createJsonStore(dir, {
      maxConcurrentSessions: 1,
      maxDailySessions: 12,
    });
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('JsonStore projects', () => {
  it('creates a project seeded with three columns', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      expect(project.id).toMatch(/^p_/);
      expect(project.columns.map(c => c.name)).toEqual([
        'Todo',
        'In Progress',
        'Done',
      ]);
      expect(project.columns.map(c => c.order)).toEqual([0, 1, 2]);
    });
  });

  it('lists, updates, and deletes a project', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      expect(await store.listProjects()).toEqual([
        { id: project.id, name: 'Alpha', cardCount: 0 },
      ]);

      await store.updateProject(project.id, { name: 'Beta' });
      expect((await store.getProject(project.id))?.name).toBe('Beta');

      expect(await store.deleteProject(project.id)).toBe(true);
      expect(await store.getProject(project.id)).toBeUndefined();
      expect(await store.listProjects()).toEqual([]);
    });
  });
});

describe('JsonStore cards', () => {
  it('creates a card at the end of the target column', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const card = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });
      expect(card?.id).toMatch(/^c_/);
      expect(card?.columnId).toBe(project.columns[0]!.id);
      expect(card?.position).toBe(0);
      expect(card?.history[0]?.fromColumnId).toBeNull();
    });
  });

  it('resolves a card to its project via the in-memory map', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const card = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });
      expect(store.getCardProjectId(card!.id)).toBe(project.id);
      const found = await store.getCard(card!.id);
      expect(found?.card.title).toBe('First');
    });
  });

  it('moves a card, appends history, and reindexes positions', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const first = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });
      const second = await store.createCard({
        projectId: project.id,
        title: 'Second',
        actor: 'user',
      });
      const doneColumn = project.columns[2]!.id;
      const moved = await store.moveCard({
        projectId: project.id,
        cardId: first!.id,
        toColumnId: doneColumn,
        actor: 'agent',
      });
      expect(moved?.fromColumnId).toBe(project.columns[0]!.id);
      expect(moved?.card.columnId).toBe(doneColumn);
      expect(moved?.card.history.at(-1)?.actor).toBe('agent');

      const refreshed = await store.getProject(project.id);
      const inTodo = refreshed!.cards.filter(
        c => c.columnId === project.columns[0]!.id
      );
      expect(inTodo.map(c => c.id)).toEqual([second!.id]);
      expect(inTodo[0]!.position).toBe(0);
    });
  });

  it('updates a card title and description', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const card = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });
      const updated = await store.updateCard({
        projectId: project.id,
        cardId: card!.id,
        title: 'Renamed',
        description: 'Notes',
      });
      expect(updated?.title).toBe('Renamed');
      expect(updated?.description).toBe('Notes');
    });
  });

  it('records a session id on a card and resolves it back', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const card = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });
      await store.setCardSession({
        projectId: project.id,
        cardId: card!.id,
        sessionId: 'sess-1',
        sessionStatus: 'running',
      });
      expect(store.getCardIdForSession('sess-1')).toBe(card!.id);
      const found = await store.getCard(card!.id);
      expect(found?.card.sessionStatus).toBe('running');
    });
  });
});

describe('JsonStore automations', () => {
  it('rejects a both-wildcard automation', async () => {
    await withStore(async store => {
      const project = await store.createProject({ name: 'Alpha' });
      const created = await store.createAutomation({
        projectId: project.id,
        automation: {
          name: 'Anywhere',
          enabled: true,
          when: { from: '*', to: '*' },
          then: {
            action: 'launch-session',
            personaId: 'code',
            promptTemplate: 'x',
          },
        },
      });
      expect(created).toBeUndefined();
      expect(await store.listAutomations(project.id)).toEqual([]);
    });
  });
});

describe('JsonStore persistence', () => {
  it('reloads projects, cards, and the card map from disk', async () => {
    await withStore(async (store, dir) => {
      const project = await store.createProject({ name: 'Alpha' });
      const card = await store.createCard({
        projectId: project.id,
        title: 'First',
        actor: 'user',
      });

      const reloaded = await createJsonStore(dir, {
        maxConcurrentSessions: 1,
        maxDailySessions: 12,
      });
      expect((await reloaded.getProject(project.id))?.cards).toHaveLength(1);
      expect(reloaded.getCardProjectId(card!.id)).toBe(project.id);
    });
  });

  it('keeps the index consistent with the projects', async () => {
    await withStore(async (store, dir) => {
      const project = await store.createProject({ name: 'Alpha' });
      const index = JSON.parse(
        await readFile(path.join(dir, 'index.json'), 'utf8')
      ) as { version: number; projects: Array<{ id: string; name: string }> };
      expect(index.version).toBe(1);
      expect(index.projects).toEqual([
        { id: project.id, name: 'Alpha', updatedAt: expect.any(Number) },
      ]);
    });
  });

  it('survives a reload after a write without corruption', async () => {
    await withStore(async (store, dir) => {
      const project = await store.createProject({ name: 'Alpha' });
      await store.updateProject(project.id, { name: 'Beta' });
      const raw = await readFile(
        path.join(dir, 'projects', `${project.id}.json`),
        'utf8'
      );
      expect(() => JSON.parse(raw)).not.toThrow();
      const reloaded = await createJsonStore(dir, {
        maxConcurrentSessions: 1,
        maxDailySessions: 12,
      });
      expect((await reloaded.getProject(project.id))?.name).toBe('Beta');
    });
  });
});
