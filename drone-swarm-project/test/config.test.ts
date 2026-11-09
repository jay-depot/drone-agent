import { describe, expect, it } from 'vitest';
import { parsePreApprovalTokenPath, resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('applies defaults with an empty environment', () => {
    const cfg = resolveConfig({}, []);
    expect(cfg.coordinatorUrl).toBe('http://127.0.0.1:8080');
    expect(cfg.id).toBe('drone-swarm-project');
    expect(cfg.injectToolsIntoAllSessions).toBe(true);
    expect(cfg.maxConcurrentSessions).toBe(1);
    expect(cfg.maxDailySessions).toBe(12);
    expect(cfg.dataDir).toContain('.drone-agent');
    expect(cfg.preApprovalTokenPath).toBeUndefined();
  });

  it('reads each env override', () => {
    const cfg = resolveConfig(
      {
        DRONE_SWARM_PROJECT_COORDINATOR_URL: 'http://example.test:9000',
        DRONE_SWARM_PROJECT_DATA_DIR: '/tmp/dsp',
        DRONE_SWARM_PROJECT_ID: 'custom-node',
        DRONE_SWARM_PROJECT_INJECT_TOOLS: 'false',
        DRONE_SWARM_PROJECT_MAX_CONCURRENT: '4',
        DRONE_SWARM_PROJECT_MAX_DAILY: '48',
      },
      []
    );
    expect(cfg.coordinatorUrl).toBe('http://example.test:9000');
    expect(cfg.dataDir).toBe('/tmp/dsp');
    expect(cfg.id).toBe('custom-node');
    expect(cfg.injectToolsIntoAllSessions).toBe(false);
    expect(cfg.maxConcurrentSessions).toBe(4);
    expect(cfg.maxDailySessions).toBe(48);
  });

  it('ignores a non-numeric limit', () => {
    const cfg = resolveConfig({ DRONE_SWARM_PROJECT_MAX_DAILY: 'lots' }, []);
    expect(cfg.maxDailySessions).toBe(12);
  });

  it('parses the pre-approval flag in both forms', () => {
    expect(
      parsePreApprovalTokenPath(['--pre-approval-token-path=a.json'])
    ).toBe('a.json');
    expect(
      parsePreApprovalTokenPath(['--pre-approval-token-path', 'b.json'])
    ).toBe('b.json');
    expect(parsePreApprovalTokenPath(['--other'])).toBeUndefined();
  });

  it('surfaces the pre-approval path from argv', () => {
    const cfg = resolveConfig({}, ['--pre-approval-token-path=c.json']);
    expect(cfg.preApprovalTokenPath).toBe('c.json');
  });
});
