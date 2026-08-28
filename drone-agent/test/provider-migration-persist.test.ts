import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistLegacyProviderMigration } from '../src/runtime/provider-migration-persist.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provider-migration-persist-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeUserConfig(content: unknown): Promise<string> {
  const filePath = path.join(dir, 'config.json');
  await writeFile(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  return filePath;
}

describe('persistLegacyProviderMigration', () => {
  it('rewrites user-scope legacy config with template preserved and backup intact', async () => {
    const filePath = await writeUserConfig({
      llm: { provider: 'anthropic' },
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '${ANTHROPIC_API_KEY}',
        defaultModel: 'claude-sonnet-4-6',
        models: [{ id: 'claude-sonnet-4-6', contextWindow: 1000000 }],
      },
      unrelated: { keep: true },
    });

    const outcome = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);

    expect(outcome.writtenPaths).toEqual([filePath]);
    expect(outcome.backupPaths).toHaveLength(1);
    expect(path.basename(outcome.backupPaths[0])).toMatch(
      /^config\.json\..+\.old$/
    );

    const migrated = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(migrated.providers.anthropic).toMatchObject({
      protocol: 'anthropic',
      apiKey: '${ANTHROPIC_API_KEY}',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(migrated.providers.anthropic.models['claude-sonnet-4-6']).toEqual({
      contextWindow: 1000000,
    });
    expect(migrated.llm.active).toBe('anthropic/claude-sonnet-4-6');
    for (const legacy of ['ollama', 'openai', 'anthropic', 'openrouter']) {
      expect(migrated[legacy]).toBeUndefined();
    }
    expect(migrated.unrelated).toEqual({ keep: true });

    // Backup holds the ORIGINAL bytes verbatim.
    const backup = JSON.parse(await readFile(outcome.backupPaths[0], 'utf-8'));
    expect(backup).toEqual({
      llm: { provider: 'anthropic' },
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '${ANTHROPIC_API_KEY}',
        defaultModel: 'claude-sonnet-4-6',
        models: [{ id: 'claude-sonnet-4-6', contextWindow: 1000000 }],
      },
      unrelated: { keep: true },
    });
  });

  it('relocates literal api keys unchanged and emits the advisory warning', async () => {
    const filePath = await writeUserConfig({
      openai: { apiKey: 'sk-literal-key', models: [] },
    });

    const outcome = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);

    const migrated = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(migrated.providers.openai.apiKey).toBe('sk-literal-key');
    expect(
      outcome.warnings.some(
        w =>
          w.includes('openai') &&
          w.includes('literal API key') &&
          w.includes('${VAR}')
      )
    ).toBe(true);
  });

  it('strips shadowed legacy sections from mixed-format files without touching providers', async () => {
    const providersBlock = {
      anthropic: {
        protocol: 'anthropic',
        apiKey: '${KEY}',
        models: { 'claude-x': {} },
      },
    };
    const filePath = await writeUserConfig({
      providers: providersBlock,
      openai: { apiKey: 'stale', models: [] },
    });

    const outcome = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);

    expect(outcome.writtenPaths).toEqual([filePath]);
    const migrated = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(migrated.providers).toEqual(providersBlock);
    expect(migrated.openai).toBeUndefined();
  });

  it('leaves already-canonical files completely untouched', async () => {
    const canonical = {
      llm: { active: 'anthropic/claude' },
      providers: { anthropic: { protocol: 'anthropic', apiKey: '${K}' } },
    };
    const filePath = await writeUserConfig(canonical);

    const outcome = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);

    expect(outcome.writtenPaths).toHaveLength(0);
    expect(outcome.backupPaths).toHaveLength(0);
    expect(JSON.parse(await readFile(filePath, 'utf-8'))).toEqual(canonical);
  });

  it('never writes providers at project scope; returns a redirect warning instead', async () => {
    const filePath = await writeUserConfig({
      anthropic: { apiKey: '${KEY}', models: [] },
    });

    const outcome = await persistLegacyProviderMigration([
      { scope: 'project', path: filePath },
    ]);

    expect(outcome.writtenPaths).toHaveLength(0);
    expect(outcome.backupPaths).toHaveLength(0);
    const untouched = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(untouched.providers).toBeUndefined();
    expect(untouched.anthropic.apiKey).toBe('${KEY}');
    expect(outcome.warnings.some(w => w.includes('project scope'))).toBe(true);
  });

  it('is a no-op on the second run after a successful migration', async () => {
    const filePath = await writeUserConfig({
      anthropic: { apiKey: '${KEY}', models: [] },
    });

    const first = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);
    expect(first.writtenPaths).toEqual([filePath]);

    const second = await persistLegacyProviderMigration([
      { scope: 'user', path: filePath },
    ]);
    expect(second.writtenPaths).toHaveLength(0);
    expect(second.backupPaths).toHaveLength(0);

    const backups = (await readdir(dir)).filter(name => name.endsWith('.old'));
    expect(backups).toHaveLength(1);
  });

  it('writes via tmp file + rename (atomic shape)', async () => {
    const filePath = await writeUserConfig({
      openai: { apiKey: '${OPENAI_API_KEY}', models: [] },
    });

    await persistLegacyProviderMigration([{ scope: 'user', path: filePath }]);

    const leftovers = (await readdir(dir)).filter(name =>
      name.startsWith('config.json.tmp')
    );
    expect(leftovers).toHaveLength(0);
    const migrated = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(migrated.providers.openai.protocol).toBe('openai');
  });
});
