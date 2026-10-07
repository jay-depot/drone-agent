import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { withFileLock, withPathLock } from '../../src/shared/file-lock.js';
import { registerFilePlugin } from './setup.js';

function tempPath(prefix: string): string {
  return path.join(
    tmpdir(),
    `drone-agent-${prefix}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.txt`
  );
}

describe('withFileLock / withPathLock', () => {
  it('serializes same-key tasks and never overlaps them', async () => {
    let active = 0;
    let maxActive = 0;
    const task = (): Promise<void> =>
      withFileLock('concurrency-test-key-a', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it('lets different keys run in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const task = (key: string): Promise<void> =>
      withFileLock(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([
      task('concurrency-test-key-b1'),
      task('concurrency-test-key-b2'),
    ]);
    expect(maxActive).toBe(2);
  });

  it('releases the key when a task throws', async () => {
    await expect(
      withFileLock('concurrency-test-key-c', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(
      withFileLock('concurrency-test-key-c', async () => 'ok')
    ).resolves.toBe('ok');
  });

  it('withPathLock collapses dot-segments and case variants of one path', async () => {
    const order: string[] = [];
    await Promise.all([
      withPathLock('/tmp/A/../a.ts', async () => {
        order.push('first');
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push('first-done');
      }),
      withPathLock('/tmp/a.TS', async () => {
        order.push('second');
      }),
    ]);
    // Same normalized key → the second task waits for the first to finish.
    expect(order).toEqual(['first', 'first-done', 'second']);
  });
});

describe('file tools — same-path serialization', () => {
  it('preserves every concurrent apply_diff to the same file', async () => {
    const { tools } = await registerFilePlugin();
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = tempPath('race-apply');
    await writeFile(target, 'START\nEND\n', 'utf-8');
    try {
      const count = 6;
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          applyDiff!({
            path: target,
            patch: `@@ -1,2 +1,3 @@\n START\n+item_${i}\n END`,
          })
        )
      );

      const content = await readFile(target, 'utf-8');
      for (let i = 0; i < count; i++) {
        expect(content).toContain(`item_${i}`);
      }
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('reports verified: true for every concurrent write to the same file', async () => {
    const { tools } = await registerFilePlugin();
    const write = tools.get('write');
    expect(write).toBeDefined();

    const target = tempPath('race-write');
    await writeFile(target, 'seed\n', 'utf-8');
    try {
      const count = 8;
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          write!({ path: target, content: `payload_${i}\n` })
        )
      );

      for (const result of results) {
        expect(JSON.parse(result).verified).toBe(true);
      }
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('applies concurrent apply_diff calls to different files independently', async () => {
    const { tools } = await registerFilePlugin();
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const count = 4;
    const targets = Array.from({ length: count }, (_, i) =>
      tempPath(`race-distinct-${i}`)
    );
    try {
      await Promise.all(
        targets.map(target => writeFile(target, 'START\nEND\n', 'utf-8'))
      );

      await Promise.all(
        targets.map((target, i) =>
          applyDiff!({
            path: target,
            patch: `@@ -1,2 +1,3 @@\n START\n+only_${i}\n END`,
          })
        )
      );

      for (let i = 0; i < count; i++) {
        const content = await readFile(targets[i], 'utf-8');
        expect(content).toContain(`only_${i}`);
      }
    } finally {
      const { unlink } = await import('node:fs/promises');
      await Promise.all(targets.map(t => unlink(t).catch(() => {})));
    }
  });

  it('serializes a concurrent write + apply_diff on the same path', async () => {
    const { tools } = await registerFilePlugin();
    const write = tools.get('write');
    const applyDiff = tools.get('apply_diff');
    expect(write).toBeDefined();
    expect(applyDiff).toBeDefined();

    const target = tempPath('race-mixed');
    await writeFile(target, 'START\nEND\n', 'utf-8');
    try {
      await Promise.all([
        write!({ path: target, content: 'START\nWRITTEN\nEND\n' }),
        applyDiff!({
          path: target,
          patch: '@@ -1,2 +1,3 @@\n START\n+patched\n END',
        }),
      ]);

      // The file must be exactly one coherent version — no interleaved bytes.
      const content = await readFile(target, 'utf-8');
      const coherent = [
        'START\nWRITTEN\nEND\n',
        'START\npatched\nEND\n',
        'START\nWRITTEN\npatched\nEND\n',
        'START\npatched\nWRITTEN\nEND\n',
      ];
      expect(coherent).toContain(content);
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });
});
