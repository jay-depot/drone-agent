import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { insightFilePath, createEngine } from './setup.js';

describe('project insights', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `self-improvement-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a project insight to .drone-agent/insights/project/<targetId>.json', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'architecture',
      insight: 'The plugin architecture should use dependency injection.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('project');
    expect(parsed.targetId).toBe('architecture');
    expect(parsed.entryCount).toBe(1);

    const filePath = insightFilePath(tmpDir, 'project', 'architecture');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].insight).toBe(
      'The plugin architecture should use dependency injection.'
    );
    expect(entries[0].timestamp).toBeDefined();
  });

  it('appends to an existing project insights file', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'workflow',
      insight: 'First insight.',
    });

    const result = await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'workflow',
      insight: 'Second insight.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.entryCount).toBe(2);

    const filePath = insightFilePath(tmpDir, 'project', 'workflow');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].insight).toBe('First insight.');
    expect(entries[1].insight).toBe('Second insight.');
  });

  it('rejects empty targetId for project insights', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insight', {
        targetType: 'project',
        targetId: '',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });

  it('rejects empty insight for project insights', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insight', {
        targetType: 'project',
        targetId: 'testing',
        insight: '',
      })
    ).rejects.toThrow(/insight must be a non-empty string/);
  });

  it('works without persona or skills plugins loaded', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'testing',
      insight: 'Works without validation.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('project');
    expect(parsed.targetId).toBe('testing');
    expect(parsed.entryCount).toBe(1);

    const filePath = insightFilePath(tmpDir, 'project', 'testing');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].insight).toBe('Works without validation.');
  });
});
