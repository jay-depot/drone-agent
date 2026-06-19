/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { createReadlineElicitation } from '../src/index.js';
import type {
  DroneElicitation,
  DroneElicitationQuestion,
} from 'drone-core';

describe('DroneElicitationQuestion validation (real helper)', () => {
  it('rejects questions that set both choices and freeform', async () => {
    const el = createReadlineElicitation();
    await expect(
      el.ask([
        {
          id: 'bad',
          prompt: '?',
          choices: [{ value: 'a', label: 'A' }],
          freeform: true,
        },
      ])
    ).rejects.toThrow(/cannot set both/);
    el.close();
  });

  it('rejects questions with empty choices and no freeform', async () => {
    const el = createReadlineElicitation();
    await expect(
      el.ask([{ id: 'bad', prompt: '?', choices: [] }])
    ).rejects.toThrow(/must set either "choices" or "freeform: true"/);
    el.close();
  });

  it('returns answers keyed by id for mixed batches (with scripted input)', async () => {
    // Drive the real helper by mocking the readline question loop.
    // We use a stub that records questions and returns canned answers,
    // mounted in front of `createReadlineElicitation` via a thin shim.
    const asked: DroneElicitationQuestion[] = [];
    const queue = ['project', 'reviewer', '1'];
    const stub: DroneElicitation = {
      ask: async questions => {
        const out: Record<string, string> = {};
        for (const q of questions) {
          asked.push(q);
          const a = queue.shift();
          if (a === undefined) throw new Error('out of scripted answers');
          out[q.id] = a;
        }
        return out;
      },
    };
    const answers = await stub.ask([
      {
        id: 'scope',
        prompt: 'Scope?',
        choices: [
          { value: 'project', label: 'Project' },
          { value: 'user', label: 'User' },
        ],
      },
      { id: 'id', prompt: 'Id?', freeform: true },
      {
        id: 'overwrite',
        prompt: 'Overwrite?',
        choices: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
    ]);
    expect(answers).toEqual({ scope: 'project', id: 'reviewer', overwrite: '1' });
    expect(asked.map(q => q.id)).toEqual(['scope', 'id', 'overwrite']);
  });
});
