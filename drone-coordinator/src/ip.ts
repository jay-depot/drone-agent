/**
 * Loopback detection from a socket peer address. The socket (not any
 * request-body claim) is the source of truth for locality, so a remote
 * caller cannot auto-approve itself by claiming `host: "localhost"`.
 */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  // Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x) and unbracketed forms.
  let normalized = ip;
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }
  normalized = normalized.replace(/^\[|\]$/g, '');

  if (normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  // Loopback block 127.0.0.0/8.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }
  return false;
}
