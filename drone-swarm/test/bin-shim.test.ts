import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realShim = path.join(pkgDir, 'bin', 'drone-swarm');
const distIndex = path.join(pkgDir, 'dist', 'index.js');

describe('drone-swarm bin shim (symlinked invocation)', () => {
  let linkDir: string;

  beforeAll(async () => {
    linkDir = await mkdtemp(path.join(os.tmpdir(), 'drone-swarm-bin-'));
    await symlink(realShim, path.join(linkDir, 'drone-swarm'));
  });

  afterAll(async () => {
    await rm(linkDir, { recursive: true, force: true });
  });

  // Requires built dist; the root vitest run compiles nothing, so this
  // skips pre-build and exercises the real linked invocation post-build.
  it.skipIf(!existsSync(distIndex))(
    'runs main() through the link symlink',
    async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(linkDir, 'drone-swarm'),
        '--help',
      ]);
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('drone-swarm');
    }
  );

  it('is executable with a node shebang', async () => {
    await access(realShim, constants.X_OK);
    const content = await readFile(realShim, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
