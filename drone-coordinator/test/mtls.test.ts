import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setupDb, teardownDb } from './setup.js';
import {
  createMtlsMiddleware,
  getClientCertFingerprint,
  resolveBeaconIdByFingerprint,
  resolveRequestNodeId,
} from '../src/mtls.js';
import { registerBeaconTrust, approveBeaconById } from '../src/db/index.js';

const TEST_FP =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function makeReq(
  url: string,
  method = 'GET',
  certFingerprint?: string,
  headers: Record<string, string> = {}
) {
  return {
    url,
    method,
    headers,
    socket: {
      getPeerCertificate: () =>
        certFingerprint ? { fingerprint256: certFingerprint } : false,
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { _code(): number } {
  let code = 0;
  return {
    code: (c: number) => {
      code = c;
      return {
        send: () => {},
      };
    },
    _code: () => code,
  } as unknown as FastifyReply & { _code(): number };
}

beforeEach(async () => {
  await setupDb();
});

afterEach(async () => {
  await teardownDb();
});

describe('getClientCertFingerprint', () => {
  it('returns the normalized fingerprint when a cert is presented', () => {
    const req = makeReq('/api/personas', 'GET', 'AA:BB:CC:DD');
    expect(getClientCertFingerprint(req)).toBe('aabbccdd');
  });

  it('returns undefined when no cert is presented', () => {
    const req = makeReq('/api/personas');
    expect(getClientCertFingerprint(req)).toBeUndefined();
  });
});

describe('resolveBeaconIdByFingerprint', () => {
  it('returns the beaconId for a matching registered fingerprint', () => {
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: 'localhost',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
    });
    expect(resolveBeaconIdByFingerprint(TEST_FP)).toBe('b-mtls');
  });

  it('returns undefined for an unknown fingerprint', () => {
    expect(resolveBeaconIdByFingerprint('unknown')).toBeUndefined();
  });
});

describe('resolveRequestNodeId', () => {
  function registerLocal(id: string, tlsFingerprint?: string) {
    registerBeaconTrust(
      {
        id,
        name: id,
        host: 'localhost',
        port: 3457,
        publicKey: `key-${id}`,
        tlsFingerprint,
      },
      { socketIsLocal: true }
    );
  }

  it('resolves a registered certificate by fingerprint', () => {
    registerLocal('b-cert', TEST_FP);
    expect(resolveRequestNodeId(makeReq('/ws/beacon', 'GET', TEST_FP))).toBe(
      'b-cert'
    );
  });

  it('lets the certificate win when a claim disagrees', () => {
    registerLocal('b-cert', TEST_FP);
    registerLocal('b-claim');
    const req = makeReq('/ws/beacon?beaconId=b-claim', 'GET', TEST_FP, {
      'x-node-id': 'b-claim',
    });
    expect(resolveRequestNodeId(req)).toBe('b-cert');
  });

  it('fails closed when a certificate does not resolve, ignoring a claim', () => {
    registerLocal('b-claim');
    const req = makeReq('/ws/beacon?beaconId=b-claim', 'GET', 'deadbeef', {
      'x-node-id': 'b-claim',
    });
    expect(resolveRequestNodeId(req)).toBeUndefined();
  });

  it('uses a valid x-node-id header when no certificate is present', () => {
    registerLocal('b-header');
    const req = makeReq('/ws/beacon', 'GET', undefined, {
      'x-node-id': 'b-header',
    });
    expect(resolveRequestNodeId(req)).toBe('b-header');
  });

  it('uses a valid beaconId query parameter when no certificate is present', () => {
    registerLocal('b-query');
    expect(resolveRequestNodeId(makeReq('/ws/beacon?beaconId=b-query'))).toBe(
      'b-query'
    );
  });

  it('returns undefined for an unknown claimed id', () => {
    expect(resolveRequestNodeId(makeReq('/ws/beacon?beaconId=nope'))).toBe(
      undefined
    );
  });

  it('returns undefined when nothing is presented', () => {
    expect(resolveRequestNodeId(makeReq('/ws/beacon'))).toBeUndefined();
  });
});

describe('createMtlsMiddleware', () => {
  it('exempts /health', async () => {
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/health'), reply);
    expect(reply._code()).toBe(0);
  });

  it('exempts POST /api/beacons (registration verified in-route)', async () => {
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/beacons', 'POST'), reply);
    expect(reply._code()).toBe(0);
  });

  it('exempts the approval poll for a pending beacon', async () => {
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
    });
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(
      makeReq('/api/beacons/trust/b-mtls', 'GET', TEST_FP),
      reply
    );
    expect(reply._code()).toBe(0);
  });

  it('exempts the fingerprint confirm-fingerprint announce for a pending beacon', async () => {
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
    });
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(
      makeReq('/api/beacons/trust/b-mtls/confirm-fingerprint', 'POST', TEST_FP),
      reply
    );
    expect(reply._code()).toBe(0);
  });

  it('exempts non-API routes', async () => {
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/'), reply);
    expect(reply._code()).toBe(0);
  });

  it('blocks API requests without a client cert', async () => {
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas'), reply);
    expect(reply._code()).toBe(401);
  });

  it('blocks API requests with an unknown client cert', async () => {
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas', 'GET', 'deadbeef'), reply);
    expect(reply._code()).toBe(401);
  });

  it('allows API requests with a registered beacon cert', async () => {
    registerBeaconTrust(
      {
        id: 'b-mtls',
        name: 'MTLS Beacon',
        host: 'localhost',
        port: 3457,
        publicKey: 'pubkey',
        tlsFingerprint: TEST_FP,
      },
      { socketIsLocal: true }
    );
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas', 'GET', TEST_FP), reply);
    expect(reply._code()).toBe(0);
  });

  it('blocks API data routes for a PENDING beacon (403)', async () => {
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
    });
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas', 'GET', TEST_FP), reply);
    expect(reply._code()).toBe(403);
  });

  it('allows API data routes for an approved beacon', async () => {
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
      fingerprintConfirmed: true,
    });
    approveBeaconById('b-mtls');
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas', 'GET', TEST_FP), reply);
    expect(reply._code()).toBe(0);
  });
});
