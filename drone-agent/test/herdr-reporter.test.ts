import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createReporter,
  type HerdrReporterOptions,
} from '../src/plugins/herdr/reporter.js';

// Mock the shared exec helper so no real Herdr binary is invoked.
const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
vi.mock('../src/shared/exec-async.js', () => ({
  execFileAsync: (...args: unknown[]) => mockExec(...args),
}));

function makeOptions(
  overrides: Partial<HerdrReporterOptions> = {}
): HerdrReporterOptions {
  return {
    binPath: '/usr/bin/herdr',
    paneId: 'w1:p1',
    source: 'drone-agent',
    agentLabel: 'drone-agent',
    sessionId: 'agent-1',
    ...overrides,
  };
}

/** Drain the reporter's background coalescing pump. */
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

function seqsFromCalls(): number[] {
  return mockExec.mock.calls
    .map(call => call[1] as string[])
    .filter(argv => argv.includes('--seq'))
    .map(argv => Number(argv[argv.indexOf('--seq') + 1]));
}

describe('herdr reporter --seq', () => {
  beforeEach(() => {
    // Fake ONLY `Date` so `setSystemTime` controls the clock while `setTimeout`
    // stays real — the `flush()` helper above needs a working timer to let the
    // coalescing pump settle.
    vi.useFakeTimers({ toFake: ['Date'] });
    mockExec.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits strictly increasing seqs across reports and release', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const reporter = createReporter(makeOptions());
    reporter.report('idle');
    await flush();
    reporter.report('working');
    await flush();
    reporter.report('idle');
    await flush();
    await reporter.release();

    const seqs = seqsFromCalls();
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('a restarted process out-sequences the previous process (the regression)', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const first = createReporter(makeOptions());
    first.report('idle');
    await flush();
    first.report('working');
    await flush();
    first.report('idle');
    await flush();
    const firstSeqs = seqsFromCalls();
    expect(firstSeqs.length).toBeGreaterThan(0);
    const firstMax = Math.max(...firstSeqs);

    mockExec.mockClear();
    // Simulate a restart one second later (the pane was NOT released).
    vi.setSystemTime(new Date('2026-10-08T22:00:01.000Z'));
    const second = createReporter(makeOptions());
    second.report('idle');
    await flush();
    const secondSeqs = seqsFromCalls();

    expect(secondSeqs.length).toBeGreaterThan(0);
    for (const s of secondSeqs) {
      expect(s).toBeGreaterThan(firstMax);
    }
  });

  it('is strictly increasing even for same-millisecond reports', async () => {
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    const reporter = createReporter(makeOptions());
    reporter.report('working');
    await flush();
    reporter.report('idle');
    await flush();
    reporter.report('working');
    await flush();

    const seqs = seqsFromCalls();
    expect(seqs.length).toBe(3);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
