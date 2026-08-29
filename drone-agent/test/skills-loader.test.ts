/**
 * Unit coverage for the skill .md loader's remark frontmatter field.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir } from '../src/plugins/skills/loader.js';

async function withSkillsDir(
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-skills-loader-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSkillFile(
  dir: string,
  id: string,
  md: string
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), md, 'utf-8');
}

describe('skills loader — remark field', () => {
  it('parses remark from frontmatter', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'grilling',
        `---
name: grilling
description: 'Interview the user relentlessly.'
recall:
  - grill triggers
model-invocation: true
remark: 'All credit to Matt Pocock. I just ported it.'
---

Interview me relentlessly.
`
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      expect(skills).toHaveLength(1);
      expect(skills[0].remark).toBe(
        'All credit to Matt Pocock. I just ported it.'
      );
    });
  });

  it('strips surrounding single and double quotes', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'single',
        "---\nname: single\nremark: 'quoted'\n---\nbody\n"
      );
      await writeSkillFile(
        dir,
        'double',
        '---\nname: double\nremark: "quoted"\n---\nbody\n'
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      const byId = new Map(skills.map(s => [s.id, s]));
      expect(byId.get('single')?.remark).toBe('quoted');
      expect(byId.get('double')?.remark).toBe('quoted');
    });
  });

  it('leaves remark undefined when the field is absent', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'plain',
        "---\nname: plain\ndescription: 'x'\n---\nbody\n"
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      expect(skills[0].remark).toBeUndefined();
    });
  });

  it('leaves remark undefined for an empty value', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'empty',
        '---\nname: empty\nremark:\n---\nbody\n'
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      expect(skills[0].remark).toBeUndefined();
    });
  });

  it('does not corrupt recall parsing when remark follows it', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'interleaved',
        `---
name: interleaved
description: 'x'
recall:
  - condition one
  - condition two
remark: 'author note'
---
body
`
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      expect(skills[0].recall).toEqual(['condition one', 'condition two']);
      expect(skills[0].remark).toBe('author note');
    });
  });

  it('still ignores unknown frontmatter keys', async () => {
    await withSkillsDir(async dir => {
      await writeSkillFile(
        dir,
        'unknown',
        "---\nname: unknown\ndescription: 'x'\nbogus-key: nope\n---\nbody\n"
      );
      const skills = await loadSkillsFromDir(dir, 'project');
      expect(
        (skills[0] as unknown as Record<string, unknown>)['bogus-key']
      ).toBeUndefined();
      expect(skills[0].remark).toBeUndefined();
    });
  });
});
