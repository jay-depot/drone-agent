import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

describe('Coordinator TLS', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'drone-coordinator-tls-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  itIfOpenssl(
    'should generate a new TLS identity when files do not exist',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir);
      expect(identity.certPath).toBeTruthy();
      expect(identity.keyPath).toBeTruthy();
      expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.certPem).toContain('BEGIN CERTIFICATE');
      expect(identity.keyPem).toContain('BEGIN PRIVATE KEY');

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

  itIfOpenssl('should load existing TLS identity from disk', async () => {
    const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
    const first = loadOrCreateTlsIdentity(configDir);
    const second = loadOrCreateTlsIdentity(configDir);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });

  itIfOpenssl(
    'should calculate certificate fingerprint correctly',
    async () => {
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir);
      expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  );

  itIfOpenssl(
    'should return TLS options with cert and key as Buffers',
    async () => {
      const { loadOrCreateTlsIdentity, getTlsOptions } =
        await import('../src/tls.js');
      const identity = loadOrCreateTlsIdentity(configDir);
      const options = getTlsOptions(identity);
      expect(options.cert).toBeInstanceOf(Buffer);
      expect(options.key).toBeInstanceOf(Buffer);
      expect(options.cert.toString()).toContain('BEGIN CERTIFICATE');
      expect(options.key.toString()).toContain('BEGIN PRIVATE KEY');
    }
  );
});
