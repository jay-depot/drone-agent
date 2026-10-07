import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { GatewayConfig } from '../src/types.js';
import {
  convIdToFilename,
  filenameToConvId,
  validateConversationId,
} from '../src/config/files.js';

describe('convIdToFilename', () => {
  it('converts a room ID to a safe filename', () => {
    const result = convIdToFilename('!abc:matrix.org');
    expect(result).toContain('EXCL');
    expect(result).toContain('COLON');
    expect(result).not.toContain('!');
    expect(result).not.toContain(':');
  });

  it('converts a DM conversation ID to a safe filename', () => {
    const result = convIdToFilename('dm:@alice:matrix.org');
    expect(result).toContain('AT');
    expect(result).toContain('COLON');
    expect(result).not.toContain('@');
    expect(result).not.toContain(':');
  });

  it('converts wildcard to _default_', () => {
    const result = convIdToFilename('*');
    expect(result).toBe('_default_');
  });

  it('preserves safe characters as-is', () => {
    const result = convIdToFilename('simple-id');
    expect(result).toBe('simple-id');
  });
});

describe('filenameToConvId', () => {
  it('converts _default_ back to *', () => {
    const result = filenameToConvId('_default_');
    expect(result).toBe('*');
  });

  it('reverses encoded characters', () => {
    const encoded = convIdToFilename('!abc:matrix.org');
    const result = filenameToConvId(encoded);
    expect(result).toBe('!abc:matrix.org');
  });

  it('reverses DM conversation IDs', () => {
    const encoded = convIdToFilename('dm:@alice:matrix.org');
    const result = filenameToConvId(encoded);
    expect(result).toBe('dm:@alice:matrix.org');
  });
});

describe('validateConversationId', () => {
  it('returns null for valid IDs', () => {
    expect(validateConversationId('!abc:matrix.org')).toBeNull();
    expect(validateConversationId('dm:@alice:server')).toBeNull();
    expect(validateConversationId('*')).toBeNull();
  });

  it('returns error for empty IDs', () => {
    expect(validateConversationId('')).not.toBeNull();
    expect(validateConversationId('   ')).not.toBeNull();
  });

  it('returns error for overly long IDs', () => {
    expect(validateConversationId('a'.repeat(600))).not.toBeNull();
  });
});

describe('loadGatewayConfig coordinatorUrl validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  it('throws when coordinatorUrl is missing and spawnBackend is coordinator', async () => {
    const configPath = await writeConfig({
      spawnBackend: 'coordinator',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    await expect(loadGatewayConfig(configPath)).rejects.toThrow(
      'coordinatorUrl'
    );
  });

  it('does not throw when coordinatorUrl is missing and spawnBackend is local', async () => {
    const configPath = await writeConfig({
      spawnBackend: 'local',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.coordinatorUrl).toBe('');
    expect(config.spawnBackend).toBe('local');
  });

  it('does not throw when coordinatorUrl is missing and spawnBackend defaults to local', async () => {
    const configPath = await writeConfig({});

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.coordinatorUrl).toBe('');
    expect(config.spawnBackend).toBe('local');
  });

  it('accepts coordinatorUrl when present', async () => {
    const configPath = await writeConfig({
      coordinatorUrl: 'http://coordinator:8080',
      spawnBackend: 'coordinator',
      targetBeaconId: 'beacon-1',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.coordinatorUrl).toBe('http://coordinator:8080');
    expect(config.targetBeaconId).toBe('beacon-1');
  });
});

