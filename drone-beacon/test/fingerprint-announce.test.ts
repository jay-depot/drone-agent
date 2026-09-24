import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  announceFingerprint,
  resetFingerprintAnnounce,
} from '../src/fingerprint-announce.js';
import {
  setPendingCoordinatorFingerprint,
  confirmCoordinatorFingerprint,
  setBeaconApproved,
  resetCoordinatorTrust,
} from '../src/coordinator-trust.js';
import { setCoordinatorClient } from '../src/routes/context.js';
import type { CoordinatorClient } from '../src/coordinator-client.js';

const FP = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function makeFakeClient(
  confirmFingerprint: () => Promise<void>
): CoordinatorClient {
  return {
    getBaseUrl: () => 'http://coordinator:3456',
    getFetch: () => fetch as typeof fetch,
    confirmFingerprint,
  } as unknown as CoordinatorClient;
}

/** Put the beacon in the "locally confirmed, coordinator not yet approving" state. */
function makeTrusted(): void {
  setPendingCoordinatorFingerprint(FP);
  confirmCoordinatorFingerprint(FP);
}

beforeEach(() => {
  resetCoordinatorTrust();
  resetFingerprintAnnounce();
});

afterEach(() => {
  setCoordinatorClient(undefined);
  resetCoordinatorTrust();
  resetFingerprintAnnounce();
});

describe('announceFingerprint', () => {
  it('does nothing when the coordinator fingerprint is not trusted', () => {
    const confirmFingerprint = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(makeFakeClient(confirmFingerprint));

    announceFingerprint();

    expect(confirmFingerprint).not.toHaveBeenCalled();
  });

  it('does nothing once the beacon is approved', () => {
    const confirmFingerprint = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(makeFakeClient(confirmFingerprint));
    makeTrusted();
    setBeaconApproved(true);

    announceFingerprint();

    expect(confirmFingerprint).not.toHaveBeenCalled();
  });

  it('announces when the fingerprint is trusted and the beacon is not approved', () => {
    const confirmFingerprint = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(makeFakeClient(confirmFingerprint));
    makeTrusted();

    announceFingerprint();

    expect(confirmFingerprint).toHaveBeenCalledTimes(1);
  });

  it('throttles a second non-forced announce within the interval', () => {
    const confirmFingerprint = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(makeFakeClient(confirmFingerprint));
    makeTrusted();

    announceFingerprint();
    announceFingerprint();

    expect(confirmFingerprint).toHaveBeenCalledTimes(1);
  });

  it('honors force by bypassing the throttle', () => {
    const confirmFingerprint = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(makeFakeClient(confirmFingerprint));
    makeTrusted();

    announceFingerprint();
    announceFingerprint({ force: true });

    expect(confirmFingerprint).toHaveBeenCalledTimes(2);
  });

  it('swallows a rejected announce without throwing', () => {
    const confirmFingerprint = vi
      .fn()
      .mockRejectedValue(new Error('coordinator down'));
    setCoordinatorClient(makeFakeClient(confirmFingerprint));
    makeTrusted();

    expect(() => announceFingerprint()).not.toThrow();
    expect(confirmFingerprint).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no coordinator client is configured', () => {
    makeTrusted();
    setCoordinatorClient(undefined);

    expect(() => announceFingerprint()).not.toThrow();
  });
});
