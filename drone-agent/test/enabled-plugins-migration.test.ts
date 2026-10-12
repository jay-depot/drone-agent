import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateEnabledPluginsRaw } from '../src/runtime/enabled-plugins-migration.js';
import { persistEnabledPluginsMigration } from '../src/runtime/enabled-plugins-migration-persist.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'enabled-plugins-migration-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown): Promise<string> {
  const filePath = path.join(dir, 'config.json');
  await writeFile(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  return filePath;
}

describe('migrateEnabledPluginsRaw', () => {
  it('translates a legacy array to an override map', () => {
    const { raw, changed } = migrateEnabledPluginsRaw({
      enabledPlugins: ['llm', 'echo'],
      other: true,
    });
    expect(changed).toBe(true);
    expect(raw.enabledPlugins).toEqual({ llm: true, echo: true });
    expect(raw.other).toBe(true);
  });

  it('leaves an already-map value untouched', () => {
    const input = { enabledPlugins: { llm: true } };
    const { raw, changed } = migrateEnabledPluginsRaw(input);
    expect(changed).toBe(false);
    expect(raw).toBe(input);
  });

  it('leaves an absent value untouched', () => {
    const input = { other: 1 };
    const { raw, changed } = migrateEnabledPluginsRaw(input);
    expect(changed).toBe(false);
    expect(raw).toBe(input);
  });
});

describe('persistEnabledPluginsMigration', () => {
  it('rewrites an array-form file to map form with a timestamped backup', async () => {
    const filePath = await writeConfig({
      enabledPlugins: ['llm', 'echo'],
      llm: { active: 'echo/echo-model' },
    });

    const { outcome, notice } = await persistEnabledPluginsMigration([
      { scope: 'user', path: filePath },
    ]);

    expect(outcome.writtenPaths).toEqual([filePath]);
    expect(outcome.backupPaths).toHaveLength(1);
    expect(path.basename(outcome.backupPaths[0])).toMatch(
      /^config\.json\..+\.old$/
    );
    expect(notice).toContain('override map');

    const migrated = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(migrated.enabledPlugins).toEqual({ llm: true, echo: true });
    expect(migrated.llm).toEqual({ active: 'echo/echo-model' });

    const backup = JSON.parse(await readFile(outcome.backupPaths[0], 'utf-8'));
    expect(backup.enabledPlugins).toEqual(['llm', 'echo']);
  });

  it('rewrites at project scope too (unlike the providers migration)', async () => {
    const filePath = await writeConfig({ enabledPlugins: ['lsp'] });

    const { outcome } = await persistEnabledPluginsMigration([
      { scope: 'project', path: filePath },
    ]);

    expect(outcome.writtenPaths).toEqual([filePath]);
    expect(
      JSON.parse(await readFile(filePath, 'utf-8')).enabledPlugins
    ).toEqual({ lsp: true });
  });

  it('is idempotent: a map-form file is never touched', async () => {
    const filePath = await writeConfig({ enabledPlugins: { llm: true } });

    const first = await persistEnabledPluginsMigration([
      { scope: 'user', path: filePath },
    ]);
    const second = await persistEnabledPluginsMigration([
      { scope: 'user', path: filePath },
    ]);

    expect(first.outcome.writtenPaths).toHaveLength(0);
    expect(first.notice).toBeUndefined();
    expect(second.outcome.writtenPaths).toHaveLength(0);

    const backups = (await readdir(dir)).filter(name => name.endsWith('.old'));
    expect(backups).toHaveLength(0);
  });

  it('is a no-op on the second run after a successful migration', async () => {
    const filePath = await writeConfig({ enabledPlugins: ['llm', 'echo'] });

    const first = await persistEnabledPluginsMigration([
      { scope: 'user', path: filePath },
    ]);
    expect(first.outcome.writtenPaths).toEqual([filePath]);

    const second = await persistEnabledPluginsMigration([
      { scope: 'user', path: filePath },
    ]);
    expect(second.outcome.writtenPaths).toHaveLength(0);
    expect(second.notice).toBeUndefined();

    const backups = (await readdir(dir)).filter(name => name.endsWith('.old'));
    expect(backups).toHaveLength(1);
  });

  it('writes via tmp file + rename (atomic shape)', async () => {
    const filePath = await writeConfig({ enabledPlugins: ['llm'] });

    await persistEnabledPluginsMigration([{ scope: 'user', path: filePath }]);

    const leftovers = (await readdir(dir)).filter(name =>
      name.startsWith('config.json.tmp')
    );
    expect(leftovers).toHaveLength(0);
    expect(
      JSON.parse(await readFile(filePath, 'utf-8')).enabledPlugins
    ).toEqual({ llm: true });
  });

  it('skips layers without a path', async () => {
    const { outcome, notice } = await persistEnabledPluginsMigration([
      { scope: 'default' },
      { scope: 'user' },
    ]);
    expect(outcome.writtenPaths).toHaveLength(0);
    expect(notice).toBeUndefined();
  });
});
