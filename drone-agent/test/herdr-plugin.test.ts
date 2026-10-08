import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createDefaultAgentConfig, type DroneAgentConfig } from 'drone-core';
import { createHerdrPlugin } from '../src/plugins/herdr/index.js';

// Mock the shared exec helper so no real Herdr binary is invoked.
const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
vi.mock('../src/shared/exec-async.js', () => ({
  execFileAsync: (...args: unknown[]) => mockExec(...args),
}));

type ConvEventHandler = (event: {
  kind: string;
  content?: string;
}) => Promise<void>;

const HERDR_ENV_KEYS = [
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HERDR_BIN_PATH',
  'HERDR_SOCKET_PATH',
];

function makeRegistration(env: {
  herdrEnabled?: boolean;
  isSubagent?: boolean;
  persona?: string | null;
  sessionId?: string | null;
  debug?: boolean;
}) {
  let onConversationEvent: ConvEventHandler | undefined;
  let onShutdown: (() => Promise<void>) | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const emitted: Array<{ kind: string; content?: string }> = [];

  const config: DroneAgentConfig = createDefaultAgentConfig();
  config.herdr = {
    enabled: env.herdrEnabled ?? true,
    resumeCommand: 'drone-agent',
    agentLabel: 'drone-agent',
  };

  const registration = {
    logger,
    getConfig: () => config,
    getCliFlags: () => ({}),
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: vi.fn(),
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: (event: { kind: string; content?: string }) =>
      emitted.push(event),
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: (cb: ConvEventHandler) => {
        onConversationEvent = cb;
      },
      onSessionClear: () => {},
      onShutdown: (cb: () => Promise<void>) => {
        onShutdown = cb;
      },
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: (id: string) => {
      if (id === 'runtime') {
        return {
          isSubagent: env.isSubagent ?? false,
          persona: env.persona ?? null,
          debugFlags: {
            isEnabled: (name: string) => env.debug === true && name === 'herdr',
          },
        };
      }
      if (id === 'swarm') {
        if (env.sessionId === null) return undefined;
        return {
          getBeaconUrl: () => 'http://beacon',
          getAgentId: () => env.sessionId ?? 'agent-1',
        };
      }
      return undefined;
    },
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  return {
    registration,
    emitted,
    logger,
    getOnConversationEvent: () => onConversationEvent,
    getOnShutdown: () => onShutdown,
  };
}

function makeReportArgv(state: string): string[] {
  return [
    'pane',
    'report-agent',
    'w1:p1',
    '--source',
    'drone-agent',
    '--agent',
    'drone-agent',
    '--state',
    state,
  ];
}

function flattenArgvCalls(): string[][] {
  return mockExec.mock.calls.map(call => call[1] as string[]);
}

/** Wait for the background coalescing pump to settle. */
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

describe('herdr plugin', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });
    for (const key of HERDR_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_BIN_PATH = '/usr/bin/herdr';
  });

  afterEach(() => {
    for (const key of HERDR_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('is opt-in (not enabled by default)', () => {
    expect(createHerdrPlugin().metadata.defaultEnabled).toBe(false);
  });

  it('does nothing when herdr.enabled is false', async () => {
    const { registration } = makeRegistration({ herdrEnabled: false });
    await createHerdrPlugin().register(registration as never);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('does nothing outside Herdr (HERDR_ENV unset)', async () => {
    delete process.env.HERDR_ENV;
    const { registration } = makeRegistration({});
    await createHerdrPlugin().register(registration as never);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('does nothing for subagents', async () => {
    const { registration } = makeRegistration({ isSubagent: true });
    await createHerdrPlugin().register(registration as never);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('sends an initial idle report holding the pane, with the resume command', async () => {
    const { registration } = makeRegistration({ sessionId: 'agent-1' });
    await createHerdrPlugin().register(registration as never);
    await flush();

    const calls = flattenArgvCalls();
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.slice(0, 9)).toEqual(makeReportArgv('idle'));
    expect(argv).toContain('--agent-session-id');
    expect(argv).toContain('agent-1');
    // Resume command attached after `--`.
    const sep = argv.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual([
      'drone-agent',
      '--swarm.session-import',
      'agent-1',
    ]);
  });

  it('reports working on userMessage and idle on roundComplete', async () => {
    const { registration, getOnConversationEvent } = makeRegistration({
      sessionId: 'agent-1',
    });
    await createHerdrPlugin().register(registration as never);
    const handler = getOnConversationEvent()!;

    await handler({ kind: 'userMessage', content: 'hi' });
    await flush();
    await handler({ kind: 'roundComplete' });
    await flush();

    const states = flattenArgvCalls()
      .filter(argv => argv[1] === 'report-agent')
      .map(argv => argv[argv.indexOf('--state') + 1]);
    expect(states).toEqual(['idle', 'working', 'idle']);
  });

  it('increases --seq across every report', async () => {
    const { registration, getOnConversationEvent } = makeRegistration({
      sessionId: 'agent-1',
    });
    await createHerdrPlugin().register(registration as never);
    const handler = getOnConversationEvent()!;
    await handler({ kind: 'userMessage', content: 'hi' });
    await flush();

    const seqs = flattenArgvCalls()
      .filter(argv => argv.includes('--seq'))
      .map(argv => Number(argv[argv.indexOf('--seq') + 1]));
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // Wall-clock floor: every seq is a real timestamp, so a restart cannot
    // collide with an older process's watermark.
    for (const s of seqs) {
      expect(s).toBeGreaterThanOrEqual(Date.now() - 5_000);
    }
  });

  it('releases the pane on shutdown', async () => {
    const { registration, getOnShutdown } = makeRegistration({
      sessionId: 'agent-1',
    });
    await createHerdrPlugin().register(registration as never);
    await flush();
    await getOnShutdown()!();

    const release = flattenArgvCalls().find(
      argv => argv[1] === 'release-agent'
    );
    expect(release).toBeDefined();
    expect(release).toContain('--source');
    expect(release).toContain('drone-agent');
  });

  it('warns once (notice + logger) when no swarm session id is available', async () => {
    const { registration, logger, emitted, getOnConversationEvent } =
      makeRegistration({ sessionId: null });
    await createHerdrPlugin().register(registration as never);
    expect(mockExec).not.toHaveBeenCalled();

    const handler = getOnConversationEvent()!;
    await handler({ kind: 'userMessage', content: 'hi' });
    await handler({ kind: 'userMessage', content: 'again' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(emitted.filter(e => e.kind === 'notice')).toHaveLength(1);
    expect(emitted[0].content).toContain('no swarm session id');
  });

  it('never crashes when the Herdr call fails', async () => {
    mockExec.mockRejectedValue(new Error('ENOENT'));
    const { registration, getOnConversationEvent } = makeRegistration({
      sessionId: 'agent-1',
    });
    await expect(
      createHerdrPlugin().register(registration as never)
    ).resolves.toBeUndefined();
    const handler = getOnConversationEvent()!;
    await expect(
      handler({ kind: 'userMessage', content: 'hi' })
    ).resolves.toBeUndefined();
    await flush();
  });
});
