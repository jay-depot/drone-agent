import { describe, expect, it, vi } from 'vitest';
import type { DroneSessionImportCapability } from 'drone-core';
import { runStartupSessionImport } from '../src/startup-import.js';

function captureLogger(): {
  logger: { info: (m: string) => void; warn: (m: string) => void };
  info: string[];
  warn: string[];
} {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    logger: {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
    },
  };
}

describe('runStartupSessionImport', () => {
  it('returns undefined when no --swarm.session-import flag is present', async () => {
    const { logger } = captureLogger();
    const getCapability = vi.fn();
    const entries = await runStartupSessionImport(getCapability, logger, {});
    expect(entries).toBeUndefined();
    expect(getCapability).not.toHaveBeenCalled();
  });

  it('runs the import and returns a terse notice entry on success', async () => {
    const { logger, info } = captureLogger();
    const runImport = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'session-import: imported 2 chunk(s) from old1',
    });
    const getCapability = <T>() => ({ runImport }) as unknown as T | undefined;

    const entries = await runStartupSessionImport(getCapability, logger, {
      'swarm.session-import': 'old1',
    });

    expect(runImport).toHaveBeenCalledWith('old1');
    expect(entries).toEqual([
      {
        id: 'startup-session-import',
        kind: 'notice',
        text: 'session-import: imported 2 chunk(s) from old1',
      },
    ]);
    expect(info).toContain('session-import: imported 2 chunk(s) from old1');
  });

  it('warns and returns a notice when the swarm capability is absent', async () => {
    const { logger, warn } = captureLogger();
    const getCapability = (() => undefined) as <T>() => T | undefined;

    const entries = await runStartupSessionImport(getCapability, logger, {
      'swarm.session-import': 'old1',
    });

    expect(warn.join(' ')).toContain('swarm plugin is unavailable');
    expect(entries?.[0].kind).toBe('notice');
    expect(entries?.[0].text).toContain('skipping import of old1');
  });

  it('returns a notice describing a failed import', async () => {
    const { logger, info } = captureLogger();
    const capability: DroneSessionImportCapability = {
      runImport: async () => ({
        ok: false,
        summary: 'session-import: Failed to fetch transcript: 500',
      }),
    };
    const getCapability = <T>() => capability as unknown as T | undefined;

    const entries = await runStartupSessionImport(getCapability, logger, {
      'swarm.session-import': 'old1',
    });

    expect(entries?.[0].text).toContain('Failed to fetch transcript');
    expect(info.join(' ')).toContain('Failed to fetch transcript');
  });
});
