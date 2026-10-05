import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  createPersona,
  createSkill,
  getSkill,
  getSkillByKey,
  getGlobalSkill,
  listSkillsByPersona,
  updateSkillByKey,
  deleteSkillByKey,
  deleteSkillsByPersona,
  deletePersonaWithSkills,
} from '../src/db/index.js';

const SKILL = (id: string) => ({
  id,
  name: id,
  description: `Skill ${id}`,
  trigger: '',
  body: `# ${id}`,
});

describe('Coordinator skill ownership (composite key)', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('creates coordinator-scoped owned skills under a composite key', () => {
    const skill = createSkill(SKILL('wiki-style'), { personaId: 'librarian' });
    expect(skill.scope).toBe('coordinator');
    expect(skill.personaId).toBe('librarian');
    expect(skill.key).toBe('librarian/wiki-style');
    expect(getSkillByKey('librarian/wiki-style')).toBeDefined();
    expect(getGlobalSkill('wiki-style')).toBeUndefined();
  });

  it('lets an owned and a global skill share an id', () => {
    createSkill(SKILL('deploy'));
    createSkill(SKILL('deploy'), { personaId: 'alice' });
    expect(getGlobalSkill('deploy')?.personaId).toBeNull();
    expect(getSkillByKey('alice/deploy')?.personaId).toBe('alice');
    expect(listSkillsByPersona('alice')).toHaveLength(1);
  });

  it('keeps two owners of the same id separate', () => {
    createSkill(SKILL('deploy'), { personaId: 'alice' });
    createSkill(SKILL('deploy'), { personaId: 'bob' });
    expect(listSkillsByPersona('alice')[0].key).toBe('alice/deploy');
    expect(listSkillsByPersona('bob')[0].key).toBe('bob/deploy');
  });

  it('does not change identity fields on update', () => {
    createSkill(SKILL('deploy'), { personaId: 'alice' });
    const updated = updateSkillByKey('alice/deploy', { body: '# changed' });
    expect(updated?.body).toBe('# changed');
    expect(updated?.key).toBe('alice/deploy');
    expect(updated?.personaId).toBe('alice');
    expect(updated?.scope).toBe('coordinator');
  });

  it('deletes an owned skill by key without touching the global', () => {
    createSkill(SKILL('deploy'));
    createSkill(SKILL('deploy'), { personaId: 'alice' });
    expect(deleteSkillByKey('alice/deploy')).toBe(true);
    expect(getGlobalSkill('deploy')).toBeDefined();
    expect(getSkill('deploy')?.personaId).toBeNull();
  });
});

describe('Coordinator persona-delete cascade', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('cascades owned-skill deletion', () => {
    createPersona({
      id: 'alice',
      name: 'Alice',
      description: '',
      systemPrompt: '',
    });
    createSkill(SKILL('a'), { personaId: 'alice' });
    createSkill(SKILL('b'), { personaId: 'alice' });
    expect(deleteSkillsByPersona('alice')).toBe(2);
    expect(listSkillsByPersona('alice')).toHaveLength(0);
  });

  it('deletePersonaWithSkills removes persona and owned skills', () => {
    createPersona({
      id: 'alice',
      name: 'Alice',
      description: '',
      systemPrompt: '',
    });
    createSkill(SKILL('a'), { personaId: 'alice' });
    expect(deletePersonaWithSkills('alice')).toBe(true);
    expect(listSkillsByPersona('alice')).toHaveLength(0);
  });
});
