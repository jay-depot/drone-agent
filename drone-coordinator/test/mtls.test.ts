import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  createMtlsMiddleware,
  getClientCertFingerprint,
  resolveBeaconIdByFingerprint,
} from '../src/mtls.js';
import { registerBeaconTrust } from '../src/db/index.js';

const TEST_FP =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function makeReq(url: string, method = 'GET', certFingerprint?: string) {
  return {
    url,
    method,
    socket: {
      getPeerCertificate: () =>
        certFingerprint ? { fingerprint256: certFingerprint } : false,
    },
  } as any;
}

function makeReply() {
  let code = 0;
  let sent: any = null;
  return {
    code: (c: number) => {
      code = c;
      return {
        send: (s: any) => {
          sent = s;
        },
      };
    },
    _sent: () => sent,
    _code: () => code,
  } as any;
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
    registerBeaconTrust({
      id: 'b-mtls',
      name: 'MTLS Beacon',
      host: 'localhost',
      port: 3457,
      publicKey: 'pubkey',
      tlsFingerprint: TEST_FP,
    });
    const middleware = createMtlsMiddleware({ httpsEnabled: true });
    const reply = makeReply();
    await middleware(makeReq('/api/personas', 'GET', TEST_FP), reply);
    expect(reply._code()).toBe(0);
  });
});
