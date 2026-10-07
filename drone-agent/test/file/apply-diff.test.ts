import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { captureRegistration } from './setup.js';
import { filePlugin } from '../../src/plugins/file.js';

describe('file__apply_diff — round-trip integration', () => {
  it('produces correct JSON response with plain-text diff', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-diff-${Date.now()}.txt`);
    await writeFile(target, 'line1\nline2\nline3\n', 'utf-8');
    try {
      // Unified diff: change line2 -> line2_modified
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' line1',
        '-line2',
        '+line2_modified',
        ' line3',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.path).toBe(target);
      expect(result.patched).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.diff).toBeDefined();
      // Verify diff is plain text (no ANSI codes)
      expect(result.diff).not.toContain('\x1b[');
      // Verify the file was actually written
      const content = await readFile(target, 'utf-8');
      expect(content).toContain('line2_modified');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('applies a multi-hunk patch top-to-bottom', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-multi-${Date.now()}.txt`);
    await writeFile(
      target,
      [
        'def func_a():',
        '    pass',
        '',
        'def func_b():',
        '    pass',
        '',
        'def func_c():',
        '    pass',
      ].join('\n'),
      'utf-8'
    );
    try {
      // Two hunks: change func_a and func_c, leaving func_b untouched
      const patch = [
        '@@ -1,2 +1,2 @@ def func_a():',
        ' def func_a():',
        '-    pass',
        '+    return 1',
        '',
        '@@ -7,2 +7,2 @@ def func_c():',
        ' def func_c():',
        '-    pass',
        '+    return 3',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);
      expect(result.summary.hunks).toBe(2);
      // Verify both changes applied
      const content = await readFile(target, 'utf-8');
      expect(content).toContain('return 1');
      expect(content).toContain('return 3');
      // func_b() was not touched
      expect(content).toContain('def func_b():');
      // func_a and func_c no longer have pass
      expect(content).toContain('    pass'); // func_b's pass still there
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('handles insertion patch with context', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-insert-${Date.now()}.txt`);
    await writeFile(target, 'line1\nline2\n', 'utf-8');
    try {
      // Insertion after line1: use context lines to anchor
      const patch = [
        '@@ -1,2 +1,4 @@',
        ' line1',
        '+new line A',
        '+new line B',
        ' line2',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      expect(content).toContain('new line A');
      expect(content).toContain('new line B');
      expect(content).toContain('line1');
      expect(content).toContain('line2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('handles pure deletion patch', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-delete-${Date.now()}.txt`);
    await writeFile(
      target,
      ['keep1', 'discard1', 'discard2', 'keep2'].join('\n'),
      'utf-8'
    );
    try {
      // Pure deletion with context
      const patch = [
        '@@ -1,4 +1,2 @@',
        ' keep1',
        '-discard1',
        '-discard2',
        ' keep2',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      expect(content).not.toContain('discard1');
      expect(content).not.toContain('discard2');
      expect(content).toContain('keep1');
      expect(content).toContain('keep2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('handles interleaved context patch (round-trip)', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-inter-${Date.now()}.txt`);
    await writeFile(
      target,
      ['keep1', 'old1', 'keep2', 'old2', 'keep3'].join('\n'),
      'utf-8'
    );
    try {
      const patch = [
        '@@ -1,5 +1,5 @@',
        ' keep1',
        '-old1',
        '+new1',
        ' keep2',
        '-old2',
        '+new2',
        ' keep3',
      ].join('\n');

      const result = JSON.parse(await applyDiff!({ path: target, patch }));
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      // keep2 should still be present (preserved interleaved context).
      expect(content).toContain('keep1');
      expect(content).toContain('new1');
      expect(content).toContain('keep2');
      expect(content).toContain('new2');
      expect(content).toContain('keep3');
      expect(content).not.toContain('old1');
      expect(content).not.toContain('old2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('partial success: writes file with applied hunks, reports failures', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-partial-${Date.now()}.txt`);
    await writeFile(
      target,
      ['def good():', '    pass', '', 'def bad():', '    pass'].join('\n'),
      'utf-8'
    );
    try {
      // First hunk applies (context disambiguates). Second hunk fails (old code absent).
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' def good():',
        '-    pass',
        '+    return 1',
        ' ',
        '@@ -99,1 +99,1 @@',
        '-    nonexistent_old_line',
        '+    return 2',
      ].join('\n');

      let threw: Error | undefined;
      try {
        JSON.parse(await applyDiff!({ path: target, patch }));
      } catch (e) {
        threw = e as Error;
      }

      // The tool throws on failure (since not all hunks succeeded), but the
      // file should have been written with the successful hunk applied.
      expect(threw).toBeDefined();
      expect(threw!.message).toContain('failed to apply');

      const content = await readFile(target, 'utf-8');
      expect(content).toContain('return 1');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('rejects empty patch with a clear error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    // Empty patch should fail validation before reading the file
    await expect(
      applyDiff!({
        path: '/tmp/some-file.txt',
        patch: '',
      })
    ).rejects.toThrow(/patch string/);
  });

  it('rejects patch with no @@ headers with a clear error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    // Writes a real file so we reach the parser check
    const target = path.join(tmpdir(), `drone-agent-nohunks-${Date.now()}.txt`);
    await writeFile(target, 'some content\n', 'utf-8');
    try {
      await expect(
        applyDiff!({
          path: target,
          patch: 'just some text without hunk headers',
        })
      ).rejects.toThrow(/no hunks/);
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });
});
