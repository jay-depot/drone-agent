import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createEngine } from './setup.js';

describe('tool registration', () => {
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

  it('registers consolidated tools', async () => {
    const engine = await createEngine();
    const toolNames = engine.listTools().map(t => t.name);

    expect(toolNames).toContain('self-improvement__insight');
    expect(toolNames).toContain('self-improvement__principle');
    expect(toolNames).not.toContain('self-improvement__insights-list');
    expect(toolNames).not.toContain('self-improvement__insights-recall');
    expect(toolNames).not.toContain('self-improvement__principles-store');
    expect(toolNames).not.toContain('self-improvement__principles-list');
    expect(toolNames).not.toContain('self-improvement__principles-recall');
    expect(toolNames).not.toContain('self-improvement__principles-delete');
  });
});
