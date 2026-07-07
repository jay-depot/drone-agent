import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createEngine } from './setup.js';

describe('self-improvement__insights-list', () => {
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

  it('returns empty list when no insights exist', async () => {
    const engine = await createEngine();
    const result = await engine.executeTool(
      'self-improvement__insights-list',
      {}
    );
    const parsed = JSON.parse(result);
    expect(parsed.insights).toEqual([]);
  });

  it('lists project insights', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'architecture',
      insight: 'Architecture insight.',
    });

    const result = await engine.executeTool(
      'self-improvement__insights-list',
      {}
    );
    const parsed = JSON.parse(result);
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].targetType).toBe('project');
    expect(parsed.insights[0].targetId).toBe('architecture');
    expect(parsed.insights[0].entryCount).toBe(1);
    expect(parsed.insights[0].lastTimestamp).toBeDefined();
  });

  it('lists skill insights', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'skill',
      targetId: 'my-skill',
      insight: 'Skill insight.',
    });

    const result = await engine.executeTool(
      'self-improvement__insights-list',
      {}
    );
    const parsed = JSON.parse(result);
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].targetType).toBe('skill');
    expect(parsed.insights[0].targetId).toBe('my-skill');
  });

  it('lists persona insights', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'persona',
      targetId: 'my-persona',
      insight: 'Persona insight.',
    });

    const result = await engine.executeTool(
      'self-improvement__insights-list',
      {}
    );
    const parsed = JSON.parse(result);
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].targetType).toBe('persona');
    expect(parsed.insights[0].targetId).toBe('my-persona');
  });

  it('filters by targetType', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'arch',
      insight: 'Arch insight.',
    });
    await engine.executeTool('self-improvement__insight', {
      targetType: 'skill',
      targetId: 'test',
      insight: 'Test insight.',
    });

    const result = await engine.executeTool('self-improvement__insights-list', {
      targetType: 'project',
    });
    const parsed = JSON.parse(result);
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].targetType).toBe('project');
    expect(parsed.insights[0].targetId).toBe('arch');
  });
});

describe('self-improvement__insights-recall', () => {
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

  it('returns insights for a valid target', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'testing',
      insight: 'Test insight one.',
    });
    await engine.executeTool('self-improvement__insight', {
      targetType: 'project',
      targetId: 'testing',
      insight: 'Test insight two.',
    });

    const result = await engine.executeTool(
      'self-improvement__insights-recall',
      {
        targetType: 'project',
        targetId: 'testing',
      }
    );
    const parsed = JSON.parse(result);
    expect(parsed.targetType).toBe('project');
    expect(parsed.targetId).toBe('testing');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].insight).toBe('Test insight one.');
    expect(parsed.entries[1].insight).toBe('Test insight two.');
  });

  it('returns empty array when no insights exist', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool(
      'self-improvement__insights-recall',
      {
        targetType: 'project',
        targetId: 'nonexistent',
      }
    );
    const parsed = JSON.parse(result);
    expect(parsed.entries).toEqual([]);
  });

  it('rejects invalid targetType', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insights-recall', {
        targetType: 'invalid',
        targetId: 'foo',
      })
    ).rejects.toThrow(/Invalid targetType/);
  });

  it('rejects empty targetId', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insights-recall', {
        targetType: 'project',
        targetId: '',
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });
});
