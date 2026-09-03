import type { FastifyRequest, FastifyReply } from 'fastify';
import { networkInterfaces } from 'os';

/**
 * API route prefixes that require auth for non-local connections.
 * Static files (/assets/*) and the SPA index (/) are always served without auth.
 */
const PROTECTED_PREFIXES = [
  '/api',
  '/beacons',
  '/skills',
  '/personas',
  '/wiki',
  '/health',
  '/knowledge',
  '/sync',
  '/sessions',
  '/agents',
  '/messages',
  '/events',
  '/insights',
  '/principles',
  '/ws',
];

/**
 * Check if an IP address falls within the Tailscale CGNAT range (100.64.0.0/10).
 * This covers 100.64.0.0 through 100.127.255.255.
 */
function isTailscaleIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const parts = normalized.split('.');
  if (parts.length !== 4) return false;

  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);

  if (isNaN(first) || isNaN(second)) return false;

  return first === 100 && second >= 64 && second <= 127;
}

/**
 * Check if a request originates from a local source.
 * Local sources include:
 * - Loopback addresses (127.0.0.1, ::1)
 * - The machine's own network interfaces
 * - Tailscale CGNAT range (100.64.0.0/10)
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip;

  // Loopback
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return true;
  }

  // Tailscale CGNAT range
  if (isTailscaleIp(ip)) {
    return true;
  }

  // Check machine's own network interfaces
  const interfaces = networkInterfaces();
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.address === ip) return true;
    }
  }

  return false;
}

/**
 * Check if a URL path should be protected by auth.
 */
function isProtectedPath(url: string): boolean {
  return PROTECTED_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Create a Fastify onRequest hook that requires a valid web token
 * for non-local requests to protected API routes.
 *
 * Static files and the SPA index.html are always served without auth
 * so the login page can load.
 */
export function createWebAuthMiddleware(getToken: () => string | null) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Only apply to protected API routes
    if (!isProtectedPath(req.url)) {
      return;
    }

    // Local requests bypass auth
    if (isLocalRequest(req)) {
      return;
    }

    const token = getToken();
    if (!token) {
      // No token configured — allow access (first-run scenario)
      return;
    }

    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (headerToken !== token) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Valid web token required for remote access',
      });
    }
  };
}
