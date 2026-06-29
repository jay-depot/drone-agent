import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// We'll test the migration service functions directly
import {
  listAllAssets,
  migrateAsset,
  batchMigrate,
  resolveBeaconAddress,
  type MigrateOptions,
  type AssetType,
  type MigrateScope,
} from '../src/runtime/migration-service.js';

// ── Test helpers ────────────────────────────────────────────────────────

let projectDir: string;
let userDir: string;

async function createTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `drone-migration-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createPersonaFile(baseDir: string, id: string, name?: string, description?: string): Promise<string> {
  const personaDir = path.join(baseDir, '.drone-agent', 'personas', id);
  await mkdir(personaDir, { recursive: true });
  const content = `---
name: ${name ?? id}
description: ${description ?? `Test persona ${id}`}
---

This is the system prompt for ${id}.`;
  const filePath = path.join(personaDir, 'persona.md');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function createSkillFile(baseDir: string, id: string, name?: string, description?: string): Promise<string> {
  const skillsDir = path.join(baseDir, '.drone-agent', 'skills');
  await mkdir(skillsDir, { recursive: true });
  const content = `---
name: ${name ?? id}
description: ${description ?? `Test skill ${id}`}
recall:
  - Test recall condition
---

# ${name ?? id}

This is the body of skill ${id}.`;
  const filePath = path.join(skillsDir, `${id}.md`);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function createInsightFile(baseDir: string, targetType: string, targetId: string): Promise<string> {
  const insightsDir = path.join(baseDir, '.drone-agent', 'insights', targetType);
  await mkdir(insightsDir, { recursive: true });
  const insights = [
    { targetType, targetId, insight: 'Test insight 1' },
    { targetType, targetId, insight: 'Test insight 2' },
  ];
  const filePath = path.join(insightsDir, `${targetId}.json`);
  await writeFile(filePath, JSON.stringify(insights, null, 2), 'utf-8');
  return filePath;
}

async function createPrincipleFile(baseDir: string, targetType: string, targetId: string): Promise<string> {
  const principlesDir = path.join(baseDir, '.drone-agent', 'principles', targetType);
  await mkdir(principlesDir, { recursive: true });
  const principles = [
    { targetType, targetId, principle: 'Test principle 1', source: 'test' },
    { targetType, targetId, principle: 'Test principle 2', source: 'test' },
  ];
  const filePath = path.join(principlesDir, `${targetId}.json`);
  await writeFile(filePath, JSON.stringify(principles, null, 2), 'utf-8');
  return filePath;
}

// ── Mock fetch ─────────────────────────────────────────────────────────

const mockServerData = new Map<string, Record<string, unknown>[]>();

function setupMockFetch() {
  mockServerData.clear();

  globalThis.fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : String(url);
    const method = options?.method ?? 'GET';

    // Parse URL
    const parsedUrl = new URL(urlStr);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

    // GET /personas, /skills, /insights, /principles, /wiki
    if (method === 'GET' && pathParts.length === 1) {
      const type = pathParts[0];
      const data = mockServerData.get(type) ?? [];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // GET /:type/:id
    if (method === 'GET' && pathParts.length === 2) {
      const type = pathParts[0];
      const id = pathParts[1];
      const data = mockServerData.get(type) ?? [];
      const item = data.find(d => d.id === id);
      if (item) {
        return new Response(JSON.stringify(item), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }

    // POST /:type
    if (method === 'POST' && pathParts.length === 1) {
      const type = pathParts[0];
      const body = options?.body ? JSON.parse(options.body as string) : {};
      if (!mockServerData.has(type)) {
        mockServerData.set(type, []);
      }
      const data = mockServerData.get(type)!;
      data.push({ ...body, id: body.id ?? randomUUID() });
      return new Response(JSON.stringify(body), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }

    // DELETE /:type/:id
    if (method === 'DELETE' && pathParts.length === 2) {
      const type = pathParts[0];
      const id = pathParts[1];
      const data = mockServerData.get(type) ?? [];
      const idx = data.findIndex(d => d.id === id);
      if (idx >= 0) {
        data.splice(idx, 1);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }

    // PUT /wiki/:id
    if (method === 'PUT' && pathParts.length === 2) {
      const type = pathParts[0];
      const id = pathParts[1];
      const body = options?.body ? JSON.parse(options.body as string) : {};
      if (!mockServerData.has(type)) {
        mockServerData.set(type, []);
      }
      const data = mockServerData.get(type)!;
      const idx = data.findIndex(d => d.id === id);
      if (idx >= 0) {
        data[idx] = { ...data[idx], ...body };
      } else {
        data.push({ ...body, id });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  });
}

function teardownMockFetch() {
  delete (globalThis as any).fetch;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Migration Service', () => {
  let originalCwd: () => string;
  let originalHome: () => string;

  beforeEach(async () => {
    projectDir = await createTempDir();
    userDir = await createTempDir();
    originalCwd = process.cwd;
    originalHome = os.homedir;
    // Override cwd and homedir to use separate temp dirs
    process.cwd = () => projectDir;
    (os as any).homedir = () => userDir;
    setupMockFetch();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    (os as any).homedir = originalHome;
    teardownMockFetch();
    await rm(projectDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  // ── listAllAssets ──────────────────────────────────────────────────

  it('should list local personas and skills', async () => {
    await createPersonaFile(projectDir, 'coder', 'Coder', 'A coding persona');
    await createSkillFile(projectDir, 'deploy-helm', 'Deploy Helm', 'Deploy with Helm');

    const assets = await listAllAssets('localhost', 9999); // beacon unreachable, only local

    const personas = assets.filter(a => a.type === 'persona');
    const skills = assets.filter(a => a.type === 'skill');

    expect(personas).toHaveLength(1);
    expect(personas[0].id).toBe('coder');
    expect(personas[0].name).toBe('Coder');

    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('deploy-helm');
    expect(skills[0].name).toBe('Deploy Helm');
  });

  it('should list local insights and principles', async () => {
    await createInsightFile(projectDir, 'project', 'test-project');
    await createPrincipleFile(projectDir, 'project', 'test-project');

    const assets = await listAllAssets('localhost', 9999);

    const insights = assets.filter(a => a.type === 'insight');
    const principles = assets.filter(a => a.type === 'principle');

    expect(insights).toHaveLength(1);
    expect(insights[0].id).toBe('test-project');

    expect(principles).toHaveLength(1);
    expect(principles[0].id).toBe('test-project');
  });

  it('should list beacon assets when reachable', async () => {
    // Seed mock server
    mockServerData.set('personas', [
      { id: 'swarm-persona', name: 'Swarm Persona', description: 'From swarm', scope: 'beacon' },
    ]);
    mockServerData.set('skills', [
      { id: 'swarm-skill', name: 'Swarm Skill', description: 'From swarm', scope: 'coordinator' },
    ]);

    const assets = await listAllAssets('localhost', 9999);

    const personas = assets.filter(a => a.type === 'persona');
    const skills = assets.filter(a => a.type === 'skill');

    expect(personas.some(p => p.id === 'swarm-persona')).toBe(true);
    expect(skills.some(s => s.id === 'swarm-skill')).toBe(true);
  });

  // ── promoteAsset ───────────────────────────────────────────────────

  it('should promote a persona from project to beacon', async () => {
    await createPersonaFile(projectDir, 'test-persona', 'Test Persona', 'A test persona');

    const result = await migrateAsset({
      type: 'persona',
      id: 'test-persona',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);
    expect(result.assetType).toBe('persona');
    expect(result.assetId).toBe('test-persona');
    expect(result.fromScope).toBe('project');
    expect(result.toScope).toBe('beacon');

    // Verify it was posted to the beacon
    const beaconPersonas = mockServerData.get('personas') ?? [];
    expect(beaconPersonas.some(p => p.id === 'test-persona')).toBe(true);
  });

  it('should promote a skill from user to beacon', async () => {
    await createSkillFile(userDir, 'test-skill', 'Test Skill', 'A test skill');

    const result = await migrateAsset({
      type: 'skill',
      id: 'test-skill',
      from: 'user',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);

    const beaconSkills = mockServerData.get('skills') ?? [];
    expect(beaconSkills.some(s => s.id === 'test-skill')).toBe(true);
  });

  it('should promote a persona to coordinator scope', async () => {
    await createPersonaFile(projectDir, 'coord-persona', 'Coord Persona', 'For coordinator');

    const result = await migrateAsset({
      type: 'persona',
      id: 'coord-persona',
      from: 'project',
      to: 'coordinator',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);
    expect(result.toScope).toBe('coordinator');
  });

  // ── --move ─────────────────────────────────────────────────────────

  it('should delete source when --move is set', async () => {
    const filePath = await createPersonaFile(projectDir, 'move-test', 'Move Test', 'Will be moved');

    const result = await migrateAsset({
      type: 'persona',
      id: 'move-test',
      from: 'project',
      to: 'beacon',
      move: true,
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);

    // Source file should be deleted
    await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
  });

  it('should keep source when --move is not set', async () => {
    const filePath = await createPersonaFile(projectDir, 'copy-test', 'Copy Test', 'Will be copied');

    const result = await migrateAsset({
      type: 'persona',
      id: 'copy-test',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);

    // Source file should still exist
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('Copy Test');
  });

  // ── --backup-to ────────────────────────────────────────────────────

  it('should backup asset when --backup-to is set', async () => {
    await createPersonaFile(projectDir, 'backup-test', 'Backup Test', 'Will be backed up');
    const backupPath = path.join(projectDir, 'backups', 'backup-test.md');

    const result = await migrateAsset({
      type: 'persona',
      id: 'backup-test',
      from: 'project',
      to: 'beacon',
      backupTo: backupPath,
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);

    // Backup file should exist
    const backupContent = await readFile(backupPath, 'utf-8');
    expect(backupContent).toContain('Backup Test');
  });

  // ── --pull (demote) ────────────────────────────────────────────────

  it('should pull a persona from beacon to local project', async () => {
    // Seed mock server with a persona
    mockServerData.set('personas', [
      { id: 'swarm-persona', name: 'Swarm Persona', description: 'From swarm', systemPrompt: 'Swarm system prompt', scope: 'beacon' },
    ]);

    const result = await migrateAsset({
      type: 'persona',
      id: 'swarm-persona',
      pull: true,
      scope: 'beacon',
      to: 'project',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);
    expect(result.fromScope).toBe('beacon');
    expect(result.toScope).toBe('project');

    // Verify it was written locally
    const personaFile = path.join(projectDir, '.drone-agent', 'personas', 'swarm-persona', 'persona.md');
    const content = await readFile(personaFile, 'utf-8');
    expect(content).toContain('Swarm Persona');
    expect(content).toContain('Swarm system prompt');
  });

  it('should pull a skill from coordinator to local user', async () => {
    mockServerData.set('skills', [
      { id: 'coord-skill', name: 'Coord Skill', description: 'From coordinator', body: 'Skill body', scope: 'coordinator' },
    ]);

    const result = await migrateAsset({
      type: 'skill',
      id: 'coord-skill',
      pull: true,
      scope: 'coordinator',
      to: 'user',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(true);

    const skillFile = path.join(userDir, '.drone-agent', 'skills', 'coord-skill.md');
    const content = await readFile(skillFile, 'utf-8');
    expect(content).toContain('Coord Skill');
    expect(content).toContain('Skill body');
  });

  // ── Batch ──────────────────────────────────────────────────────────

  it('should batch promote all personas from project to beacon', async () => {
    await createPersonaFile(projectDir, 'persona-a', 'Persona A', 'First');
    await createPersonaFile(projectDir, 'persona-b', 'Persona B', 'Second');

    const results = await batchMigrate({
      type: 'persona',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);

    const beaconPersonas = mockServerData.get('personas') ?? [];
    expect(beaconPersonas.some(p => p.id === 'persona-a')).toBe(true);
    expect(beaconPersonas.some(p => p.id === 'persona-b')).toBe(true);
  });

  it('should batch promote all skills from user to beacon', async () => {
    await createSkillFile(userDir, 'skill-a', 'Skill A', 'First');
    await createSkillFile(userDir, 'skill-b', 'Skill B', 'Second');

    const results = await batchMigrate({
      type: 'skill',
      from: 'user',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });

  // ── Error cases ───────────────────────────────────────────────────

  it('should return error when local asset not found', async () => {
    const result = await migrateAsset({
      type: 'persona',
      id: 'nonexistent',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error when beacon asset not found for pull', async () => {
    const result = await migrateAsset({
      type: 'persona',
      id: 'nonexistent',
      pull: true,
      scope: 'beacon',
      to: 'project',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error for wiki pages with local scopes', async () => {
    const result = await migrateAsset({
      type: 'wiki',
      id: 'test-page',
      from: 'project',
      to: 'beacon',
      beaconHost: 'localhost',
      beaconPort: 9999,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('server-to-server only');
  });

  // ── resolveBeaconAddress ──────────────────────────────────────────

  it('should resolve beacon address from config', () => {
    const config = {
      swarm: {
        knowledgeSync: { enabled: true, pushInsights: true, pullOnStartup: true, pullIntervalMinutes: 60 },
        beaconHost: 'my-beacon',
        beaconPort: 3457,
      },
    } as any;

    const addr = resolveBeaconAddress(config);
    expect(addr).toEqual({ host: 'my-beacon', port: 3457 });
  });

  it('should prefer CLI overrides over config', () => {
    const config = {
      swarm: {
        knowledgeSync: { enabled: true, pushInsights: true, pullOnStartup: true, pullIntervalMinutes: 60 },
        beaconHost: 'config-host',
        beaconPort: 3457,
      },
    } as any;

    const addr = resolveBeaconAddress(config, 'cli-host', 9999);
    expect(addr).toEqual({ host: 'cli-host', port: 9999 });
  });

  it('should return null when no beacon config', () => {
    const config = {
      swarm: {
        knowledgeSync: { enabled: true, pushInsights: true, pullOnStartup: true, pullIntervalMinutes: 60 },
      },
    } as any;

    const addr = resolveBeaconAddress(config);
    expect(addr).toBeNull();
  });
});

// ── CLI parsing tests ──────────────────────────────────────────────────

describe('Migrate CLI parsing', () => {
  it('should parse migrate subcommand with --list', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--list']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.list).toBe(true);
    }
  });

  it('should parse migrate subcommand with type and id', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--type', 'persona', '--id', 'my-persona', '--to', 'beacon']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.type).toBe('persona');
      expect(result.migrateOptions.id).toBe('my-persona');
      expect(result.migrateOptions.to).toBe('beacon');
    }
  });

  it('should parse migrate subcommand with --pull and --scope', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--pull', '--type', 'skill', '--scope', 'coordinator', '--to', 'user']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.pull).toBe(true);
      expect(result.migrateOptions.type).toBe('skill');
      expect(result.migrateOptions.scope).toBe('coordinator');
      expect(result.migrateOptions.to).toBe('user');
    }
  });

  it('should parse migrate subcommand with --move and --backup-to', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--type', 'persona', '--id', 'p1', '--to', 'beacon', '--move', '--backup-to', '/tmp/backup.md']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.move).toBe(true);
      expect(result.migrateOptions.backupTo).toBe('/tmp/backup.md');
    }
  });

  it('should parse migrate subcommand with --beacon-host and --beacon-port', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--list', '--beacon-host', '10.0.0.1', '--beacon-port', '8080']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.beaconHost).toBe('10.0.0.1');
      expect(result.migrateOptions.beaconPort).toBe(8080);
    }
  });

  it('should parse batch migrate with --from', async () => {
    const { parseCliArgs } = await import('../src/cli.js');
    const result = parseCliArgs(['migrate', '--type', 'persona', '--from', 'user', '--to', 'beacon']);
    expect(result.kind).toBe('migrate');
    if (result.kind === 'migrate') {
      expect(result.migrateOptions.type).toBe('persona');
      expect(result.migrateOptions.from).toBe('user');
      expect(result.migrateOptions.to).toBe('beacon');
    }
  });
});
