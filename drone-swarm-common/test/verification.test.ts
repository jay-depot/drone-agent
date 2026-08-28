import { describe, expect, it } from 'vitest';
import { generateVerificationCode } from '../src/verification.js';

const BEACON_PUBKEY = 'beacon-public-key-abc123';
const BEACON_TLS_FP =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const COORDINATOR_TLS_FP =
  '112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('generateVerificationCode', () => {
  it('produces a 4-word code', () => {
    const code = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    expect(code.split('-')).toHaveLength(4);
    expect(code).toMatch(/^[a-z]+(-[a-z]+){3}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    const b = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    expect(a).toBe(b);
  });

  it('produces the same code on both sides given the same inputs', () => {
    // The beacon and coordinator independently compute the code from the same
    // three inputs; they must agree.
    const beaconSide = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    const coordinatorSide = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    expect(beaconSide).toBe(coordinatorSide);
  });

  it('produces a different code when the coordinator fingerprint differs', () => {
    const codeA = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    const codeB = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
    expect(codeA).not.toBe(codeB);
  });

  it('produces a different code when the beacon fingerprint differs', () => {
    const codeA = generateVerificationCode(
      BEACON_PUBKEY,
      BEACON_TLS_FP,
      COORDINATOR_TLS_FP
    );
    const codeB = generateVerificationCode(
      BEACON_PUBKEY,
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      COORDINATOR_TLS_FP
    );
    expect(codeA).not.toBe(codeB);
  });
});
