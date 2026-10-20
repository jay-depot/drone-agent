import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function generateToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyToken(plain: string, expectedHash: string): boolean {
  return timingSafeEqualStrings(hashToken(plain), expectedHash);
}
