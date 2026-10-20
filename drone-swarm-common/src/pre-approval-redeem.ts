import { readFile } from 'node:fs/promises';
import { loadOrCreateIdentity } from './identity.js';
import { loadOrCreateTlsIdentity } from './tls.js';
import { createCoordinatorFetch } from './coordinator-fetch.js';
import { saveCoordinatorTrust } from './coordinator-trust.js';
import { EXTENSION_PROTOCOL_VERSION } from 'drone-core';
import {
  buildRedemptionSignaturePayload,
  signBeaconPayload,
  verifyPreApprovalToken,
  type PreApprovalToken,
} from './pre-approval.js';

export interface RedeemPreApprovalTokenOptions {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  name: string;
  tokenPath: string;
}

/**
 * Redeem a pre-approval token in a one-shot run: verify the token's
 * self-signature, register the node, redeem the token (which approves the
 * node), then persist the coordinator trust record for later runs.
 */
export async function redeemPreApprovalToken(
  opts: RedeemPreApprovalTokenOptions
): Promise<void> {
  const raw = await readFile(opts.tokenPath, 'utf8');
  const token = JSON.parse(raw) as PreApprovalToken;
  if (!verifyPreApprovalToken(token)) {
    throw new Error('Pre-approval token signature is invalid');
  }
  const identity = await loadOrCreateIdentity(
    opts.id,
    opts.dataDir,
    'node-identity.json'
  );
  const tlsIdentity = await loadOrCreateTlsIdentity(opts.dataDir, 'node');
  const cfetch = createCoordinatorFetch(
    opts.coordinatorUrl,
    token.tlsFingerprint,
    undefined,
    tlsIdentity
  );

  const register = await cfetch(`${opts.coordinatorUrl}/api/beacons`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: opts.id,
      name: opts.name,
      host: '127.0.0.1',
      publicKey: identity.publicKey,
      tlsFingerprint: tlsIdentity.fingerprint,
      fingerprintConfirmed: false,
      extension: { protocolVersion: EXTENSION_PROTOCOL_VERSION },
    }),
  });
  if (!register.ok) {
    throw new Error(
      `Registration failed: ${register.status} ${await register.text()}`
    );
  }

  const redemption = {
    durableId: token.durableId,
    clientKey: identity.publicKey,
    pubKey: token.pubKey,
  };
  const redeem = await cfetch(
    `${opts.coordinatorUrl}/api/beacons/trust/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...redemption,
        sig: signBeaconPayload(
          token.burnKey,
          buildRedemptionSignaturePayload(redemption)
        ),
      }),
    }
  );
  if (!redeem.ok) {
    throw new Error(
      `Redemption failed: ${redeem.status} ${await redeem.text()}`
    );
  }

  await saveCoordinatorTrust(opts.dataDir, {
    coordinatorUrl: opts.coordinatorUrl,
    tlsFingerprint: token.tlsFingerprint,
  });
}
