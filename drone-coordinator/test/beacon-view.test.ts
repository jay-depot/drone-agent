import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildBeaconView, buildInitialBeaconList } from '../src/beacon-view.js';
import {
  registerBeacon,
  registerBeaconTrust,
  confirmBeaconFingerprint,
  getBeaconTrust,
} from '../src/db/index.js';
import {
  _registerTestConnection,
  resetBeaconConnections,
} from '../src/beacon-ws.js';

function makeFakeWs() {
  return {
    send: () => {},
    ping: () => {},
    terminate: () => {},
    on: () => {},
    close: () => {},
    readyState: 1,
  } as never;
}

const TRUST_PAYLOAD = {
  id: 'b1',
  name: 'B1',
  host: '10.0.0.1',
  port: 3457,
  publicKey: 'key1',
};

beforeEach(async () => {
  resetBeaconConnections();
  await setupDb();
});

afterEach(async () => {
  resetBeaconConnections();
  await teardownDb();
});

describe('buildBeaconView', () => {
  it('defaults every trust field when there is no trust record', () => {
    expect(buildBeaconView('missing', undefined)).toEqual({
      connected: false,
      trustStatus: null,
      publicKey: null,
      verificationCode: null,
      fingerprintConfirmed: false,
    });
  });

  it('maps trust status/publicKey/verificationCode and reports fingerprintConfirmed=false before the announce', () => {
    const trust = registerBeaconTrust(TRUST_PAYLOAD);
    const view = buildBeaconView('b1', trust);
    expect(view.trustStatus).toBe('pending');
    expect(view.publicKey).toBe('key1');
    expect(view.verificationCode).toBe(trust.verificationCode);
    expect(view.fingerprintConfirmed).toBe(false);
  });

  it('reports fingerprintConfirmed=true once the fingerprint is confirmed', () => {
    registerBeaconTrust(TRUST_PAYLOAD);
    confirmBeaconFingerprint('b1');
    expect(
      buildBeaconView('b1', getBeaconTrust('b1')).fingerprintConfirmed
    ).toBe(true);
  });

  it('reflects the reverse-channel connection state', () => {
    _registerTestConnection('b1', makeFakeWs());
    expect(buildBeaconView('b1', undefined).connected).toBe(true);
    expect(buildBeaconView('other', undefined).connected).toBe(false);
  });
});

describe('WS initial beacon snapshot contract', () => {
  it('carries the trust fields the UI needs', () => {
    registerBeacon({ id: 'b1', name: 'B1', host: '10.0.0.1', port: 3457 });
    registerBeaconTrust(TRUST_PAYLOAD);
    confirmBeaconFingerprint('b1');

    const initialBeacons = buildInitialBeaconList();

    const b1 = initialBeacons.find(b => b.id === 'b1');
    expect(b1).toBeDefined();
    expect(b1!.trustStatus).toBe('pending');
    expect(b1!.verificationCode).toBeTruthy();
    expect(b1!.fingerprintConfirmed).toBe(true);
  });
});
