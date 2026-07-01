import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const hasOpenssl = (() => {
  try {
    execSync('openssl version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const itIfOpenssl = hasOpenssl ? it : it.skip;

describe('TLS', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'drone-tls-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  itIfOpenssl(
    'should generate a new TLS identity when files do not exist (beacon)',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir, 'beacon');
      expect(identity.certPath).toContain('beacon-cert.pem');
      expect(identity.keyPath).toContain('beacon-key.pem');
      expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.certPem).toContain('BEGIN CERTIFICATE');
      expect(identity.keyPem).toContain('BEGIN PRIVATE KEY');
    }
  );

  itIfOpenssl(
    'should generate a new TLS identity when files do not exist (coordinator)',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir, 'coordinator');
      expect(identity.certPath).toContain('coordinator-cert.pem');
      expect(identity.keyPath).toContain('coordinator-key.pem');
    }
  );

  itIfOpenssl('should load existing TLS identity from disk', async () => {
    const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
    const first = loadOrCreateTlsIdentity(configDir, 'beacon');
    const second = loadOrCreateTlsIdentity(configDir, 'beacon');
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });

  itIfOpenssl(
    'should calculate certificate fingerprint correctly',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir, 'beacon');
      expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  );

  itIfOpenssl(
    'should return TLS options with cert and key as Buffers',
    async () => {
      const { loadOrCreateTlsIdentity, getTlsOptions } =
        await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir, 'beacon');
      const options = getTlsOptions(identity);
      expect(options.cert).toBeInstanceOf(Buffer);
      expect(options.key).toBeInstanceOf(Buffer);
      expect(options.cert.toString()).toContain('BEGIN CERTIFICATE');
      expect(options.key.toString()).toContain('BEGIN PRIVATE KEY');
    }
  );

  itIfOpenssl(
    'should verify files exist on disk after generation',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir, 'coordinator');
      
      const certExists = await readFile(identity.certPath, 'utf-8')
        .then(() => true)
        .catch(() => false);
      const keyExists = await readFile(identity.keyPath, 'utf-8')
        .then(() => true)
        .catch(() => false);
      expect(certExists).toBe(true);
      expect(keyExists).toBe(true);
    }
  );

  itIfOpenssl(
    'should work with different service names',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const beaconIdentity = loadOrCreateTlsIdentity(configDir, 'beacon');
      const coordIdentity = loadOrCreateTlsIdentity(configDir, 'coordinator');
      
      // They should be different files
      expect(beaconIdentity.certPath).not.toBe(coordIdentity.certPath);
      expect(beaconIdentity.keyPath).not.toBe(coordIdentity.keyPath);
      expect(beaconIdentity.fingerprint).not.toBe(coordIdentity.fingerprint);
    }
  );
});