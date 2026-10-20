import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import {
  createPreApprovalToken,
  getPreApprovalToken,
  listPreApprovalTokens,
  deletePreApprovalToken,
  burnPreApprovalToken,
  getBeaconTrustByPublicKey,
  registerBeaconTrust,
} from '../../src/db/index.js';

function makeToken(durableId = 'token-1') {
  return createPreApprovalToken({
    durableId,
    burnPublicKey: 'burn-pub-1',
    label: 'gateway on the pi',
    issuedAt: 1000,
    expiresAt: 2000,
  });
}

describe('pre-approval token store', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('creates and reads a token', () => {
    const created = makeToken();
    expect(created.burnedAt).toBeNull();
    expect(created.burnedBy).toBeNull();
    const fetched = getPreApprovalToken('token-1');
    expect(fetched).toEqual(created);
  });

  it('lists tokens', () => {
    makeToken('token-1');
    makeToken('token-2');
    const rows = listPreApprovalTokens();
    expect(rows.map(r => r.durableId).sort()).toEqual(['token-1', 'token-2']);
  });

  it('deletes a token', () => {
    makeToken();
    expect(deletePreApprovalToken('token-1')).toBe(true);
    expect(getPreApprovalToken('token-1')).toBeUndefined();
    expect(deletePreApprovalToken('token-1')).toBe(false);
  });

  it('burns a token only once', () => {
    makeToken();
    expect(burnPreApprovalToken('token-1', 'beacon-a', 5000)).toBe(true);
    expect(burnPreApprovalToken('token-1', 'beacon-b', 6000)).toBe(false);
    const burned = getPreApprovalToken('token-1');
    expect(burned?.burnedAt).toBe(5000);
    expect(burned?.burnedBy).toBe('beacon-a');
  });

  it('is race-safe: a double burn yields exactly one winner', () => {
    makeToken();
    const results = [
      burnPreApprovalToken('token-1', 'beacon-a', 5000),
      burnPreApprovalToken('token-1', 'beacon-b', 5000),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('getBeaconTrustByPublicKey', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('finds a trust row by public key', () => {
    registerBeaconTrust({
      id: 'beacon-1',
      name: 'Beacon One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const found = getBeaconTrustByPublicKey('client-pub-1');
    expect(found?.beaconId).toBe('beacon-1');
  });

  it('returns undefined for a miss', () => {
    expect(getBeaconTrustByPublicKey('nope')).toBeUndefined();
  });
});
