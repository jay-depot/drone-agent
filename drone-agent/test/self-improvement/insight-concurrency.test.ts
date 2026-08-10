import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { insightFilePath, principleFilePath, createEngine } from './setup.js';

describe('self-improvement concurrent file writes', () => {
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

  it('preserves all insights when recording concurrently to the same project file', async () => {
    const engine = await createEngine();
    const count = 20;

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.executeTool('self-improvement__insight', {
          action: 'record',
          targetType: 'project',
          targetId: 'architecture',
          insight: `Concurrent insight ${i}`,
        })
      )
    );

    for (const result of results) {
      expect(JSON.parse(result).ok).toBe(true);
    }

    const filePath = insightFilePath(tmpDir, 'project', 'architecture');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(count);

    const insights = entries.map((e: { insight: string }) => e.insight);
    for (let i = 0; i < count; i++) {
      expect(insights).toContain(`Concurrent insight ${i}`);
    }
  });

  it('preserves all principles when storing concurrently to the same project file', async () => {
    const engine = await createEngine();
    const count = 20;

    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.executeTool('self-improvement__principle', {
          action: 'store',
          targetType: 'project',
          targetId: 'testing',
          principle: `Concurrent principle ${i}`,
        })
      )
    );

    for (const result of results) {
      expect(JSON.parse(result).ok).toBe(true);
    }

    const filePath = principleFilePath(tmpDir, 'project', 'testing');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(count);

    const principles = entries.map((e: { principle: string }) => e.principle);
    for (let i = 0; i < count; i++) {
      expect(principles).toContain(`Concurrent principle ${i}`);
    }
  });

  it('keeps the principles file valid JSON when store and delete run concurrently', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'workflow',
      principle: 'Seeded principle.',
    });

    await Promise.all([
      engine.executeTool('self-improvement__principle', {
        action: 'store',
        targetType: 'project',
        targetId: 'workflow',
        principle: 'Added concurrently.',
      }),
      engine.executeTool('self-improvement__principle', {
        action: 'delete',
        targetType: 'project',
        targetId: 'workflow',
        index: 0,
      }),
    ]);

    const filePath = principleFilePath(tmpDir, 'project', 'workflow');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
