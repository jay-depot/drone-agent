import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/index.js';

describe('resolveConfig', () => {
  it('defaults the coordinator URL to the unencrypted web port', () => {
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(cfg.coordinatorUrl).toBe('http://127.0.0.1:8080');
  });

  it('honors MCP_SWARM_COORDINATOR_URL', () => {
    const cfg = resolveConfig({
      MCP_SWARM_COORDINATOR_URL: 'http://10.0.0.5:8080',
    } as NodeJS.ProcessEnv);
    expect(cfg.coordinatorUrl).toBe('http://10.0.0.5:8080');
  });
});
