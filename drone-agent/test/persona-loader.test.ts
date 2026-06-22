import { describe, expect, it, vi } from 'vitest';
import { loadPersonas, parsePersonaMd } from '../src/plugins/persona/loader.js';
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

describe('loadPersonas — scope field', () => {
  it('sets scope to "user" for personas in the user directory', async () => {
    await withProjectDir(async dir => {
      const userPersonaDir = path.join(os.homedir(), '.drone-agent', 'personas');
      await mkdir(userPersonaDir, { recursive: true });
      await writeFile(
        path.join(userPersonaDir, 'coder.md'),
        '---\nname: Coder\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('coder')?.scope).toBe('user');
    });
  });

  it('sets scope to "project" for personas in the project directory', async () => {
    await withProjectDir(async dir => {
      const projectPersonaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(projectPersonaDir, { recursive: true });
      await writeFile(
        path.join(projectPersonaDir, 'reviewer.md'),
        '---\nname: Reviewer\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('reviewer')?.scope).toBe('project');
    });
  });

  it('project persona overrides user persona but keeps project scope', async () => {
    await withProjectDir(async dir => {
      const userPersonaDir = path.join(os.homedir(), '.drone-agent', 'personas');
      await mkdir(userPersonaDir, { recursive: true });
      await writeFile(
        path.join(userPersonaDir, 'shared.md'),
        '---\nname: Shared User\n---\n',
        'utf-8'
      );

      const projectPersonaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(projectPersonaDir, { recursive: true });
      await writeFile(
        path.join(projectPersonaDir, 'shared.md'),
        '---\nname: Shared Project\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      const p = personas.get('shared');
      expect(p?.name).toBe('Shared Project');
      expect(p?.scope).toBe('project');
    });
  });

  it('scope is undefined when parsePersonaMd is called directly (no scope)', () => {
    const p = parsePersonaMd('test', '---\nname: Test\n---\n');
    expect(p.scope).toBeUndefined();
  });
});

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

describe('loadPersonas — skills field', () => {
  it('parses `skills:` from persona frontmatter', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'expert.md'),
        [
          '---',
          'name: Expert',
          'description: domain expert',
          'skills:',
          '  - code-review',
          '  - security-audit',
          '---',
          'You are an expert.',
          '',
        ].join('\n'),
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.size).toBe(1);
      const p = personas.get('expert');
      expect(p?.skillIds).toEqual(['code-review', 'security-audit']);
    });
  });

  it('leaves skillIds undefined when the persona omits the field', async () => {
    await withProjectDir(async dir => {
      const personaDir = path.join(dir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      await writeFile(
        path.join(personaDir, 'plain.md'),
        '---\nname: Plain\n---\n',
        'utf-8'
      );

      const personas = await loadPersonas(dir);
      expect(personas.get('plain')?.skillIds).toBeUndefined();
    });
  });
});
