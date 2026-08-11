/**
 * Coordinator trust handling for the swarm plugin.
 *
 * Surfaces a pending coordinator TLS fingerprint to the user when the beacon
 * reports one, and provides a `/trust-coordinator` slash command so the user
 * can confirm the fingerprint (human-only — no auto-confirm).
 */

import type { DronePluginRegistration, DroneSlashCommand } from 'drone-core';

/**
 * Check the beacon's coordinator trust state and surface a prominent warning
 * to the user if a coordinator fingerprint is awaiting confirmation.
 */
export async function surfacePendingCoordinatorTrust(
  baseUrl: string,
  registration: DronePluginRegistration
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/coordinator/trust`);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as {
      trusted: boolean;
      pendingFingerprint: string | null;
    };
    if (!data.trusted && data.pendingFingerprint) {
      registration.logger.warn(
        `\n[SECURITY] The coordinator's TLS certificate fingerprint has not been confirmed.\n` +
          `Observed fingerprint: ${data.pendingFingerprint}\n` +
          `Verify this matches the coordinator's reported fingerprint (run ` +
          `'drone-coordinator --show-fingerprint' on the coordinator host), then run ` +
          `'/trust-coordinator ${data.pendingFingerprint}' to confirm. ` +
          `Swarm sync with the coordinator is paused until confirmed.\n`
      );
    }
  } catch (err) {
    registration.logger.warn(
      `Failed to check coordinator trust status: ${err}`
    );
  }
}

/**
 * Build the `/trust-coordinator` slash command. It confirms the pending
 * coordinator fingerprint via the beacon's confirmation endpoint.
 */
export function createTrustCoordinatorCommand(
  baseUrl: string
): DroneSlashCommand {
  return {
    command: '/trust-coordinator',
    description:
      'Confirm the coordinator TLS fingerprint (TOFU) to enable swarm sync',
    handler: async ctx => {
      const fingerprint = ctx.args[0];
      if (!fingerprint) {
        ctx.logger.info(
          'Usage: /trust-coordinator <fingerprint>\n' +
            'Provide the coordinator TLS fingerprint shown in the pending warning.'
        );
        return true;
      }
      try {
        const res = await fetch(`${baseUrl}/coordinator/trust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          ctx.logger.warn(
            `Failed to confirm coordinator fingerprint: ${body.error ?? res.status}`
          );
          return true;
        }
        ctx.logger.info(
          'Coordinator TLS fingerprint confirmed. Swarm sync with the coordinator is now enabled.'
        );
      } catch (err) {
        ctx.logger.warn(`Failed to confirm coordinator fingerprint: ${err}`);
      }
      return true;
    },
  };
}
