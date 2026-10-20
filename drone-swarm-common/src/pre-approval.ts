import { generateIdentity } from './identity.js';
import { signBeaconPayload, verifyBeaconSignature } from './verification.js';

export const PRE_APPROVAL_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PreApprovalToken {
  durableId: string;
  pubKey: string;
  tlsFingerprint: string;
  burnKey: string;
  sig: string;
}

export function buildTokenSignaturePayload(
  token: Omit<PreApprovalToken, 'sig'>
): string {
  return [
    token.durableId,
    token.pubKey,
    token.tlsFingerprint,
    token.burnKey,
  ].join(':');
}

export function buildRedemptionSignaturePayload(input: {
  durableId: string;
  clientKey: string;
  pubKey: string;
}): string {
  return [input.durableId, input.clientKey, input.pubKey].join(':');
}

export function verifyPreApprovalToken(token: PreApprovalToken): boolean {
  return verifyBeaconSignature(
    token.pubKey,
    buildTokenSignaturePayload(token),
    token.sig
  );
}

export function generateBurnKey(): {
  publicKey: string;
  privateKeyPem: string;
} {
  const burn = generateIdentity('burn');
  return { publicKey: burn.publicKey, privateKeyPem: burn.privateKeyPem };
}

export { signBeaconPayload };
