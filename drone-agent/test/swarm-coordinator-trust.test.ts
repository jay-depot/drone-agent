import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../src/plugins/swarm/index.js';
import { silentLogger } from './helpers.js';
import { createDefaultAgentConfig } from 'drone-core';
import type {
  DronePluginRegistration,
  DroneSlashCommand,
  DroneToolDefinition,
} from 'drone-core';

/**
 * Creates a registration capture that records registered slash commands.
 */
function createRegistrationCapture(
  config: ReturnType<typeof createDefaultAgentConfig>,
  logger: ReturnType<typeof silentLogger> = silentLogger()
) {
  const registeredSlashCommands: DroneSlashCommand[] = [];

  const registration: DronePluginRegistration = {
    logger,
    getConfig: () => config,
    registerTool: (_tool: DroneToolDefinition) => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: (cmd: DroneSlashCommand) => {
      registeredSlashCommands.push(cmd);
    },
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: () => undefined,
    runWorkflow: async () => ({ toolResult: undefined }),
    requestElicitation: () => undefined,
  };

  return { registration, registeredSlashCommands };
}

describe('swarm coordinator trust', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the /trust-coordinator slash command', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (
          url === 'http://localhost:3457/agents' &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({});
    const { registration, registeredSlashCommands } =
      createRegistrationCapture(config);
    const plugin = createSwarmPlugin({});
    await plugin.register(registration);

    const cmd = registeredSlashCommands.find(
      c => c.command === '/trust-coordinator'
    );
    expect(cmd).toBeDefined();
    expect(cmd?.description).toContain('verification code');
  });

  it('surfaces pending gate halves on connect', async () => {
    const pendingFp =
      'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (
          url === 'http://localhost:3457/agents' &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              coordinatorTrust: {
                fingerprintTrusted: false,
                beaconApproved: false,
                pendingFingerprint: pendingFp,
                verificationCode: 'acorn-badge-cabin-daisy',
              },
            }),
          });
        }
        if (url === 'http://localhost:3457/coordinator/trust') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              fingerprintTrusted: false,
              beaconApproved: false,
              pendingFingerprint: pendingFp,
              verificationCode: 'acorn-badge-cabin-daisy',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({});
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const { registration } = createRegistrationCapture(config, logger);
    const plugin = createSwarmPlugin({});
    await plugin.register(registration);

    // The surfaced warning must reference opening the web UI but must NOT
    // contain the beacon's verification code value or pre-fill
    // /trust-coordinator <code> — otherwise the beacon would compare the code
    // against itself and defeat the MITM protection.
    const warning = warnSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(warning).toContain('coordinator web UI');
    expect(warning).not.toContain('acorn-badge-cabin-daisy');
    expect(warning).not.toMatch(/\/trust-coordinator [a-z]/);

    // The plugin should have queried the coordinator trust endpoint
    const trustCalls = mockFetch.mock.calls.filter(
      ([url]) => url === 'http://localhost:3457/coordinator/trust'
    );
    expect(trustCalls.length).toBeGreaterThan(0);
  });

  it('confirms the coordinator via the verification code endpoint', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (
          url === 'http://localhost:3457/agents' &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        if (
          url === 'http://localhost:3457/coordinator/trust' &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({});
    const { registration, registeredSlashCommands } =
      createRegistrationCapture(config);
    const plugin = createSwarmPlugin({});
    await plugin.register(registration);

    const cmd = registeredSlashCommands.find(
      c => c.command === '/trust-coordinator'
    );
    expect(cmd).toBeDefined();

    const logger = silentLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    const result = await cmd!.handler({
      line: `/trust-coordinator acorn-badge-cabin-daisy`,
      args: ['acorn-badge-cabin-daisy'],
      logger,
      engine: {} as never,
    });
    expect(result).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('confirmed'));
    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]) =>
        url === 'http://localhost:3457/coordinator/trust' &&
        opts?.method === 'POST'
    );
    expect(postCalls.length).toBe(1);
    expect(JSON.parse(postCalls[0][1].body)).toEqual({
      verificationCode: 'acorn-badge-cabin-daisy',
    });
  });
});
