/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultAgentConfig } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { skillsPlugin } from '../src/plugins/skills/index.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-skills-plugin-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('skills.reload tool', () => {
  it('reloads skills from disk', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const config = createDefaultAgentConfig();
        config.enabledPlugins = ['skills'];
        const engine = createDronePluginEngine({
          plugins: [skillsPlugin],
          config,
        });
        await engine.initialize();

        // Initially no skills
        const before = await engine.executeTool('skills.list', {});
        const beforeParsed = JSON.parse(before);
        expect(beforeParsed.count).toBe(0);

        // Write a skill file
        const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
        await mkdir(skillsDir, { recursive: true });
        await writeFile(
          path.join(skillsDir, 'test-skill.md'),
          SKILL_MD('test-skill'),
          'utf-8'
        );

        // Reload
        const reloadResult = await engine.executeTool('skills.reload', {});
        const reloadParsed = JSON.parse(reloadResult);
        expect(reloadParsed.count).toBe(1);
        expect(reloadParsed.skills).toContain('test-skill');

        // Verify via list
        const after = await engine.executeTool('skills.list', {});
        const afterParsed = JSON.parse(after);
        expect(afterParsed.count).toBe(1);
        expect(afterParsed.skills[0].id).toBe('test-skill');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('returns zero count when no skills are present', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const config = createDefaultAgentConfig();
        config.enabledPlugins = ['skills'];
        const engine = createDronePluginEngine({
          plugins: [skillsPlugin],
          config,
        });
        await engine.initialize();

        const result = await engine.executeTool('skills.reload', {});
        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(0);
        expect(parsed.skills).toEqual([]);
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('picks up newly written files after reload', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const config = createDefaultAgentConfig();
        config.enabledPlugins = ['skills'];
        const engine = createDronePluginEngine({
          plugins: [skillsPlugin],
          config,
        });
        await engine.initialize();

        // Write first skill
        const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
        await mkdir(skillsDir, { recursive: true });
        await writeFile(
          path.join(skillsDir, 'skill-a.md'),
          SKILL_MD('skill-a'),
          'utf-8'
        );

        // Reload — should see skill-a
        await engine.executeTool('skills.reload', {});
        let list = await engine.executeTool('skills.list', {});
        expect(JSON.parse(list).count).toBe(1);

        // Write second skill
        await writeFile(
          path.join(skillsDir, 'skill-b.md'),
          SKILL_MD('skill-b'),
          'utf-8'
        );

        // Reload — should see both
        await engine.executeTool('skills.reload', {});
        list = await engine.executeTool('skills.list', {});
        const parsed = JSON.parse(list);
        expect(parsed.count).toBe(2);
        const ids = parsed.skills.map((s: { id: string }) => s.id);
        expect(ids).toContain('skill-a');
        expect(ids).toContain('skill-b');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  it('reflects edited files after reload', async () => {
    await withProjectDir(async projectDir => {
      const originalCwd = process.cwd;
      process.cwd = () => projectDir;
      try {
        const config = createDefaultAgentConfig();
        config.enabledPlugins = ['skills'];
        const engine = createDronePluginEngine({
          plugins: [skillsPlugin],
          config,
        });
        await engine.initialize();

        const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
        await mkdir(skillsDir, { recursive: true });
        await writeFile(
          path.join(skillsDir, 'editable.md'),
          SKILL_MD('editable'),
          'utf-8'
        );

        await engine.executeTool('skills.reload', {});
        let list = await engine.executeTool('skills.list', {});
        expect(JSON.parse(list).skills[0].description).toBe('A test skill.');

        // Edit the file
        const edited = SKILL_MD('editable').replace(
          'A test skill.',
          'An edited skill.'
        );
        await writeFile(path.join(skillsDir, 'editable.md'), edited, 'utf-8');

        await engine.executeTool('skills.reload', {});
        list = await engine.executeTool('skills.list', {});
        expect(JSON.parse(list).skills[0].description).toBe('An edited skill.');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});
