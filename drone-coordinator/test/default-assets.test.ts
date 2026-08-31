import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  createPersona,
  listPersonas,
  createSkill,
  listSkills,
} from '../src/db/index.js';
import {
  seedDefaultAssets,
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
      { createPersona, createSkill, listPersonas, listSkills },
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
      { createPersona, createSkill, listPersonas, listSkills },
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
    const db = { createPersona, createSkill, listPersonas, listSkills };
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
      { createPersona, createSkill, listPersonas, listSkills },
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
});