import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  listAllAssets,
  migrateAsset,
} from '../src/runtime/migration/index.js';

let projectDir: string;
let userDir: string;
let originalCwd: () => string;
let originalHome: () => string;

const mockServerData = new Map<string, Record<string, unknown>[]>();
const ORIGINAL_FETCH = globalThis.fetch;

async function createTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `drone-migration-owned-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createOwnedSkillFile(
  baseDir: string,
  personaId: string,
  id: string
): Promise<string> {
  const dir = path.join(baseDir, '.drone-agent', 'personas', personaId, 'skills');
  await mkdir(dir, { recursive: true });
  const content = `---
name: ${id}
description: 'Owned by ${personaId}.'
recall:
  - Test recall condition
---

# ${id}

Owned skill body.`;
  const filePath = path.join(dir, `${id}.md`);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

function setupMockFetch() {
  mockServerData.clear();
  globalThis.fetch = vi.fn(
    async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      const method = options?.method ?? 'GET';
      const parsedUrl = new URL(urlStr);
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

      if (method === 'GET' && pathParts.length === 1) {
        const data = mockServerData.get(pathParts[0]) ?? [];
        return new Response(JSON.stringify(data), { status: 200 });
      }
      if (method === 'GET' && pathParts.length === 2) {
        const data = mockServerData.get(pathParts[0]) ?? [];
        const item = data.find(d => d.id === pathParts[1]);
        return item
          ? new Response(JSON.stringify(item), { status: 200 })
          : new Response(JSON.stringify({ error: 'Not found' }), {
              status: 404,
            });
      }
      if (method === 'POST' && pathParts.length === 1) {
        const type = pathParts[0];
        const body = options?.body ? JSON.parse(options.body as string) : {};
        if (!mockServerData.has(type)) mockServerData.set(type, []);
        mockServerData.get(type)!.push(body);
        return new Response(JSON.stringify(body), { status: 201 });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
      });
    }
  );
}

describe('Migration — persona-owned skills', () => {
  beforeEach(async () => {
    projectDir = await createTempDir();
    userDir = await createTempDir();
    originalCwd = process.cwd;
    originalHome = os.homedir;
    process.cwd = () => projectDir;
    os.homedir = () => userDir;
    setupMockFetch();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    os.homedir = originalHome;
    globalThis.fetch = ORIGINAL_FETCH;
    await rm(projectDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  it('lists persona-owned skills with their owner', async () => {
    await createOwnedSkillFile(projectDir, 'alice', 'deploy');
    const assets = await listAllAssets('localhost', 9999);
    const owned = assets.filter(
      a => a.type === 'skill' && a.personaId === 'alice'
    );
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe('deploy');
  });

  it('carries personaId through a promote to the beacon', async () => {
    await createOwnedSkillFile(projectDir, 'alice', 'deploy');
    const result = await migrateAsset({
      type: 'skill',
      id: 'deploy',
      personaId: 'alice',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });
    expect(result.success).toBe(true);
    const posted = mockServerData.get('skills')!.find(s => s.id === 'deploy')!;
    expect(posted.personaId).toBe('alice');
  });

  it('writes a pulled owned skill to the nested persona path', async () => {
    mockServerData.set('skills', [
      {
        id: 'deploy',
        name: 'Deploy',
        description: 'Owned',
        body: 'Owned body',
        scope: 'coordinator',
        personaId: 'alice',
      },
    ]);

    const result = await migrateAsset({
      type: 'skill',
      id: 'deploy',
      pull: true,
      scope: 'coordinator',
      to: 'project',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);
    const nested = path.join(
      projectDir,
      '.drone-agent',
      'personas',
      'alice',
      'skills',
      'deploy.md'
    );
    const content = await readFile(nested, 'utf-8');
    expect(content).toContain('Owned body');
  });

  it('writes a pulled global skill to the flat skills path', async () => {
    mockServerData.set('skills', [
      {
        id: 'plain',
        name: 'Plain',
        description: 'Global',
        body: 'Global body',
        scope: 'coordinator',
        personaId: null,
      },
    ]);

    const result = await migrateAsset({
      type: 'skill',
      id: 'plain',
      pull: true,
      scope: 'coordinator',
      to: 'project',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);
    const flat = path.join(
      projectDir,
      '.drone-agent',
      'skills',
      'plain.md'
    );
    expect(await readFile(flat, 'utf-8')).toContain('Global body');
  });
});

describe('Migrate CLI — --persona-id', () => {
  it('parses --persona-id', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs([
      'migrate',
      '--type',
      'skill',
      '--id',
      'deploy',
      '--persona-id',
      'alice',
      '--to',
      'beacon',
    ]);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.personaId).toBe('alice');
    }
  });
});
