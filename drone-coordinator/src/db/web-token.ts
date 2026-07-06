import { randomBytes } from 'node:crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';

function generateWebTokenValue(): string {
  return randomBytes(16).toString('hex');
}

export function getWebToken(): string | null {
  const stmt = getDatabase().prepare(
    'SELECT token FROM web_token ORDER BY id DESC LIMIT 1'
  );
  const row = stmt.get() as { token: string } | undefined;
  return row?.token ?? null;
}

export function generateWebToken(): string {
  const token = generateWebTokenValue();
  const now = Date.now();

  // Replace any existing token
  const stmt = getDatabase().prepare(
    'INSERT INTO web_token (token, created_at) VALUES (@token, @createdAt)'
  );
  stmt.run({ token, createdAt: now });

  logger.info('Generated new web token');
  return token;
}

export function initWebToken(): string {
  const existing = getWebToken();
  if (existing) return existing;
  return generateWebToken();
}
