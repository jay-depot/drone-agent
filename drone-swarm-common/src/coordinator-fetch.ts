import http from 'http';
import https from 'https';
import type { PeerCertificate, TLSSocket } from 'tls';
import type { TlsIdentity } from './tls.js';

/**
 * Build the `checkServerIdentity` override used for coordinator TLS
 * connections. When `expectedFingerprint` is provided the server's SHA-256
 * certificate fingerprint is verified against it (TOFU-style MITM protection
 * without a trusted CA). When no fingerprint is known yet (first connection)
 * `onFirstFingerprint` is called with the observed fingerprint so the caller
 * can persist it; the connection is still accepted — this is the intentional
 * Trust-On-First-Use window.
 */
export function buildCheckServerIdentity(
  expectedFingerprint: string | undefined,
  onFirstFingerprint?: (fp: string) => void
): (hostname: string, cert: PeerCertificate) => Error | undefined {
  return (_hostname, cert) => {
    const raw = cert.fingerprint256;
    if (!raw) {
      return new Error('TLS: coordinator certificate has no fingerprint');
    }
    const observed = raw.replace(/:/g, '').toLowerCase();
    if (expectedFingerprint) {
      if (observed !== expectedFingerprint.toLowerCase()) {
        return new Error(
          `TLS: coordinator certificate fingerprint mismatch — expected ${expectedFingerprint} but got ${observed}. Possible MITM attack.`
        );
      }
    } else {
      onFirstFingerprint?.(observed);
    }
    return undefined;
  };
}

/**
 * Create a fetch-compatible function that connects to a coordinator.
 *
 * The coordinator uses a self-signed TLS certificate so standard CA
 * validation is disabled (`rejectUnauthorized: false`). MITM protection is
 * instead provided by certificate-fingerprint pinning via
 * `checkServerIdentity`: when `expectedCoordinatorFingerprint` is supplied the
 * server certificate is verified against that pinned SHA-256 hash. On the very
 * first connection — before the fingerprint is known — any certificate is
 * accepted and `onFirstFingerprint` is called so the caller can persist the
 * observed fingerprint for subsequent connections (TOFU).
 *
 * CodeQL note: `rejectUnauthorized: false` is intentional. CA validation is
 * inapplicable to self-signed certificates; MITM protection is provided by the
 * fingerprint check above.
 */
export function createCoordinatorFetch(
  baseUrl: string,
  expectedCoordinatorFingerprint?: string,
  onFirstFingerprint?: (fp: string) => void,
  tlsIdentity?: TlsIdentity
): typeof fetch {
  const urlObj = new URL(baseUrl);
  const isHttps = urlObj.protocol === 'https:';

  return async function coordinatorFetch(
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const fullUrl = urlStr.startsWith('http') ? urlStr : `${baseUrl}${urlStr}`;
    const parsedUrl = new URL(fullUrl);

    const method = init?.method ?? 'GET';
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body as string | undefined;

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      if (isHttps) {
        // codeql[js/disabling-certificate-verification]
        (options as https.RequestOptions).rejectUnauthorized = false;
        (options as https.RequestOptions).checkServerIdentity =
          buildCheckServerIdentity(
            expectedCoordinatorFingerprint,
            onFirstFingerprint
          );
        if (tlsIdentity) {
          (options as https.RequestOptions).cert = tlsIdentity.certPem;
          (options as https.RequestOptions).key = tlsIdentity.keyPem;
        }
      }

      const req = (isHttps ? https : http).request(options, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve(
            new Response(bodyBuffer, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? '',
              headers: res.headers as Record<string, string>,
            })
          );
        });
      });

      // `checkServerIdentity` is never invoked when `rejectUnauthorized` is
      // false (Node skips server-identity verification), so observe the peer
      // certificate ourselves once the TLS handshake completes. This both
      // records the fingerprint on first contact (TOFU) and enforces the
      // pinned fingerprint on subsequent connections.
      if (isHttps) {
        req.on('socket', socket => {
          socket.on('secureConnect', () => {
            const cert = (socket as TLSSocket).getPeerCertificate();
            const raw = cert?.fingerprint256;
            if (!raw) {
              return;
            }
            const observed = raw.replace(/:/g, '').toLowerCase();
            if (expectedCoordinatorFingerprint) {
              if (observed !== expectedCoordinatorFingerprint.toLowerCase()) {
                req.destroy(
                  new Error(
                    `TLS: coordinator certificate fingerprint mismatch — expected ${expectedCoordinatorFingerprint} but got ${observed}. Possible MITM attack.`
                  )
                );
              }
            } else {
              onFirstFingerprint?.(observed);
            }
          });
        });
      }

      req.on('error', err => {
        reject(err);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  };
}
