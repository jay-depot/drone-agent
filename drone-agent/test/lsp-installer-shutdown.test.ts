import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import {
  killRunningInstalls,
  trackInstallChild,
} from '../src/plugins/lsp/installer.js';

/**
 * Spawn a node process that stays alive. When `ignoreSigterm` is set, the
 * child registers a SIGTERM ignore handler before printing READY, so a
 * SIGTERM cannot race node's bootstrap. `ready` resolves once the handler
 * (or the loop) is in place.
 */
function spawnSleeper(ignoreSigterm: boolean): {
  child: ChildProcess;
  ready: Promise<void>;
} {
  const code = ignoreSigterm
    ? 'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'
    : 'console.log("READY"); setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const ready = new Promise<void>(resolve => {
    child.stdout?.once('data', () => resolve());
  });
  return { child, ready };
}

describe('killRunningInstalls', () => {
  it('kills tracked in-flight children and resolves', async () => {
    const { child, ready } = spawnSleeper(false);
    trackInstallChild(child);
    const start = Date.now();
    await ready;
    await killRunningInstalls();
    const elapsed = Date.now() - start;
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
    // Resolved on the child's exit, not the 1s hard fallback.
    expect(elapsed).toBeLessThan(1000);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const { child, ready } = spawnSleeper(true);
    trackInstallChild(child);
    const start = Date.now();
    await ready;
    await killRunningInstalls();
    const elapsed = Date.now() - start;
    expect(child.signalCode).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('resolves immediately when no install is in flight', async () => {
    const start = Date.now();
    await killRunningInstalls();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('does not kill installs that already completed (untracked on exit)', async () => {
    const { child, ready } = spawnSleeper(false);
    trackInstallChild(child);
    await ready;
    child.kill();
    await once(child, 'exit');

    const start = Date.now();
    await killRunningInstalls();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
