/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePersonaCapability,
  type DroneSkillsCapability,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { personaPlugin } from '../src/plugins/persona/index.js';
import { skillsPlugin } from '../src/plugins/skills/index.js';
import { skillProviderProjectPlugin } from '../src/plugins/skill-provider-project/index.js';
import { personaProviderProjectPlugin } from '../src/plugins/persona-provider-project/index.js';

const PERSONA_MD = (id: string, extra = '') =>
  `---
name: ${id}
description: 'A test persona.'
${extra}---
# ${id}
`;

const SKILL_MD = (id: string, body = 'Test body.') =>
  `---
name: ${id}
description: 'A test skill.'
recall:
  - The user mentions testing
model-invocation: true
---
# ${id}

${body}
`;

async function withProjectDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-owned-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Build an engine with two personas (alice, bob) that each own a `deploy`
 * skill, plus a global `deploy` and a global `shared` skill. Alice's owned
 * `deploy` has a distinct body so owner-wins resolution is observable.
 */
async function setupEngine(projectDir: string) {
  const config = createDefaultAgentConfig();
  config.enabledPlugins = [
    'persona',
    'skills',
    'skill-provider-project',
    'persona-provider-project',
  ];
  const engine = createDronePluginEngine({
    plugins: [
      personaPlugin,
      skillsPlugin,
      skillProviderProjectPlugin,
      personaProviderProjectPlugin,
    ],
    config,
  });
  await engine.initialize();

  const base = path.join(projectDir, '.drone-agent');
  await mkdir(path.join(base, 'skills'), { recursive: true });
  await mkdir(path.join(base, 'personas', 'alice', 'skills'), {
    recursive: true,
  });
  await mkdir(path.join(base, 'personas', 'bob', 'skills'), { recursive: true });

  await writeFile(
    path.join(base, 'personas', 'alice', 'persona.md'),
    PERSONA_MD('alice'),
    'utf-8'
  );
  await writeFile(
    path.join(base, 'personas', 'bob', 'persona.md'),
    PERSONA_MD('bob'),
    'utf-8'
  );

  await writeFile(
    path.join(base, 'skills', 'deploy.md'),
    SKILL_MD('deploy', 'GLOBAL deploy body.'),
    'utf-8'
  );
  await writeFile(
    path.join(base, 'skills', 'shared.md'),
    SKILL_MD('shared', 'Shared global body.'),
    'utf-8'
  );
  await writeFile(
    path.join(base, 'personas', 'alice', 'skills', 'deploy.md'),
    SKILL_MD('deploy', 'ALICE deploy body.'),
    'utf-8'
  );
  await writeFile(
    path.join(base, 'personas', 'alice', 'skills', 'alice-only.md'),
    SKILL_MD('alice-only', 'ALICE private body.'),
    'utf-8'
  );
  await writeFile(
    path.join(base, 'personas', 'bob', 'skills', 'deploy.md'),
    SKILL_MD('deploy', 'BOB deploy body.'),
    'utf-8'
  );

  const personaCap = engine.getCapability<DronePersonaCapability>('persona')!;
  await personaCap.reloadPersonas();
  const skillsCap = engine.getCapability<DroneSkillsCapability>('skills')!;
  await skillsCap.reloadSkills();

  return { engine, personaCap, skillsCap };
}

async function withEngine<T>(
  fn: (ctx: Awaited<ReturnType<typeof setupEngine>>) => Promise<T>
): Promise<T> {
  return withProjectDir(async projectDir => {
    const originalCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      return await fn(await setupEngine(projectDir));
    } finally {
      process.cwd = originalCwd;
    }
  });
}

async function listIds(engine: ReturnType<typeof createDronePluginEngine>) {
  const res = await engine.executeTool('skills__list', {});
  const parsed = JSON.parse(toToolResultContent(res));
  return (parsed.skills as { id: string }[]).map(s => s.id);
}

describe('persona-owned skill isolation', () => {
  it('hides a foreign owned skill from skills__list', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('alice');
      const ids = await listIds(engine);
      expect(ids).toContain('alice-only');
      expect(ids).toContain('shared');
      expect(ids).not.toContain('bob'); // sanity: bob's skills are bob-only

      personaCap.selectPersona('bob');
      const bobIds = await listIds(engine);
      expect(bobIds).not.toContain('alice-only');
    });
  });

  it('fails recall for a foreign owned skill', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('bob');
      await expect(
        engine.executeTool('skills__recall', { id: 'alice-only' })
      ).rejects.toThrow(/Unknown skill/);
    });
  });

  it('resolves @skill: to unknown for a foreign owned skill', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('bob');
      const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
      expect(await cap.renderSkillBody('alice-only')).toBeUndefined();
    });
  });

  it('hides owned skills in the header fragment before activation', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona(null);
      const fragments = await engine.renderPromptFragmentsByPhase('header');
      const text = fragments.join('\n');
      expect(text).toContain('# Skills');
      expect(text).not.toContain('alice-only');
    });
  });

  it('shows an owned skill to its owner in the header fragment', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('alice');
      const fragments = await engine.renderPromptFragmentsByPhase('header');
      const text = fragments.join('\n');
      expect(text).toContain('alice-only');
    });
  });
});

describe('owner-wins id resolution', () => {
  it("returns the owner's body for a shared public id", async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('alice');
      const res = await engine.executeTool('skills__recall', { id: 'deploy' });
      const parsed = JSON.parse(toToolResultContent(res));
      expect(parsed.body).toContain('ALICE deploy body.');

      personaCap.selectPersona('bob');
      const bobRes = await engine.executeTool('skills__recall', { id: 'deploy' });
      const bobParsed = JSON.parse(toToolResultContent(bobRes));
      expect(bobParsed.body).toContain('BOB deploy body.');
    });
  });

  it('returns the global body when no persona is active', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona(null);
      const res = await engine.executeTool('skills__recall', { id: 'deploy' });
      const parsed = JSON.parse(toToolResultContent(res));
      expect(parsed.body).toContain('GLOBAL deploy body.');
    });
  });
});

describe('operator (all) carve-out', () => {
  it('skills__list all=true includes foreign owned skills', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('alice');
      const res = await engine.executeTool('skills__list', { all: true });
      const parsed = JSON.parse(toToolResultContent(res));
      const ids = (parsed.skills as { id: string }[]).map(s => s.id);
      expect(ids).toContain('alice-only');
      expect(ids).toContain('deploy');
    });
  });

  it('skills__recall all=true resolves a foreign owned skill', async () => {
    await withEngine(async ({ engine, personaCap }) => {
      personaCap.selectPersona('bob');
      const res = await engine.executeTool('skills__recall', {
        id: 'alice-only',
        all: true,
      });
      const parsed = JSON.parse(toToolResultContent(res));
      expect(parsed.body).toContain('ALICE private body.');
    });
  });
});
