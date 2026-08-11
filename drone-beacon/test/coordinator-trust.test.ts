import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initCoordinatorTrust,
  setPendingCoordinatorFingerprint,
  confirmCoordinatorFingerprint,
  isCoordinatorTrusted,
  getTrustedCoordinatorFingerprint,
  getPendingCoordinatorFingerprint,
  getObservedCoordinatorFingerprint,
  setBeaconApproved,
  isBeaconApproved,
  isSwarmReady,
  resetCoordinatorTrust,
} from '../src/coordinator-trust.js';

const FP = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

describe('Coordinator Trust', () => {
  let configDir: string;

  beforeEach(async () => {
    resetCoordinatorTrust();
    configDir = await mkdtemp(
      path.join(os.tmpdir(), 'drone-beacon-coordinator-trust-')
    );
    initCoordinatorTrust(configDir);
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('starts untrusted with no pending fingerprint', () => {
    expect(isCoordinatorTrusted()).toBe(false);
    expect(getPendingCoordinatorFingerprint()).toBeUndefined();
    expect(isSwarmReady()).toBe(false);
  });

  it('records a pending fingerprint on first connection without trusting it', async () => {
    setPendingCoordinatorFingerprint(FP);
    expect(isCoordinatorTrusted()).toBe(false);
    expect(getPendingCoordinatorFingerprint()).toBe(FP);
    // Pending file written, trusted file not
    expect(
      existsSync(
        path.join(configDir, 'coordinator-tls-fingerprint.pending.txt')
      )
    ).toBe(true);
    expect(
      existsSync(path.join(configDir, 'coordinator-tls-fingerprint.txt'))
    ).toBe(false);
  });

  it('confirms a matching pending fingerprint and promotes it to trusted', async () => {
    setPendingCoordinatorFingerprint(FP);
    const ok = confirmCoordinatorFingerprint(FP);
    expect(ok).toBe(true);
    expect(isCoordinatorTrusted()).toBe(true);
    expect(getTrustedCoordinatorFingerprint()).toBe(FP);
    expect(getPendingCoordinatorFingerprint()).toBeUndefined();
    // Trusted file written, pending file removed
    expect(
      existsSync(path.join(configDir, 'coordinator-tls-fingerprint.txt'))
    ).toBe(true);
    expect(
      existsSync(
        path.join(configDir, 'coordinator-tls-fingerprint.pending.txt')
      )
    ).toBe(false);
  });

  it('rejects a non-matching fingerprint', async () => {
    setPendingCoordinatorFingerprint(FP);
    const ok = confirmCoordinatorFingerprint(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
    expect(ok).toBe(false);
    expect(isCoordinatorTrusted()).toBe(false);
    expect(getPendingCoordinatorFingerprint()).toBe(FP);
  });

  it('rejects confirmation when there is no pending fingerprint', () => {
    const ok = confirmCoordinatorFingerprint(FP);
    expect(ok).toBe(false);
    expect(isCoordinatorTrusted()).toBe(false);
  });

  it('loads a persisted trusted fingerprint from disk', async () => {
    setPendingCoordinatorFingerprint(FP);
    confirmCoordinatorFingerprint(FP);
    // Re-init from disk (simulating a restart)
    initCoordinatorTrust(configDir);
    expect(isCoordinatorTrusted()).toBe(true);
    expect(getTrustedCoordinatorFingerprint()).toBe(FP);
  });

  it('loads a persisted pending fingerprint from disk', async () => {
    setPendingCoordinatorFingerprint(FP);
    // Re-init from disk (simulating a restart before confirmation)
    initCoordinatorTrust(configDir);
    expect(isCoordinatorTrusted()).toBe(false);
    expect(getPendingCoordinatorFingerprint()).toBe(FP);
  });

  it('returns the observed fingerprint (trusted when confirmed, else pending)', () => {
    // Pending only
    setPendingCoordinatorFingerprint(FP);
    expect(getObservedCoordinatorFingerprint()).toBe(FP);

    // After confirmation, returns the trusted value
    confirmCoordinatorFingerprint(FP);
    expect(getObservedCoordinatorFingerprint()).toBe(FP);
  });

  it('gates swarm readiness on both fingerprint confirmation and beacon approval', () => {
    // Fingerprint confirmed but beacon not approved
    setPendingCoordinatorFingerprint(FP);
    confirmCoordinatorFingerprint(FP);
    expect(isSwarmReady()).toBe(false);

    // Beacon approved but fingerprint not confirmed
    setBeaconApproved(true);
    expect(isSwarmReady()).toBe(true);

    // Reset and check the reverse order
    setBeaconApproved(false);
    expect(isSwarmReady()).toBe(false);
  });
});
