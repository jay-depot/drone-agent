import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupDb, teardownDb } from './setup.js';
import {
  initDatabase,
  closeDatabase,
  createPersona,
  createSkill,
  getSkill,
  getSkillByKey,
  getGlobalSkill,
  listSkills,
  listSkillsByPersona,
  updateSkillByKey,
  deleteSkillByKey,
  deleteSkillsByPersona,
  deleteOwnedSkillsNotIn,
  deletePersonaWithSkills,
} from '../src/db/index.js';

const SKILL = (id: string) => ({
  id,
  name: id,
  description: `Skill ${id}`,
  trigger: '',
  body: `# ${id}`,
});

describe('Beacon skill ownership (composite key)', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('keys global skills by their bare id', () => {
    const skill = createSkill(SKILL('deploy'), { scope: 'local' });
    expect(skill.key).toBe('deploy');
    expect(skill.personaId).toBeNull();
    expect(getGlobalSkill('deploy')).toBeDefined();
  });

  it('keys owned skills by <personaId>/<id>', () => {
    const skill = createSkill(SKILL('deploy'), {
      scope: 'local',
      personaId: 'alice',
    });
    expect(skill.key).toBe('alice/deploy');
    expect(skill.personaId).toBe('alice');
    expect(getSkillByKey('alice/deploy')).toBeDefined();
    expect(getGlobalSkill('deploy')).toBeUndefined();
  });

  it('lets two personas own same-named skills without overwriting', () => {
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'bob' });
    expect(listSkills()).toHaveLength(2);
    expect(getSkillByKey('alice/deploy')?.personaId).toBe('alice');
    expect(getSkillByKey('bob/deploy')?.personaId).toBe('bob');
  });

  it('lets an owned and a global skill share an id', () => {
    createSkill(SKILL('deploy'), { scope: 'local' });
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    expect(listSkills()).toHaveLength(2);
    expect(getGlobalSkill('deploy')?.personaId).toBeNull();
    expect(getSkillByKey('alice/deploy')?.personaId).toBe('alice');
  });

  it('lists only a persona-owned skill for its owner', () => {
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'bob' });
    const aliceSkills = listSkillsByPersona('alice');
    expect(aliceSkills).toHaveLength(1);
    expect(aliceSkills[0].key).toBe('alice/deploy');
  });

  it('does not change identity fields on update', () => {
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    const updated = updateSkillByKey('alice/deploy', { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.key).toBe('alice/deploy');
    expect(updated?.id).toBe('deploy');
    expect(updated?.personaId).toBe('alice');
  });

  it('deletes by key only the addressed row', () => {
    createSkill(SKILL('deploy'), { scope: 'local' });
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    expect(deleteSkillByKey('alice/deploy')).toBe(true);
    expect(getGlobalSkill('deploy')).toBeDefined();
    expect(getSkillByKey('alice/deploy')).toBeUndefined();
  });

  it('deleteSkillsByPersona removes only that owner rows', () => {
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'bob' });
    expect(deleteSkillsByPersona('alice')).toBe(1);
    expect(listSkillsByPersona('alice')).toHaveLength(0);
    expect(listSkillsByPersona('bob')).toHaveLength(1);
  });
});

describe('Beacon persona-delete cascade', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('deletes a persona and its owned skills atomically', () => {
    createPersona(
      { id: 'alice', name: 'Alice', description: '', systemPrompt: '' },
      'local'
    );
    createSkill(SKILL('deploy'), { scope: 'local', personaId: 'alice' });
    expect(deletePersonaWithSkills('alice')).toBe(true);
    expect(listSkillsByPersona('alice')).toHaveLength(0);
  });

  it('returns false when the persona does not exist', () => {
    expect(deletePersonaWithSkills('missing')).toBe(false);
  });
});

describe('Beacon reconcile sweeps', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('drops owned rows whose owner vanished from the coordinator', () => {
    createSkill(SKILL('a'), { scope: 'coordinator', personaId: 'alice' });
    createSkill(SKILL('b'), { scope: 'coordinator', personaId: 'bob' });
    expect(deleteOwnedSkillsNotIn(new Set(['bob']))).toBe(1);
    expect(listSkillsByPersona('alice')).toHaveLength(0);
    expect(listSkillsByPersona('bob')).toHaveLength(1);
  });

  it('never touches global skills when reconciling owners', () => {
    createSkill(SKILL('deploy'), { scope: 'local' });
    createSkill(SKILL('a'), { scope: 'coordinator', personaId: 'alice' });
    deleteOwnedSkillsNotIn(new Set());
    expect(getGlobalSkill('deploy')).toBeDefined();
  });
});

describe('Beacon skills schema migration from the legacy flat table', () => {
  let dir = '';
  let dbFile = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'drone-beacon-migrate-'));
    dbFile = path.join(dir, 'legacy.db');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves rows and backfills key=id, personaId=null', () => {
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        trigger TEXT NOT NULL, body TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'local',
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      INSERT INTO skills VALUES ('legacy', 'Legacy', 'd', 't', 'b', 'local', 5, 6);
    `);
    legacy.close();

    initDatabase(dbFile);
    const migrated = getGlobalSkill('legacy');
    expect(migrated).toBeDefined();
    expect(migrated?.key).toBe('legacy');
    expect(migrated?.personaId).toBeNull();
    expect(migrated?.createdAt).toBe(5);
  });
});
