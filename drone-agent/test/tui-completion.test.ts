/**
 * @vitest-environment node
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DronePluginEngine, DroneSkillsCapability } from 'drone-core';
import {
  detectCompletionContext,
  applyCompletion,
  listFileCandidates,
  listSlashCandidates,
  listSkillCandidates,
} from '../src/tui/completion.js';

describe('detectCompletionContext', () => {
  it('detects a slash command at message start', () => {
    const ctx = detectCompletionContext('/mod', 4);
    expect(ctx).toEqual({ kind: 'slash', tokenStart: 0, prefix: 'mod' });
  });

  it('does not treat a slash after text as a command', () => {
    expect(detectCompletionContext('hi /mod', 7).kind).toBe('none');
  });

  it('detects a file token after whitespace', () => {
    const ctx = detectCompletionContext('see @src/fo', 11);
    expect(ctx).toEqual({ kind: 'file', tokenStart: 4, prefix: 'src/fo' });
  });

  it('detects a skill token', () => {
    const ctx = detectCompletionContext('@skill:code', 11);
    expect(ctx).toEqual({ kind: 'skill', tokenStart: 0, prefix: 'code' });
  });

  it('returns none for a bare word', () => {
    expect(detectCompletionContext('hello', 5).kind).toBe('none');
  });

  it('returns none for an empty token after whitespace', () => {
    expect(detectCompletionContext('hello ', 6).kind).toBe('none');
  });

  it('uses the text before the caret only', () => {
    const ctx = detectCompletionContext('@src/foo bar', 8);
    expect(ctx).toEqual({ kind: 'file', tokenStart: 0, prefix: 'src/foo' });
  });
});

describe('applyCompletion', () => {
  it('replaces the token and repositions the caret', () => {
    const ctx = detectCompletionContext('see @src/fo', 11);
    const result = applyCompletion('see @src/fo', 11, ctx, {
      id: 'src/foo.ts',
      display: 'foo.ts',
      apply: '@src/foo.ts ',
    });
    expect(result.value).toBe('see @src/foo.ts ');
    expect(result.caret).toBe(4 + '@src/foo.ts '.length);
  });

  it('preserves text after the caret', () => {
    const ctx = detectCompletionContext('@sr', 3);
    const result = applyCompletion('@sr and more', 3, ctx, {
      id: 'src/',
      display: 'src/',
      apply: '@src/',
      reopen: true,
    });
    expect(result.value).toBe('@src/ and more');
    expect(result.caret).toBe('@src/'.length);
  });

  it('is a no-op for the none context', () => {
    const result = applyCompletion('hello', 5, { kind: 'none' }, {
      id: 'x',
      display: 'x',
      apply: 'x',
    });
    expect(result).toEqual({ value: 'hello', caret: 5 });
  });
});

describe('listSlashCandidates', () => {
  it('filters by prefix and sorts', () => {
    const engine = {
      getSlashCommands: () => [
        { command: '/model', description: 'switch model' },
        { command: '/clear', description: 'clear session' },
        { command: '/help', description: 'help' },
      ],
    } as unknown as DronePluginEngine;
    const items = listSlashCandidates('m', engine);
    expect(items.map(i => i.id)).toEqual(['/model']);
    expect(items[0].apply).toBe('/model ');
    expect(items[0].hint).toBe('switch model');
  });

  it('returns all commands for an empty prefix', () => {
    const engine = {
      getSlashCommands: () => [
        { command: '/model', description: 'm' },
        { command: '/clear', description: 'c' },
      ],
    } as unknown as DronePluginEngine;
    expect(listSlashCandidates('', engine).map(i => i.id)).toEqual([
      '/clear',
      '/model',
    ]);
  });
});

describe('listSkillCandidates', () => {
  const cap = {
    getSkills: () => [
      { id: 'code-review', description: 'review code' },
      { id: 'code-style', description: 'style' },
      { id: 'testing', description: 'test' },
    ],
  } as unknown as DroneSkillsCapability;

  it('filters by case-insensitive prefix', () => {
    const items = listSkillCandidates('CODE', cap);
    expect(items.map(i => i.id)).toEqual(['code-review', 'code-style']);
    expect(items[0].apply).toBe('@skill:code-review ');
  });

  it('returns empty when the capability is absent', () => {
    expect(listSkillCandidates('x', undefined)).toEqual([]);
  });
});

describe('listFileCandidates', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'complete-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, homedir: dir });

  it('lists directories first, then files, prefix-filtered', async () => {
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src.txt'), 'x');
    await writeFile(path.join(dir, 'other.txt'), 'x');
    const items = await listFileCandidates('s', ctx());
    expect(items.map(i => i.id)).toEqual(['src', 'src.txt']);
    expect(items[0].apply).toBe('@src/');
    expect(items[0].reopen).toBe(true);
    expect(items[1].apply).toBe('@src.txt ');
    expect(items[1].reopen).toBe(false);
  });

  it('hides dotfiles unless the prefix starts with a dot', async () => {
    await writeFile(path.join(dir, '.env'), 'x');
    await writeFile(path.join(dir, 'env.txt'), 'x');
    expect((await listFileCandidates('', ctx())).map(i => i.id)).toEqual([
      'env.txt',
    ]);
    expect((await listFileCandidates('.', ctx())).map(i => i.id)).toEqual([
      '.env',
    ]);
  });

  it('descends into a subdirectory when the prefix includes a slash', async () => {
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'foo.ts'), 'x');
    const items = await listFileCandidates('src/', ctx());
    expect(items.map(i => i.id)).toEqual(['src/foo.ts']);
    expect(items[0].apply).toBe('@src/foo.ts ');
  });

  it('returns empty for a nonexistent directory', async () => {
    expect(await listFileCandidates('nope/', ctx())).toEqual([]);
  });

  it('caps the candidate list at 50', async () => {
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x');
    }
    const items = await listFileCandidates('f', ctx());
    expect(items.length).toBe(50);
  });
});
