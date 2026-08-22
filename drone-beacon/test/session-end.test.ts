import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureSessionEndHook,
  runSessionEndHook,
} from '../src/session-end.js';
import { spawnAgent } from '../src/spawner.js';

vi.mock('../src/spawner.js', () => ({
  spawnAgent: vi.fn(),
}));

const spawnAgentMock = vi.mocked(spawnAgent);

describe('runSessionEndHook', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'session-end-test-'));
    spawnAgentMock.mockReset();
  });

  afterEach(async () => {
    configureSessionEndHook({ beaconId: 'unused' });
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when not configured', async () => {
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: false, kind: 'none' });
  });

  it('runs a command trigger to completion', async () => {
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: { type: 'command', command: 'exit 0' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'command' });
  });

  it('substitutes {session_id} into the command', async () => {
    const outFile = path.join(dir, 'seen.txt');
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: {
        type: 'command',
        command: `printf '%s' '{session_id}' > '${outFile}'`,
      },
    });
    const result = await runSessionEndHook('session-xyz');
    expect(result).toEqual({ ran: true, kind: 'command' });
    await expect(readFile(outFile, 'utf8')).resolves.toBe('session-xyz');
  });

  it('captures failing commands instead of throwing', async () => {
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: { type: 'command', command: 'exit 3' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'command', error: 'exit code 3' });
  });

  it('times out long-running commands', async () => {
    configureSessionEndHook({
      beaconId: 'b-1',
      commandTimeoutMs: 150,
      trigger: { type: 'command', command: 'sleep 10' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result.ran).toBe(true);
    expect(result.kind).toBe('command');
    expect(result.error).toBeDefined();
  }, 5000);

  it('spawns an agent for a matching spawn trigger', async () => {
    spawnAgentMock.mockResolvedValue({ id: 'spawn-1' } as never);
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: { type: 'spawn', persona: 'librarian' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn' });
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const [spawnId, agentId, personaId, task] = spawnAgentMock.mock.calls[0];
    expect(spawnId).toBeTruthy();
    expect(agentId).toMatch(/^agent-/);
    expect(personaId).toBe('librarian');
    expect(task).toContain('session-a');
  });

  it('skips spawn triggers targeting another beacon', async () => {
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: { type: 'spawn', persona: 'librarian', beaconId: 'b-other' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result.ran).toBe(false);
    expect(result.error).toBe('beaconId mismatch');
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('captures spawn failures instead of throwing', async () => {
    spawnAgentMock.mockRejectedValue(new Error('boom'));
    configureSessionEndHook({
      beaconId: 'b-1',
      trigger: { type: 'spawn', persona: 'librarian' },
    });
    const result = await runSessionEndHook('session-a');
    expect(result).toEqual({ ran: true, kind: 'spawn', error: String(new Error('boom')) });
  });
});
