import { describe, expect, it, vi } from 'vitest';
import { loadPersonas } from '../src/plugins/persona/loader.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';

async function withProjectDir<T>(
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-personas-'));
  try {
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'fake-home'));
    return await fn(dir);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('loadPersonas — color field', () => {
  it('parses `color:` from persona frontmatter', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'researcher.md'),
        [
          '---',
          'name: Researcher',
          'description: investigative',
          'color: cyan',
          '---',
          'You investigate thoroughly.',
          '',
        ].join('\n'),
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.size).toBe(1);
      const p = personas.get('researcher');
      expect(p?.uiColor).toBe('cyan');
    });
  });

  it('parses hex colors', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'reviewer.md'),
        '---\nname: Reviewer\ncolor: "#ff8800"\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('reviewer')?.uiColor).toBe('#ff8800');
    });
  });

  it('accepts `uiColor` and `tint` aliases', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'a.md'),
        '---\nuiColor: red\n---\n',
        'utf-8'
      );
      await writeFile(
        path.join(personaDir, 'b.md'),
        '---\ntint: magenta\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('a')?.uiColor).toBe('red');
      expect(personas.get('b')?.uiColor).toBe('magenta');
    });
  });

  it('leaves uiColor undefined when the persona omits the field', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'plain.md'),
        '---\nname: Plain\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('plain')?.uiColor).toBeUndefined();
    });
  });
});
