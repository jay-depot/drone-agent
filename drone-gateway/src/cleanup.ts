import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from './logger.js';

/**
 * Cleanup subcommand: decommissions a Matrix adapter by logging out the
 * device on the homeserver and removing its local dataPath.
 *
 * This is an operator action — it requires explicit confirmation and is
 * NOT part of normal runtime. Use when you want to permanently retire
 * a bot account from the gateway.
 */
export async function cleanupAdapter(
  configDir: string,
  adapterId: string,
  /** Override for confirmation prompt (used in tests) */
  confirmFn?: (prompt: string) => Promise<boolean>
): Promise<void> {
  // Resolve the adapter config
  const adapterJsonPath = path.join(
    configDir,
    'adapters',
    adapterId,
    'adapter.json'
  );

  if (!existsSync(adapterJsonPath)) {
    logger.error(`Adapter "${adapterId}" not found at ${adapterJsonPath}`);
    console.error(
      `Error: Adapter "${adapterId}" not found.\n` +
        `Expected config at: ${adapterJsonPath}`
    );
    process.exit(1);
    return;
  }

  // Read adapter config
  let adapterConfig: Record<string, unknown>;
  try {
    adapterConfig = JSON.parse(readFileSync(adapterJsonPath, 'utf-8'));
  } catch (err) {
    logger.error({ adapterId, err }, `Failed to read adapter config`);
    process.exit(1);
    return;
  }

  const type = adapterConfig.type as string;
  if (type !== 'matrix') {
    logger.error(
      { adapterId, type },
      `Cleanup currently only supports "matrix" adapters`
    );
    process.exit(1);
    return;
  }

  const dataPath = adapterConfig.dataPath as string | undefined;
  const homeserverUrl = adapterConfig.homeserverUrl as string | undefined;
  const accessToken = adapterConfig.accessToken as string | undefined;
  const userId = adapterConfig.userId as string | undefined;

  if (!dataPath) {
    logger.warn(
      { adapterId },
      `Adapter "${adapterId}" has no dataPath configured — nothing to clean up locally.`
    );
  }

  if (!homeserverUrl || !accessToken || !userId) {
    logger.error(
      { adapterId },
      `Adapter "${adapterId}" is missing required fields (homeserverUrl, accessToken, userId)`
    );
    process.exit(1);
    return;
  }

  // Confirmation prompt
  console.log(
    `\n⚠️  WARNING: This will permanently decommission adapter "${adapterId}".\n` +
      `  • User: ${userId}\n` +
      `  • Homeserver: ${homeserverUrl}\n` +
      `  • Data path: ${dataPath || '(none)'}\n` +
      `\n  This will:\n` +
      `  1. Log out the device from the homeserver (invalidates the access token)\n` +
      `  2. Delete the local dataPath (crypto keys, sync state) — IRREVERSIBLE\n`
  );

  const doConfirm = confirmFn ?? promptConfirm;
  const confirmed = await doConfirm(
    `Type "yes" to confirm decommission of adapter "${adapterId}": `
  );

  if (!confirmed) {
    console.log('Cleanup cancelled.');
    process.exit(0);
    return;
  }

  // Step 1: Log out from the homeserver
  console.log(`\nLogging out device from ${homeserverUrl}...`);
  try {
    await matrixLogout(homeserverUrl, accessToken);
    console.log('  ✓ Device logged out successfully.');
  } catch (err) {
    console.error(
      `  ✗ Failed to log out device: ${err instanceof Error ? err.message : err}`
    );
    console.error(
      '  The access token may already be invalid. Continuing with local cleanup...'
    );
  }

  // Step 2: Delete dataPath
  if (dataPath && existsSync(dataPath)) {
    console.log(`Deleting dataPath: ${dataPath}...`);
    try {
      await rm(dataPath, { recursive: true, force: true });
      console.log('  ✓ dataPath deleted.');
    } catch (err) {
      console.error(
        `  ✗ Failed to delete dataPath: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
      return;
    }
  } else if (dataPath) {
    console.log(`dataPath does not exist (already cleaned up): ${dataPath}`);
  }

  console.log(`\n✅ Adapter "${adapterId}" has been decommissioned.`);
  console.log(
    `To re-use this adapter, create a new access token and re-configure adapter.json.`
  );
}

/**
 * Log out a Matrix device by calling the homeserver's logout endpoint.
 * This invalidates the access token and de-registers the device.
 */
async function matrixLogout(
  homeserverUrl: string,
  accessToken: string
): Promise<void> {
  const url = `${homeserverUrl.replace(/\/$/, '')}/_matrix/client/v3/logout`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown');
    throw new Error(`Logout failed (${res.status}): ${text}`);
  }
}

/**
 * Prompt the user for confirmation on stdin.
 */
export async function promptConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}