describe('loadGatewayConfig targetBeaconId validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-beacon-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  it('throws when targetBeaconId is missing in coordinator mode', async () => {
    const configPath = await writeConfig({
      coordinatorUrl: 'http://coordinator:8080',
      spawnBackend: 'coordinator',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    await expect(loadGatewayConfig(configPath)).rejects.toThrow(
      'targetBeaconId'
    );
  });

  it('accepts a targetBeaconId in coordinator mode', async () => {
    const configPath = await writeConfig({
      coordinatorUrl: 'http://coordinator:8080',
      spawnBackend: 'coordinator',
      targetBeaconId: 'beacon-9',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.targetBeaconId).toBe('beacon-9');
  });

  it('throws when targetBeaconId is not a string in coordinator mode', async () => {
    const configPath = await writeConfig({
      coordinatorUrl: 'http://coordinator:8080',
      spawnBackend: 'coordinator',
      targetBeaconId: 42,
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    await expect(loadGatewayConfig(configPath)).rejects.toThrow(
      'targetBeaconId'
    );
  });

  it('warns but loads when targetBeaconId is set in local mode', async () => {
    const configPath = await writeConfig({
      spawnBackend: 'local',
      targetBeaconId: 'beacon-9',
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.targetBeaconId).toBe('beacon-9');
    expect(config.spawnBackend).toBe('local');
  });
});

describe('loadGatewayConfig conversation parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-conv-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function writeConversation(
    adapterId: string,
    file: string,
    data: Record<string, unknown>
  ): void {
    const convDir = path.join(tmpDir, 'adapters', adapterId, 'conversations');
    mkdirSync(convDir, { recursive: true });
    writeFileSync(path.join(convDir, file), JSON.stringify(data));
  }

  async function load(): Promise<GatewayConfig> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ spawnBackend: 'local' }));
    writeFileSync(
      path.join(tmpDir, 'adapters', 'matrix', 'adapter.json'),
      JSON.stringify({ type: 'matrix' })
    );
    const { loadGatewayConfig } = await import('../src/config/load.js');
    return loadGatewayConfig(configPath);
  }

  it('parses a conversation with surfaces and no allowlist', async () => {
    writeConversation('matrix', 'room.json', {
      conversationId: '!room:server',
      controlSurfaces: [{ type: 'swarm-console' }],
    });
    const config = await load();
    const conversations = config.serviceAdapters[0].conversations;
    const conversation = conversations.get('!room:server');
    expect(conversation?.surfaces).toEqual([{ type: 'swarm-console' }]);
    expect(conversation?.allowedSenders).toBeUndefined();
  });

  it('parses a valid allowedSenders array', async () => {
    writeConversation('matrix', 'dm.json', {
      conversationId: 'dm:@me:server',
      allowedSenders: ['@me:server'],
      controlSurfaces: [{ type: 'swarm-console' }],
    });
    const config = await load();
    expect(
      config.serviceAdapters[0].conversations.get('dm:@me:server')
        ?.allowedSenders
    ).toEqual(['@me:server']);
  });

  it('ignores a non-array allowedSenders', async () => {
    writeConversation('matrix', 'dm.json', {
      conversationId: 'dm:@me:server',
      allowedSenders: '@me:server',
      controlSurfaces: [{ type: 'swarm-console' }],
    });
    const config = await load();
    expect(
      config.serviceAdapters[0].conversations.get('dm:@me:server')
        ?.allowedSenders
    ).toBeUndefined();
  });

  it('ignores an allowedSenders array with non-string entries', async () => {
    writeConversation('matrix', 'dm.json', {
      conversationId: 'dm:@me:server',
      allowedSenders: ['@me:server', 42],
      controlSurfaces: [{ type: 'swarm-console' }],
    });
    const config = await load();
    expect(
      config.serviceAdapters[0].conversations.get('dm:@me:server')
        ?.allowedSenders
    ).toBeUndefined();
  });

  it('keeps a valid absolute workingDir and expands ~ to the home directory', async () => {
    writeConversation('matrix', 'home.json', {
      conversationId: '!home:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { workingDir: '~/bots/x' },
        },
      ],
    });
    const config = await load();
    const surfaces =
      config.serviceAdapters[0].conversations.get('!home:server')?.surfaces;
    expect((surfaces?.[0].config as { workingDir?: string })?.workingDir).toBe(
      path.join(os.homedir(), 'bots/x')
    );
  });

  it('drops a relative workingDir', async () => {
    writeConversation('matrix', 'rel.json', {
      conversationId: '!rel:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { workingDir: 'bots/x' },
        },
      ],
    });
    const config = await load();
    const surfaces =
      config.serviceAdapters[0].conversations.get('!rel:server')?.surfaces;
    expect(surfaces?.[0].config).not.toHaveProperty('workingDir');
  });

  it('drops an over-length workingDir', async () => {
    writeConversation('matrix', 'long.json', {
      conversationId: '!long:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { workingDir: '/' + 'x'.repeat(4200) },
        },
      ],
    });
    const config = await load();
    const surfaces =
      config.serviceAdapters[0].conversations.get('!long:server')?.surfaces;
    expect(surfaces?.[0].config).not.toHaveProperty('workingDir');
  });

  it('drops a non-string workingDir', async () => {
    writeConversation('matrix', 'num.json', {
      conversationId: '!num:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { workingDir: 42 },
        },
      ],
    });
    const config = await load();
    const surfaces =
      config.serviceAdapters[0].conversations.get('!num:server')?.surfaces;
    expect(surfaces?.[0].config).not.toHaveProperty('workingDir');
  });

  it('keeps a valid lifecycle.idleTimeoutMs and drops a negative one', async () => {
    writeConversation('matrix', 'life.json', {
      conversationId: '!life:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { lifecycle: { idleTimeoutMs: 1000 } },
        },
      ],
    });
    writeConversation('matrix', 'life-neg.json', {
      conversationId: '!life-neg:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { lifecycle: { idleTimeoutMs: -1 } },
        },
      ],
    });
    const config = await load();
    const good = config.serviceAdapters[0].conversations.get('!life:server')
      ?.surfaces?.[0].config as { lifecycle?: { idleTimeoutMs?: number } };
    expect(good.lifecycle?.idleTimeoutMs).toBe(1000);
    const bad = config.serviceAdapters[0].conversations.get('!life-neg:server')
      ?.surfaces?.[0].config as { lifecycle?: { idleTimeoutMs?: number } };
    expect(bad.lifecycle).not.toHaveProperty('idleTimeoutMs');
  });

  it('keeps a valid surface config.batch.debounceMs (including 0) and drops an invalid one', async () => {
    writeConversation('matrix', 'batch.json', {
      conversationId: '!batch:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { batch: { debounceMs: 250 } },
        },
      ],
    });
    writeConversation('matrix', 'batch-zero.json', {
      conversationId: '!batch-zero:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { batch: { debounceMs: 0 } },
        },
      ],
    });
    writeConversation('matrix', 'batch-neg.json', {
      conversationId: '!batch-neg:server',
      controlSurfaces: [
        {
          type: 'persona-assignment',
          personaId: 'me',
          config: { batch: { debounceMs: -5 } },
        },
      ],
    });
    const config = await load();
    const ok = config.serviceAdapters[0].conversations.get('!batch:server')
      ?.surfaces?.[0].config as { batch?: { debounceMs?: number } };
    expect(ok.batch?.debounceMs).toBe(250);
    const zero = config.serviceAdapters[0].conversations.get(
      '!batch-zero:server'
    )?.surfaces?.[0].config as { batch?: { debounceMs?: number } };
    expect(zero.batch?.debounceMs).toBe(0);
    const neg = config.serviceAdapters[0].conversations.get('!batch-neg:server')
      ?.surfaces?.[0].config as { batch?: { debounceMs?: number } };
    expect(neg.batch).not.toHaveProperty('debounceMs');
  });
});

