import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyWorkingDir } from '../src/working-dir.js';

describe('applyWorkingDir', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'drone-working-dir-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when the working dir is undefined', async () => {
    await applyWorkingDir(undefined);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('changes the process working directory to an existing directory', async () => {
    const target = mkdtempSync(path.join(tmpdir(), 'drone-target-'));
    try {
      await applyWorkingDir(target);
      expect(process.cwd()).toBe(realpathSync(target));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('throws when the path does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    await expect(applyWorkingDir(missing)).rejects.toThrow(
      /--working-dir does not exist/
    );
    expect(process.cwd()).toBe(originalCwd);
  });

  it('throws when the path is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'a-file.txt');
    writeFileSync(filePath, 'hello');
    await expect(applyWorkingDir(filePath)).rejects.toThrow(
      /--working-dir is not a directory/
    );
    expect(process.cwd()).toBe(originalCwd);
  });
});
