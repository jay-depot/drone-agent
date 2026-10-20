import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CoordinatorTrust {
  coordinatorUrl: string;
  tlsFingerprint: string;
}

const TRUST_FILENAME = 'coordinator-trust.json';

export async function saveCoordinatorTrust(
  dataDir: string,
  trust: CoordinatorTrust
): Promise<void> {
  await writeFile(
    join(dataDir, TRUST_FILENAME),
    JSON.stringify(trust, null, 2),
    { mode: 0o600 }
  );
}

export async function loadCoordinatorTrust(
  dataDir: string
): Promise<CoordinatorTrust | undefined> {
  try {
    const raw = await readFile(join(dataDir, TRUST_FILENAME), 'utf8');
    return JSON.parse(raw) as CoordinatorTrust;
  } catch {
    return undefined;
  }
}
