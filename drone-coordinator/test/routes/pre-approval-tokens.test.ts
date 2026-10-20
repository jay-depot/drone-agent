import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import { setCoordinatorFingerprint } from '../../src/routes/health.js';
import { setSigningIdentity } from '../../src/signing-identity.js';
import {
  buildRedemptionSignaturePayload,
  buildTokenSignaturePayload,
  generateBurnKey,
  generateIdentity,
  loadOrCreateIdentity,
  signBeaconPayload,
  verifyPreApprovalToken,
  type PreApprovalToken,
} from 'drone-swarm-common';
import {
  registerBeaconTrust,
  getBeaconTrust,
  getPreApprovalToken,
} from '../../src/db/index.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let coordinatorIdentity: ReturnType<typeof generateIdentity>;

beforeEach(async () => {
  await setupDb();
  setCoordinatorFingerprint('coordinator-fingerprint');
  coordinatorIdentity = generateIdentity('coordinator');
  setSigningIdentity(coordinatorIdentity);
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

async function mintToken(label?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/pre-approval-tokens',
    payload: label ? { label } : {},
  });
  return res;
}

function baseFor(durableId: string) {
  const burn = generateBurnKey();
  const base = {
    durableId,
    pubKey: coordinatorIdentity.publicKey,
    tlsFingerprint: 'coordinator-fingerprint',
    burnKey: burn.privateKeyPem,
  };
  return { burn, base };
}

async function seedToken(durableId: string, expiresAt = Date.now() + 100000) {
  const { burn, base } = baseFor(durableId);
  const token: PreApprovalToken = {
    ...base,
    sig: signBeaconPayload(
      coordinatorIdentity.privateKeyPem,
      buildTokenSignaturePayload(base)
    ),
  };
  const { createPreApprovalToken } = await import(
    '../../src/db/index.js'
  );
  createPreApprovalToken({
    durableId,
    burnPublicKey: burn.publicKey,
    label: null,
    issuedAt: Date.now(),
    expiresAt,
  });
  return { burn, token };
}

function redeemPayload(
  token: PreApprovalToken,
  clientKey: string,
  burn: { privateKeyPem: string }
) {
  const redemption = {
    durableId: token.durableId,
    clientKey,
    pubKey: token.pubKey,
  };
  return {
    ...redemption,
    sig: signBeaconPayload(
      burn.privateKeyPem,
      buildRedemptionSignaturePayload(redemption)
    ),
  };
}

describe('POST /api/beacons/trust/redeem', () => {
  it('approves a registered node and confirms its fingerprint', async () => {
    registerBeaconTrust({
      id: 'node-1',
      name: 'Node One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const { burn, token } = await seedToken('tok-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: redeemPayload(token, 'client-pub-1', burn),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'approved',
      beaconId: 'node-1',
    });
    const trust = getBeaconTrust('node-1');
    expect(trust?.status).toBe('approved');
    expect(trust?.fingerprintConfirmedAt).not.toBeNull();
  });

  it('returns TOKEN_NOT_FOUND for an unknown token', async () => {
    registerBeaconTrust({
      id: 'node-1',
      name: 'Node One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const { burn } = baseFor('tok-missing');
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: {
        durableId: 'tok-missing',
        clientKey: 'client-pub-1',
        pubKey: coordinatorIdentity.publicKey,
        sig: signBeaconPayload(burn.privateKeyPem, 'x'),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('TOKEN_NOT_FOUND');
  });

  it('returns TOKEN_EXPIRED for an expired token', async () => {
    registerBeaconTrust({
      id: 'node-1',
      name: 'Node One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const { burn, token } = await seedToken('tok-exp', Date.now() - 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: redeemPayload(token, 'client-pub-1', burn),
    });
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).code).toBe('TOKEN_EXPIRED');
  });

  it('returns INVALID_SIGNATURE for a bad signature', async () => {
    registerBeaconTrust({
      id: 'node-1',
      name: 'Node One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const { burn, token } = await seedToken('tok-bad');
    const wrongBurn = generateBurnKey();
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: redeemPayload(token, 'client-pub-1', wrongBurn),
    });
    void burn;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_SIGNATURE');
  });

  it('returns CLIENT_NOT_REGISTERED for an unknown client key', async () => {
    const { burn, token } = await seedToken('tok-noclient');
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: redeemPayload(token, 'not-registered', burn),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('CLIENT_NOT_REGISTERED');
  });

  it('returns TOKEN_ALREADY_BURNED on a second redemption', async () => {
    registerBeaconTrust({
      id: 'node-1',
      name: 'Node One',
      host: '10.0.0.5',
      publicKey: 'client-pub-1',
    });
    const { burn, token } = await seedToken('tok-twice');
    const payload = redeemPayload(token, 'client-pub-1', burn);
    const first = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe('TOKEN_ALREADY_BURNED');
  });

  it('rejects a missing-field body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/redeem',
      payload: { durableId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
  });
});

describe('mint routes', () => {
  it('mints a verifiable token and returns the entry', async () => {
    const res = await mintToken('gateway on the pi');
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token.durableId).toBeTruthy();
    expect(body.token.pubKey).toBe(coordinatorIdentity.publicKey);
    expect(body.token.tlsFingerprint).toBe('coordinator-fingerprint');
    expect(body.token.burnKey).toContain('BEGIN PRIVATE KEY');
    expect(verifyPreApprovalToken(body.token as PreApprovalToken)).toBe(true);
    expect(body.entry.label).toBe('gateway on the pi');
    expect(body.entry.burnedAt).toBeNull();
  });

  it('lists tokens without burn material', async () => {
    await mintToken('one');
    const res = await app.inject({
      method: 'GET',
      url: '/api/pre-approval-tokens',
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('one');
    expect(rows[0].burnPublicKey).toBeUndefined();
    expect(rows[0].burnKey).toBeUndefined();
  });

  it('revokes a token and makes redemption fail with 404', async () => {
    const minted = await mintToken();
    const { durableId } = JSON.parse(minted.body).entry;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/pre-approval-tokens/${durableId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).revoked).toBe(true);
    expect(getPreApprovalToken(durableId)).toBeUndefined();
    const delAgain = await app.inject({
      method: 'DELETE',
      url: `/api/pre-approval-tokens/${durableId}`,
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it('returns 500 when no signing identity is available', async () => {
    setSigningIdentity(null as never);
    const res = await mintToken();
    expect(res.statusCode).toBe(500);
  });
});

describe('coordinator signing identity loading', () => {
  it('generates a persistent identity', async () => {
    const identity = await loadOrCreateIdentity(
      'coordinator',
      await (await import('node:fs/promises')).mkdtemp(
        (await import('node:path')).join(
          (await import('node:os')).tmpdir(),
          'coord-id-'
        )
      ),
      'coordinator-identity.json'
    );
    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });
});
