import { afterEach, describe, expect, it } from 'vitest';
import { AddressError, defaultUrlFor, resolveAddress } from '../src/address.js';

describe('resolveAddress', () => {
  afterEach(() => {
    delete process.env.DRONE_BEACON_URL;
    delete process.env.DRONE_COORDINATOR_URL;
  });

  it('prefers explicit --coordinator', () => {
    const resolved = resolveAddress({ coordinator: 'http://example.com:9999' });
    expect(resolved.target).toBe('coordinator');
    expect(resolved.baseUrl).toBe('http://example.com:9999');
  });

  it('prefers explicit --beacon', () => {
    const resolved = resolveAddress({ beacon: 'http://example.com:3457' });
    expect(resolved.target).toBe('beacon');
    expect(resolved.baseUrl).toBe('http://example.com:3457');
  });

  it('rejects both flags together', () => {
    expect(() =>
      resolveAddress({
        beacon: 'http://a:1',
        coordinator: 'http://b:2',
      })
    ).toThrow(AddressError);
    expect(() =>
      resolveAddress({ beacon: 'http://a:1', coordinator: 'http://b:2' })
    ).toThrow(/mutually exclusive/);
  });

  it('falls back to DRONE_COORDINATOR_URL', () => {
    process.env.DRONE_COORDINATOR_URL = 'https://coord.example.com';
    const resolved = resolveAddress({});
    expect(resolved.target).toBe('coordinator');
    expect(resolved.baseUrl).toBe('https://coord.example.com');
  });

  it('falls back to DRONE_BEACON_URL', () => {
    process.env.DRONE_BEACON_URL = 'http://beacon.example.com:3457/';
    const resolved = resolveAddress({});
    expect(resolved.target).toBe('beacon');
    expect(resolved.baseUrl).toBe('http://beacon.example.com:3457');
  });

  it('rejects when both env URLs are set', () => {
    process.env.DRONE_BEACON_URL = 'http://b';
    process.env.DRONE_COORDINATOR_URL = 'http://c';
    expect(() => resolveAddress({})).toThrow(/DRONE_BEACON_URL/);
  });

  it('defaults to the local coordinator', () => {
    const resolved = resolveAddress({});
    expect(resolved.target).toBe('coordinator');
    expect(resolved.baseUrl).toBe('http://localhost:3456');
  });

  it('normalizes trailing slashes', () => {
    const resolved = resolveAddress({ coordinator: 'http://x:1/' });
    expect(resolved.baseUrl).toBe('http://x:1');
  });

  it('defaultUrlFor matches the plan port layout', () => {
    expect(defaultUrlFor('beacon')).toBe('http://localhost:3457');
    expect(defaultUrlFor('coordinator')).toBe('http://localhost:3456');
  });
});
