import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  createPersona,
  updatePersona,
  listPersonas,
  createSkill,
  listSkills,
} from '../src/db/index.js';
import {
  seedDefaultAssets,
  repairSeededLibrarianAssets,
  MEMORY_WIKI_SKILL_BODY,
  PHANTOM_TOOL_REFERENCES,
  WIKI_LIBRARIAN_PERSONA_ID,
  WIKI_LIBRARIAN_SYSTEM_PROMPT,
  warnIfLibrarianPersonaIsLegacy,
  type SeedLogger,
} from '../src/default-assets.js';

function collectingLogger(): SeedLogger & {
  infos: string[];
  warnings: string[];
} {
  const entries: string[] = [];
  const warnings: string[] = [];
  return {
    info: (msg: string) => {
      entries.push(msg);
    },
    warn: (msg: string) => {
      warnings.push(msg);
    },
    get infos() {
      return entries;
    },
    get warnings() {
      return warnings;
    },
  };
}

describe('seedDefaultAssets against the live database', () => {
  beforeEach(async () => {
    await setupDb();
  });
  afterEach(teardownDb);

  it('seeds a librarian persona whose prompt has no phantom tool references', () => {
    const log = collectingLogger();
    seedDefaultAssets(
      {
        createPersona,
        createSkill,
        updatePersona,
        listPersonas,
        listSkills,
      },
      log
    );

    const librarian = listPersonas().find(
      p => p.id === WIKI_LIBRARIAN_PERSONA_ID
    );
    expect(librarian).toBeDefined();
    for (const phantom of PHANTOM_TOOL_REFERENCES) {
      expect(librarian?.systemPrompt).not.toContain(phantom);
    }
    expect(librarian?.systemPrompt).toContain('swarm__wiki_write');
  });

  it('seeds a memory-wiki skill without phantom tool references', () => {
    const log = collectingLogger();
    seedDefaultAssets(
      {
        createPersona,
        createSkill,
        updatePersona,
        listPersonas,
        listSkills,
      },
      log
    );

    const skill = listSkills().find(s => s.id === 'memory-wiki');
    expect(skill).toBeDefined();
    for (const phantom of PHANTOM_TOOL_REFERENCES) {
      expect(skill?.body).not.toContain(phantom);
    }
  });

  it('seeds every default exactly once and reports the seeds', () => {
    const log = collectingLogger();
    const db = {
      createPersona,
      createSkill,
      updatePersona,
      listPersonas,
      listSkills,
    };
    seedDefaultAssets(db, log);
    seedDefaultAssets(db, log);

    expect(
      listPersonas().filter(p => p.id === WIKI_LIBRARIAN_PERSONA_ID)
    ).toHaveLength(1);
    expect(
      listPersonas().filter(p => p.id === 'coordinator-admin')
    ).toHaveLength(1);
    expect(listSkills().filter(s => s.id === 'memory-wiki')).toHaveLength(1);
    expect(log.warnings).toHaveLength(0);
    expect(log.infos).toContain(
      'Seeded default persona: coordinator-wiki-librarian'
    );
  });

  it('warns when an existing librarian persona contains phantom tool references', () => {
    createPersona({
      id: WIKI_LIBRARIAN_PERSONA_ID,
      name: 'Coordinator Wiki Librarian',
      description: 'legacy seeded copy',
      systemPrompt:
        'tools:\n  - session_list\n1. Use session_list to find finished sessions\n2. Use session_get_log\n6. Call session_mark_processed',
    });

    const log = collectingLogger();
    seedDefaultAssets(
      {
        createPersona,
        createSkill,
        updatePersona,
        listPersonas,
        listSkills,
      },
      log
    );

    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain(WIKI_LIBRARIAN_PERSONA_ID);
    expect(log.warnings[0]).toContain('session_get_log');
  });
});

describe('warnIfLibrarianPersonaIsLegacy', () => {
  it('does not warn for a repaired or unrelated persona', () => {
    const log = collectingLogger();
    warnIfLibrarianPersonaIsLegacy(
      {
        id: WIKI_LIBRARIAN_PERSONA_ID,
        systemPrompt: WIKI_LIBRARIAN_SYSTEM_PROMPT,
      },
      log
    );
    warnIfLibrarianPersonaIsLegacy(
      { id: 'other-persona', systemPrompt: 'Use session_list' },
      log
    );
    warnIfLibrarianPersonaIsLegacy(undefined, log);

    expect(log.warnings).toHaveLength(0);
  });
});

