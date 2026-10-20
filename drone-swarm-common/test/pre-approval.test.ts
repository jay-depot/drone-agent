import { describe, expect, it } from 'vitest';
import {
  buildRedemptionSignaturePayload,
  buildTokenSignaturePayload,
  generateBurnKey,
  signBeaconPayload,
  verifyPreApprovalToken,
  type PreApprovalToken,
} from '../src/pre-approval.js';

describe('pre-approval token helpers', () => {
  it('builds the token signature payload in schema order', () => {
    const payload = buildTokenSignaturePayload({
      durableId: 'id-1',
      pubKey: 'pub-1',
      tlsFingerprint: 'fp-1',
      burnKey: 'burn-1',
    });
    expect(payload).toBe('id-1:pub-1:fp-1:burn-1');
  });

  it('builds the redemption signature payload in schema order', () => {
    const payload = buildRedemptionSignaturePayload({
      durableId: 'id-1',
      clientKey: 'client-1',
      pubKey: 'pub-1',
    });
    expect(payload).toBe('id-1:client-1:pub-1');
  });

  it('verifies a token signed by the coordinator key', () => {
    const coordinator = generateBurnKey();
    const burn = generateBurnKey();
    const base = {
      durableId: 'durable-1',
      pubKey: coordinator.publicKey,
      tlsFingerprint: 'abc123',
      burnKey: burn.privateKeyPem,
    };
    const token: PreApprovalToken = {
      ...base,
      sig: signBeaconPayload(
        coordinator.privateKeyPem,
        buildTokenSignaturePayload(base)
      ),
    };
    expect(verifyPreApprovalToken(token)).toBe(true);
  });

  it('rejects a token with a changed field', () => {
    const coordinator = generateBurnKey();
    const burn = generateBurnKey();
    const base = {
      durableId: 'durable-1',
      pubKey: coordinator.publicKey,
      tlsFingerprint: 'abc123',
      burnKey: burn.privateKeyPem,
    };
    const token: PreApprovalToken = {
      ...base,
      sig: signBeaconPayload(
        coordinator.privateKeyPem,
        buildTokenSignaturePayload(base)
      ),
      tlsFingerprint: 'tampered',
    };
    expect(verifyPreApprovalToken(token)).toBe(false);
  });

  it('rejects a token signed by the wrong key', () => {
    const coordinator = generateBurnKey();
    const attacker = generateBurnKey();
    const burn = generateBurnKey();
    const base = {
      durableId: 'durable-1',
      pubKey: coordinator.publicKey,
      tlsFingerprint: 'abc123',
      burnKey: burn.privateKeyPem,
    };
    const token: PreApprovalToken = {
      ...base,
      sig: signBeaconPayload(
        attacker.privateKeyPem,
        buildTokenSignaturePayload(base)
      ),
    };
    expect(verifyPreApprovalToken(token)).toBe(false);
  });
});
