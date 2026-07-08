import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
    });

    const { loadGatewayConfig } = await import('../src/config/load.js');
    const config = await loadGatewayConfig(configPath);
    expect(config.coordinatorUrl).toBe('http://coordinator:8080');
  });
});
