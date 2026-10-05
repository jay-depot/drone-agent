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