describe('seeded librarian prompt content', () => {
  it('models the query-as-input working model without piping mechanics', () => {
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).toMatch(
      /Treat the user's query as the material/
    );
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).not.toMatch(
      /pipe|stdin|--output-json/
    );
  });

  it('teaches the librarian to write a one-sentence pitch', () => {
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).toContain('one-sentence pitch');
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).toContain('pitch field');
  });

  it('memory-wiki skill body teaches the pitch field', () => {
    expect(MEMORY_WIKI_SKILL_BODY).toContain('pitch:');
    expect(MEMORY_WIKI_SKILL_BODY).toContain('one-sentence pitch field');
  });

  it('seeds carry the pitch guidance in both surfaces', () => {
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).toContain('one-sentence pitch');
    expect(MEMORY_WIKI_SKILL_BODY).toContain('one-sentence pitch field');
  });
});

describe('repairSeededLibrarianAssets (scope-rule generation bump)', () => {
  beforeEach(async () => {
    await setupDb();
  });
  afterEach(teardownDb);

  function fullDb() {
    return {
      createPersona,
      createSkill,
      updatePersona,
      listPersonas,
      listSkills,
    };
  }

  it('updates a pristine prior-seed librarian persona and skill to the new generation', () => {
    // Recreate the PRIOR generation verbatim (pre-scope-rule).
    createPersona({
      id: WIKI_LIBRARIAN_PERSONA_ID,
      name: 'Coordinator Wiki Librarian',
      description:
        'Suggested persona for scheduled and manual memory wiki maintenance sessions',
      systemPrompt: WIKI_LIBRARIAN_SYSTEM_PROMPT.replace(
        'ALWAYS passing scope: "coordinator" — the swarm memory wiki lives at the coordinator (the store the web UI shows). Writing to beacon scope stores the page locally where the memory read side will not find it. Cite the source session id in the sources field',
        'citing source session ids in the sources field'
      ),
    });
    const log = collectingLogger();
    repairSeededLibrarianAssets(fullDb(), log);

    const librarian = listPersonas().find(
      p => p.id === WIKI_LIBRARIAN_PERSONA_ID
    );
    expect(librarian?.systemPrompt).toBe(WIKI_LIBRARIAN_SYSTEM_PROMPT);
    expect(librarian?.systemPrompt).toContain('ALWAYS passing scope');
    expect(log.infos.some(i => i.includes('Repaired seeded persona'))).toBe(
      true
    );
  });

  it('preserves a customized librarian persona and warns', () => {
    createPersona({
      id: WIKI_LIBRARIAN_PERSONA_ID,
      name: 'Coordinator Wiki Librarian',
      description: 'operator-tuned copy',
      systemPrompt: 'My custom librarian prompt with my own rules.',
    });
    const log = collectingLogger();
    repairSeededLibrarianAssets(fullDb(), log);

    const librarian = listPersonas().find(
      p => p.id === WIKI_LIBRARIAN_PERSONA_ID
    );
    expect(librarian?.systemPrompt).toBe(
      'My custom librarian prompt with my own rules.'
    );
    expect(log.warnings.some(w => w.includes('customized'))).toBe(true);
  });

  it('leaves a current-generation persona untouched without warnings', () => {
    seedDefaultAssets(fullDb(), collectingLogger());
    const log = collectingLogger();
    repairSeededLibrarianAssets(fullDb(), log);

    const librarian = listPersonas().find(
      p => p.id === WIKI_LIBRARIAN_PERSONA_ID
    );
    expect(librarian?.systemPrompt).toBe(WIKI_LIBRARIAN_SYSTEM_PROMPT);
    expect(log.warnings).toHaveLength(0);
    expect(log.infos.filter(i => i.includes('Repaired'))).toHaveLength(0);
  });

  it('seeds carry the scope rule in both surfaces', () => {
    expect(WIKI_LIBRARIAN_SYSTEM_PROMPT).toContain('ALWAYS passing scope');
    expect(MEMORY_WIKI_SKILL_BODY).toContain('SCOPE RULE');
  });

  it('does not auto-repair the memory-wiki skill (operator-maintained)', () => {
    createSkill({
      id: 'memory-wiki',
      name: 'Memory Wiki',
      description: 'custom',
      trigger: 'custom',
      body: 'My own wiki structure instructions.',
    });
    const log = collectingLogger();
    repairSeededLibrarianAssets(fullDb(), log);

    const skill = listSkills().find(sk => sk.id === 'memory-wiki');
    expect(skill?.body).toBe('My own wiki structure instructions.');
    // No persona touched either (none existed).
    expect(log.infos.filter(i => i.includes('Repaired'))).toHaveLength(0);
  });
});
