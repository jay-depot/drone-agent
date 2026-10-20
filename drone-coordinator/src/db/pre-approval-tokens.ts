import { getDatabase } from './init.js';

export interface PreApprovalTokenRow {
  durableId: string;
  burnPublicKey: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  burnedAt: number | null;
  burnedBy: string | null;
}

interface PreApprovalTokenDbRow {
  durable_id: string;
  burn_public_key: string;
  label: string | null;
  issued_at: number;
  expires_at: number;
  burned_at: number | null;
  burned_by: string | null;
}

function rowToPreApprovalToken(row: PreApprovalTokenDbRow): PreApprovalTokenRow {
  return {
    durableId: row.durable_id,
    burnPublicKey: row.burn_public_key,
    label: row.label,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    burnedAt: row.burned_at,
    burnedBy: row.burned_by,
  };
}

export function createPreApprovalToken(row: {
  durableId: string;
  burnPublicKey: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
}): PreApprovalTokenRow {
  getDatabase()
    .prepare(
      `INSERT INTO pre_approval_tokens
        (durable_id, burn_public_key, label, issued_at, expires_at, burned_at, burned_by)
       VALUES (@durableId, @burnPublicKey, @label, @issuedAt, @expiresAt, NULL, NULL)`
    )
    .run({
      durableId: row.durableId,
      burnPublicKey: row.burnPublicKey,
      label: row.label,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
    });
  return {
    durableId: row.durableId,
    burnPublicKey: row.burnPublicKey,
    label: row.label,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    burnedAt: null,
    burnedBy: null,
  };
}

export function getPreApprovalToken(
  durableId: string
): PreApprovalTokenRow | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM pre_approval_tokens WHERE durable_id = ?')
    .get(durableId) as PreApprovalTokenDbRow | undefined;
  return row ? rowToPreApprovalToken(row) : undefined;
}

export function listPreApprovalTokens(): PreApprovalTokenRow[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM pre_approval_tokens ORDER BY issued_at DESC')
    .all() as PreApprovalTokenDbRow[];
  return rows.map(rowToPreApprovalToken);
}

export function deletePreApprovalToken(durableId: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM pre_approval_tokens WHERE durable_id = ?')
    .run(durableId);
  return result.changes > 0;
}

export function burnPreApprovalToken(
  durableId: string,
  burnedBy: string,
  burnedAt: number
): boolean {
  const result = getDatabase()
    .prepare(
      'UPDATE pre_approval_tokens SET burned_at = ?, burned_by = ? WHERE durable_id = ? AND burned_at IS NULL'
    )
    .run(burnedAt, burnedBy, durableId);
  return result.changes > 0;
}
