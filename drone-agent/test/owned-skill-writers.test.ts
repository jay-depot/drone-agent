/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DroneOwnedSkillWriter,
  type DroneSkillsCapability,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { skillsPlugin } from '../src/plugins/skills/index.js';
import { personaPlugin } from '../src/plugins/persona/index.js';
import { personaProviderProjectPlugin } from '../src/plugins/persona-provider-project/index.js';

function stubOwnedWriter(
  scope: DroneOwnedSkillWriter['scope']
): DroneOwnedSkillWriter {
  return {
    id: `ow-${scope}`,
    scope,
    labelFor: personaId => `${scope}:${personaId}`,
    exists: async () => false,
    writeSkill: async () => ({ filePath: `/x/${scope}` }),
  };
}

async function withEngine<T>(
  plugins: Parameters<typeof createDronePluginEngine>[0]['plugins'],
  enabledPlugins: string[],
  fn: (engine: ReturnType<typeof createDronePluginEngine>) => Promise<T>
): Promise<T> {
  const config = createDefaultAgentConfig();
  config.enabledPlugins = enabledPlugins;
  const engine = createDronePluginEngine({ plugins, config });
  await engine.initialize();
  return fn(engine);
}

describe('skills broker — owned-writer registry', () => {
  it('sorts owned writers by scope order regardless of registration order', async () => {
    await withEngine([skillsPlugin], ['skills'], async engine => {
      const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
      cap.registerOwnedWriter(stubOwnedWriter('coordinator'));
      cap.registerOwnedWriter(stubOwnedWriter('project'));
      cap.registerOwnedWriter(stubOwnedWriter('beacon'));
      cap.registerOwnedWriter(stubOwnedWriter('user'));
      expect(cap.getOwnedWriters().map(w => w.scope)).toEqual([
        'project',
        'user',
        'beacon',
        'coordinator',
      ]);
    });
  });

  it('unregisters an owned writer by id without touching global writers', async () => {
    await withEngine([skillsPlugin], ['skills'], async engine => {
      const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
      cap.registerOwnedWriter(stubOwnedWriter('project'));
      cap.registerOwnedWriter(stubOwnedWriter('user'));
      expect(cap.getWriters()).toEqual([]);
      cap.unregisterOwnedWriter('ow-user');
      expect(cap.getOwnedWriters().map(w => w.id)).toEqual(['ow-project']);
      expect(cap.getWriters()).toEqual([]);
    });
  });
});

describe('persona-provider-project — owned-skill writer', () => {
  async function withProjectDir<T>(
    fn: (dir: string) => Promise<T>
  ): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'drone-owned-writer-'));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
      return await fn(dir);
    } finally {
      process.cwd = originalCwd;
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('writes an owned skill under the owner persona and reports existence', async () => {
    await withProjectDir(async projectDir => {
      await withEngine(
        [personaPlugin, skillsPlugin, personaProviderProjectPlugin],
        ['persona', 'skills', 'persona-provider-project'],
        async engine => {
          const cap = engine.getCapability<DroneSkillsCapability>('skills')!;
          const writer = cap
            .getOwnedWriters()
            .find(w => w.scope === 'project')!;
          expect(writer).toBeDefined();
          expect(await writer.exists('alice', 'greet')).toBe(false);
          const { filePath } = await writer.writeSkill(
            'alice',
            'greet',
            '---\nname: greet\n---\n# greet\n'
          );
          expect(filePath).toBe(
            path.join(
              projectDir,
              '.drone-agent',
              'personas',
              'alice',
              'skills',
              'greet.md'
            )
          );
          const written = await readFile(filePath, 'utf-8');
          expect(written).toContain('# greet');
          expect(await writer.exists('alice', 'greet')).toBe(true);
          expect(await writer.exists('bob', 'greet')).toBe(false);
        }
      );
    });
  });
});