describe('loadGatewayConfig idleTimeoutMs validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-idle-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  it('keeps a valid top-level idleTimeoutMs (including 0)', async () => {
    const configPath = await writeConfig({
      spawnBackend: 'local',
      idleTimeoutMs: 0,
    });
    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.idleTimeoutMs).toBe(0);
  });

  it('omits an invalid top-level idleTimeoutMs', async () => {
    const configPath = await writeConfig({
      spawnBackend: 'local',
      idleTimeoutMs: 'soon',
    });
    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.idleTimeoutMs).toBeUndefined();
  });
});

describe('loadGatewayConfig controlApi parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-control-api-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function load(config: Record<string, unknown>): Promise<GatewayConfig> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const { loadGatewayConfig } = await import('../src/config/load.js');
    return loadGatewayConfig(configPath);
  }

  it('defaults controlApi when absent', async () => {
    const config = await load({ spawnBackend: 'local' });
    expect(config.controlApi).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 8090,
    });
  });

  it('parses a valid controlApi block', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { enabled: true, host: 'localhost', port: 9000, token: 't' },
    });
    expect(config.controlApi).toEqual({
      enabled: true,
      host: 'localhost',
      port: 9000,
      token: 't',
    });
  });

  it('warns and defaults on a non-object controlApi', async () => {
    const config = await load({ spawnBackend: 'local', controlApi: 42 });
    expect(config.controlApi).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 8090,
    });
  });

  it('ignores a non-boolean enabled', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { enabled: 'yes' },
    });
    expect(config.controlApi?.enabled).toBe(false);
  });

  it('uses the default host for an empty host', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { host: '  ' },
    });
    expect(config.controlApi?.host).toBe('127.0.0.1');
  });

  it('uses the default port for an out-of-range port', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { port: 99999 },
    });
    expect(config.controlApi?.port).toBe(8090);
  });

  it('ignores a non-string token', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { token: 5 },
    });
    expect(config.controlApi?.token).toBeUndefined();
  });

  it('accepts a non-loopback host but warns', async () => {
    const config = await load({
      spawnBackend: 'local',
      controlApi: { enabled: true, host: '0.0.0.0' },
    });
    expect(config.controlApi?.host).toBe('0.0.0.0');
  });
});

