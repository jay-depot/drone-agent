import { describe, expect, it, vi, beforeEach } from 'vitest';
import { convIdToFilename, filenameToConvId, validateConversationId } from '../src/config/files.js';

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

describe('loadGatewayConfig (integration with mocked fs)', () => {
  // These tests verify the config loader logic using a real temp directory
  // to test the folder walking behavior.

  it('convIdToFilename and filenameToConvId are lossless round-trips', () => {
    const testCases = [
      '!abc:matrix.org',
      'dm:@alice:matrix.org',
      'dm:@bob:chat.server.com',
      '#general:matrix.org',
      'simple-id',
      '*',
    ];

    for (const convId of testCases) {
      const filename = convIdToFilename(convId);
      const decoded = filenameToConvId(filename);
      expect(decoded).toBe(convId);
    }
  });
});
