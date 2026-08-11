import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createEngine, insightFilePath } from './setup.js';

describe('self-improvement mark_examined tool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `self-improvement-mark-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('is registered but hidden by default (absent from listTools)', async () => {
    const engine = await createEngine();
    const tools = engine.listTools();
    expect(tools.some(t => t.name === 'self-improvement__mark_examined')).toBe(
      false
    );
  });

  it('sets lastExamined on all insights for a target when invoked', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'persona',
      targetId: 'reflect',
      insight: 'First insight.',
    });
    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'persona',
      targetId: 'reflect',
      insight: 'Second insight.',
    });

    const result = await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'persona',
      targetId: 'reflect',
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.markedCount).toBe(2);

    const filePath = insightFilePath(tmpDir, 'persona', 'reflect');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.lastExamined).toBeDefined();
      expect(typeof entry.lastExamined).toBe('string');
    }
  });

  it('returns markedCount 0 for a target with no insights', async () => {
    const engine = await createEngine();
    const result = await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'persona',
      targetId: 'reflect',
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.markedCount).toBe(0);
  });

  it('overwrites lastExamined on re-mark', async () => {
    const engine = await createEngine();
    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'skill',
      targetId: 'testing',
      insight: 'Insight.',
    });

    await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'skill',
      targetId: 'testing',
    });

    const filePath = insightFilePath(tmpDir, 'skill', 'testing');
    const firstRaw = await readFile(filePath, 'utf-8');
    const firstEntries = JSON.parse(firstRaw);
    const firstLastExamined = firstEntries[0].lastExamined;

    // A short delay so the second "now" differs on coarse clocks.
    await new Promise(r => setTimeout(r, 5));
    await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'skill',
      targetId: 'testing',
    });

    const secondRaw = await readFile(filePath, 'utf-8');
    const secondEntries = JSON.parse(secondRaw);
    expect(secondEntries[0].lastExamined).toBeDefined();
    expect(secondEntries[0].lastExamined).not.toBe(firstLastExamined);
  });

  it('leaves newly recorded insights unexamined after a mark', async () => {
    const engine = await createEngine();
    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'project',
      targetId: 'drone-agent',
      insight: 'Old insight.',
    });
    await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'project',
      targetId: 'drone-agent',
    });

    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'project',
      targetId: 'drone-agent',
      insight: 'New insight.',
    });

    const filePath = insightFilePath(tmpDir, 'project', 'drone-agent');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].lastExamined).toBeDefined();
    expect(entries[1].lastExamined).toBeUndefined();
  });

  it('recall surfaces lastExamined on entries', async () => {
    const engine = await createEngine();
    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'persona',
      targetId: 'reflect',
      insight: 'Insight.',
    });
    await engine.executeTool('self-improvement__mark_examined', {
      targetType: 'persona',
      targetId: 'reflect',
    });

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'recall',
      targetType: 'persona',
      targetId: 'reflect',
    });
    const parsed = JSON.parse(result);
    expect(parsed.entries[0].lastExamined).toBeDefined();
  });
});