describe('loadGatewayConfig injection parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-injection-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function writeConversation(
    adapterId: string,
    file: string,
    data: Record<string, unknown>
  ): void {
    const convDir = path.join(tmpDir, 'adapters', adapterId, 'conversations');
    mkdirSync(convDir, { recursive: true });
    writeFileSync(path.join(convDir, file), JSON.stringify(data));
  }

  async function load(): Promise<GatewayConfig> {
    const configPath = path.join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ spawnBackend: 'local' }));
    writeFileSync(
      path.join(tmpDir, 'adapters', 'matrix', 'adapter.json'),
      JSON.stringify({ type: 'matrix' })
    );
    const { loadGatewayConfig } = await import('../src/config/load.js');
    return loadGatewayConfig(configPath);
  }

  it('keeps an injection-only conversation (no surfaces)', async () => {
    writeConversation('matrix', 'inj.json', {
      conversationId: '!inj:server',
      injection: { enabled: true },
    });
    const config = await load();
    const conversation =
      config.serviceAdapters[0].conversations.get('!inj:server');
    expect(conversation?.injectionEnabled).toBe(true);
    expect(conversation?.surfaces).toEqual([]);
  });

  it('skips a conversation with neither surfaces nor injection', async () => {
    writeConversation('matrix', 'empty.json', {
      conversationId: '!empty:server',
    });
    const config = await load();
    expect(config.serviceAdapters[0].conversations.has('!empty:server')).toBe(
      false
    );
  });

  it('ignores injection on the wildcard conversation', async () => {
    writeConversation('matrix', '_default_.json', {
      conversationId: '*',
      injection: { enabled: true },
      controlSurfaces: [{ type: 'discard' }],
    });
    const config = await load();
    const wildcard = config.serviceAdapters[0].conversations.get('*');
    expect(wildcard?.injectionEnabled).toBe(false);
  });

  it('ignores a non-boolean injection.enabled', async () => {
    writeConversation('matrix', 'bad.json', {
      conversationId: '!bad:server',
      injection: { enabled: 'yes' },
      controlSurfaces: [{ type: 'discard' }],
    });
    const config = await load();
    expect(
      config.serviceAdapters[0].conversations.get('!bad:server')
        ?.injectionEnabled
    ).toBe(false);
  });
});
