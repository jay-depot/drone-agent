import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';

let logger: pino.Logger = pino({ name: 'drone-swarm-common', level: 'silent' });

export function setTlsLogger(l: pino.Logger): void {
  logger = l;
}

export interface TlsIdentity {
  certPath: string;
  keyPath: string;
  fingerprint: string;
  certPem: string;
  keyPem: string;
}

/**
 * Calculate SHA-256 fingerprint of a certificate.
 */
function calculateCertFingerprint(certPem: string): string {
  const cert = new crypto.X509Certificate(certPem);
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

/**
 * Generate a self-signed TLS certificate using openssl.
 */
function generateTlsCertificateWithOpenssl(
  configDir: string,
  commonName: string = 'localhost'
): { certPem: string; keyPem: string } {
  const tempDir = configDir;

  try {
    // Use -subj with just CN (no O= to avoid + being interpreted as RDN separator).
    // execFileSync with an explicit argv array avoids shell injection from commonName/tempDir.
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', path.join(tempDir, 'temp-key.pem'),
        '-out', path.join(tempDir, 'temp-cert.pem'),
        '-days', '365',
        '-nodes',
        '-subj', `/CN=${commonName}`,
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'pipe' }
    );

    const certPem = fs.readFileSync(path.join(tempDir, 'temp-cert.pem'), 'utf-8');
    const keyPem = fs.readFileSync(path.join(tempDir, 'temp-key.pem'), 'utf-8');

    fs.unlinkSync(path.join(tempDir, 'temp-cert.pem'));
    fs.unlinkSync(path.join(tempDir, 'temp-key.pem'));

    return { certPem, keyPem };
  } catch (err) {
    try {
      if (fs.existsSync(path.join(tempDir, 'temp-cert.pem')))
        fs.unlinkSync(path.join(tempDir, 'temp-cert.pem'));
      if (fs.existsSync(path.join(tempDir, 'temp-key.pem')))
        fs.unlinkSync(path.join(tempDir, 'temp-key.pem'));
    } catch {
      // Cleanup is best-effort — ignore failures
    }
    throw err;
  }
}

/**
 * Load existing TLS identity from disk or generate new one.
 */
export function loadOrCreateTlsIdentity(
  configDir: string,
  serviceName: string = 'beacon',
  commonName: string = 'localhost'
): TlsIdentity {
  const certPath = path.join(configDir, `${serviceName}-cert.pem`);
  const keyPath = path.join(configDir, `${serviceName}-key.pem`);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const certPem = fs.readFileSync(certPath, 'utf-8');
      const keyPem = fs.readFileSync(keyPath, 'utf-8');
      const fingerprint = calculateCertFingerprint(certPem);

      logger.info(
        `Loaded existing TLS certificate (fingerprint: ${fingerprint})`
      );
      return { certPath, keyPath, fingerprint, certPem, keyPem };
    } catch (err) {
      logger.warn(`Failed to load TLS certificate, generating new one: ${err}`);
    }
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let certPem: string;
  let keyPem: string;

  try {
    const result = generateTlsCertificateWithOpenssl(configDir, commonName);
    certPem = result.certPem;
    keyPem = result.keyPem;
  } catch {
    throw new Error(
      'Certificate generation failed. Install openssl or provide certificates manually.'
    );
  }

  const fingerprint = calculateCertFingerprint(certPem);

  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(keyPath, keyPem);
  fs.chmodSync(keyPath, 0o600);

  logger.info(
    `Generated and saved new TLS certificate (fingerprint: ${fingerprint})`
  );
  return { certPath, keyPath, fingerprint, certPem, keyPem };
}

/**
 * Get TLS options for HTTPS server.
 */
export function getTlsOptions(identity: TlsIdentity): {
  cert: Buffer;
  key: Buffer;
} {
  return {
    cert: Buffer.from(identity.certPem),
    key: Buffer.from(identity.keyPem),
  };
}
