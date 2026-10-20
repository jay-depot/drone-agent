import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildRedemptionSignaturePayload,
  buildTokenSignaturePayload,
  generateBurnKey,
  signBeaconPayload,
  type PreApprovalToken,
} from '../src/pre-approval.js';
import { loadCoordinatorTrust } from '../src/coordinator-trust.js';

const captured: {
  urls: string[];
  bodies: unknown[];
  fingerprint: string | undefined;
  failOn: string | null;
} = { urls: [], bodies: [], fingerprint: undefined, failOn: null };

vi.mock('../src/coordinator-fetch.js', () => ({
  createCoordinatorFetch: (
    _baseUrl: string,
    expectedCoordinatorFingerprint?: string
  ) => {
    captured.fingerprint = expectedCoordinatorFingerprint;
    return async (url: string, init?: RequestInit) => {
      captured.urls.push(url);
      if (init?.body) captured.bodies.push(JSON.parse(init.body as string));
      if (captured.failOn && url.includes(captured.failOn)) {
        return new Response('boom', { status: 503 });
      }
      return new Response(JSON.stringify({ status: 'approved' }), {
        status: 200,
      });
    };
  },
  buildCheckServerIdentity: () => () => undefined,
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { redeemPreApprovalToken } =
  await import('../src/pre-approval-redeem.js');

describe('redeemPreApprovalToken', () => {
  let dataDir: string;
  let tokenPath: string;
  let token: PreApprovalToken;

  beforeEach(async () => {
    captured.urls = [];
    captured.bodies = [];
    captured.fingerprint = undefined;
    captured.failOn = null;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'drone-redeem-'));
    const coordinator = generateBurnKey();
    const burn = generateBurnKey();
    const base = {
      durableId: 'durable-1',
      pubKey: coordinator.publicKey,
      tlsFingerprint: 'coordfingerprint',
      burnKey: burn.privateKeyPem,
    };
    token = {
      ...base,
      sig: signBeaconPayload(
        coordinator.privateKeyPem,
        buildTokenSignaturePayload(base)
      ),
    };
    tokenPath = path.join(dataDir, 'token.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tokenPath, JSON.stringify(token));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers, redeems, and writes the trust file', async () => {
    await redeemPreApprovalToken({
      coordinatorUrl: 'https://10.0.0.5:3456',
      dataDir,
      id: 'node-1',
      name: 'Node One',
      tokenPath,
    });
    expect(captured.fingerprint).toBe('coordfingerprint');
    expect(captured.urls).toHaveLength(2);
    expect(captured.urls[0]).toContain('/api/beacons');
    expect(captured.urls[1]).toContain('/api/beacons/trust/redeem');
    const redeemBody = captured.bodies[1] as Record<string, string>;
    expect(redeemBody.durableId).toBe('durable-1');
    expect(redeemBody.pubKey).toBe(token.pubKey);
    expect(
      buildRedemptionSignaturePayload({
        durableId: 'durable-1',
        clientKey: redeemBody.clientKey,
        pubKey: token.pubKey,
      })
    ).toBeTruthy();
    const trust = await loadCoordinatorTrust(dataDir);
    expect(trust).toEqual({
      coordinatorUrl: 'https://10.0.0.5:3456',
      tlsFingerprint: 'coordfingerprint',
    });
  });

  it('throws before any network call when the token signature is invalid', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      tokenPath,
      JSON.stringify({ ...token, tlsFingerprint: 'tampered' })
    );
    await expect(
      redeemPreApprovalToken({
        coordinatorUrl: 'https://10.0.0.5:3456',
        dataDir,
        id: 'node-1',
        name: 'Node One',
        tokenPath,
      })
    ).rejects.toThrow('Pre-approval token signature is invalid');
    expect(captured.urls).toHaveLength(0);
  });

  it('throws when registration fails', async () => {
    captured.failOn = '/api/beacons';
    await expect(
      redeemPreApprovalToken({
        coordinatorUrl: 'https://10.0.0.5:3456',
        dataDir,
        id: 'node-1',
        name: 'Node One',
        tokenPath,
      })
    ).rejects.toThrow(/Registration failed/);
  });

  it('throws when redemption fails', async () => {
    captured.failOn = '/api/beacons/trust/redeem';
    await expect(
      redeemPreApprovalToken({
        coordinatorUrl: 'https://10.0.0.5:3456',
        dataDir,
        id: 'node-1',
        name: 'Node One',
        tokenPath,
      })
    ).rejects.toThrow(/Redemption failed/);
  });

  it('does not write the trust file when redemption fails', async () => {
    captured.failOn = '/api/beacons/trust/redeem';
    await expect(
      redeemPreApprovalToken({
        coordinatorUrl: 'https://10.0.0.5:3456',
        dataDir,
        id: 'node-1',
        name: 'Node One',
        tokenPath,
      })
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dataDir, 'coordinator-trust.json'))
    ).rejects.toThrow();
  });
});
