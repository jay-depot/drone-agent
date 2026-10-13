import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';

/** Default identity filename for beacons; extensions pass `node-identity.json`. */
export const DEFAULT_IDENTITY_FILENAME = 'beacon-identity.json';

export interface SwarmNodeIdentity {
  id: string;
  publicKey: string; // Base64-encoded
  publicKeyHex: string;
  privateKeyPem: string;
}

/** Backwards-compatible alias for {@link SwarmNodeIdentity}. */
export type BeaconIdentity = SwarmNodeIdentity;

/**
 * Generate a new Ed25519 keypair for swarm node identity.
 */
export function generateIdentity(id: string): SwarmNodeIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyHex = crypto
    .createHash('sha256')
    .update(publicKeyDer)
    .digest('hex');
  const publicKeyBase64 = publicKeyDer.toString('base64');

  const privateKeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;

  return {
    id,
    publicKey: publicKeyBase64,
    publicKeyHex,
    privateKeyPem,
  };
}

/**
 * Load existing identity from disk or generate new one.
 */
export async function loadOrCreateIdentity(
  id: string,
  configDir: string,
  filename: string = DEFAULT_IDENTITY_FILENAME
): Promise<SwarmNodeIdentity> {
  const identityPath = path.join(configDir, filename);

  if (existsSync(identityPath)) {
    try {
      const raw = await readFile(identityPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.id === id && data.publicKey && data.privateKeyPem) {
        const publicKeyDer = Buffer.from(data.publicKey, 'base64');
        const publicKeyHex = crypto
          .createHash('sha256')
          .update(publicKeyDer)
          .digest('hex');
        logger.info(`Loaded existing identity for node: ${id}`);
        return {
          id: data.id,
          publicKey: data.publicKey,
          publicKeyHex,
          privateKeyPem: data.privateKeyPem,
        };
      }
    } catch (err) {
      logger.warn(`Failed to load identity, generating new one: ${err}`);
    }
  }

  const identity = generateIdentity(id);

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const dataToSave = {
    id: identity.id,
    publicKey: identity.publicKey,
    privateKeyPem: identity.privateKeyPem,
  };
  await writeFile(identityPath, JSON.stringify(dataToSave, null, 2));
  logger.info(`Generated and saved new identity for node: ${id}`);

  return identity;
}

/**
 * Get the public key in a format suitable for signing.
 */
export function getSigningKey(identity: SwarmNodeIdentity): crypto.KeyObject {
  return crypto.createPublicKey(identity.privateKeyPem);
}
