/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DroneSkillsCapability,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { skillsPlugin } from '../src/plugins/skills/index.js';
import { skillProviderProjectPlugin } from '../src/plugins/skill-provider-project/index.js';

const SKILL_MD = (id: string) =>
  `---
name: ${id}
description: 'A test skill.'
recall:
  - The user mentions testing
model-invocation: true
---
# ${id}

Test body.
`;

async function withProjectDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-skills-rb-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setupEngine(projectDir: string) {
  const config = createDefaultAgentConfig();
  config.enabledPlugins = ['skills', 'skill-provider-project'];
  const engine = createDronePluginEngine({
    plugins: [skillsPlugin, skillProviderProjectPlugin],
    config,
  });
  await engine.initialize();
  const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
  await mkdir(skillsDir, { recursive: true });
  return { engine, skillsDir };
}

describe('skills renderSkillBody', () => {
  it('returns the skill body', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const { engine, skillsDir } = await setupEngine(projectDir);
        await writeFile(
          path.join(skillsDir, 'test-skill.md'),
          SKILL_MD('test-skill'),
          'utf-8'
        );
        await engine.executeTool('skills__list', { reload: true });

        const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
        const body = await cap.renderSkillBody('test-skill');
        expect(body).toContain('Test body.');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('applies recall enhancers', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const { engine, skillsDir } = await setupEngine(projectDir);
        await writeFile(
          path.join(skillsDir, 'enhanced.md'),
          SKILL_MD('enhanced'),
          'utf-8'
        );
        await engine.executeTool('skills__list', { reload: true });

        const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
        cap.onRecall(async (id, body) => `${body}\n\n## Principles\n- ${id}`);

        const body = await cap.renderSkillBody('enhanced');
        expect(body).toContain('Test body.');
        expect(body).toContain('## Principles');
        expect(body).toContain('- enhanced');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('matches ids case-insensitively', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const { engine, skillsDir } = await setupEngine(projectDir);
        await writeFile(
          path.join(skillsDir, 'mixedcase.md'),
          SKILL_MD('mixedcase'),
          'utf-8'
        );
        await engine.executeTool('skills__list', { reload: true });

        const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
        const upper = await cap.renderSkillBody('MixedCase');
        const lower = await cap.renderSkillBody('mixedcase');
        expect(upper).toContain('Test body.');
        expect(lower).toEqual(upper);
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('returns undefined for an unknown id', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const { engine } = await setupEngine(projectDir);
        const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
        expect(await cap.renderSkillBody('does-not-exist')).toBeUndefined();
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});
