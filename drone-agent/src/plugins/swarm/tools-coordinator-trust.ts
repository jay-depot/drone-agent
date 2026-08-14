/**
 * Coordinator trust handling for the swarm plugin.
 *
 * Surfaces both halves of the coordinator trust gate to the user when the
 * beacon reports them, and provides a `/trust-coordinator <code>` slash
 * command so the user can confirm the coordinator fingerprint by transcribing
 * the verification code from the coordinator's web UI. The beacon compares the
 * transcribed code against its own in-memory copy (compare-only) — a match
 * confirms the fingerprint (human-only, no auto-confirm).
 */

import type { DronePluginRegistration, DroneSlashCommand } from 'drone-core';

/**
 * Check the beacon's coordinator trust state and surface a prominent warning
 * to the user if either half of the both-sides gate is unmet, along with the
 * guidance to read the verification code from the coordinator's web UI.
 * The verification code itself is never surfaced here — it is display-only in
 * the web UI and compare-only on the beacon side.
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
      fingerprintTrusted: boolean;
      beaconApproved: boolean;
      pendingFingerprint: string | null;
    };
    const ready = data.fingerprintTrusted && data.beaconApproved;
    if (ready) {
      return;
    }

    const lines: string[] = [
      '\n[SECURITY] Swarm sync with the coordinator is not fully established.',
    ];
    if (!data.fingerprintTrusted) {
      lines.push(
        `- The coordinator's TLS certificate fingerprint has not been confirmed.`
      );
    }
    if (!data.beaconApproved) {
      lines.push(`- The coordinator has not yet approved this beacon.`);
    }
    lines.push(
      `- Verify the coordinator is the one you expect: open the coordinator web UI ` +
        `(beacon detail page), read the 4-word verification code it displays, then ` +
        `run '/trust-coordinator <code>' here with that exact value. The beacon ` +
        `compares your transcribed code against its own copy — it never displays ` +
        `the code itself, so the comparison is meaningful.`
    );
    registration.logger.warn(lines.join('\n'));
  } catch (err) {
    registration.logger.warn(
      `Failed to check coordinator trust status: ${err}`
    );
  }
}

/**
 * Build the `/trust-coordinator` slash command. It compares the verification
 * code transcribed from the coordinator's web UI against the beacon's copy via
 * the beacon's compare-only confirmation endpoint.
 */
export function createTrustCoordinatorCommand(
  baseUrl: string
): DroneSlashCommand {
  return {
    command: '/trust-coordinator',
    description:
      'Confirm the coordinator identity by entering the verification code shown in the coordinator web UI (enables swarm sync)',
    handler: async ctx => {
      const verificationCode = ctx.args[0];
      if (!verificationCode) {
        ctx.logger.info(
          'Usage: /trust-coordinator <verification-code>\n' +
            'Open the coordinator web UI (beacon detail page) and enter the ' +
            'verification code it displays here to confirm the coordinator ' +
            'fingerprint.'
        );
        return true;
      }
      try {
        const res = await fetch(`${baseUrl}/coordinator/trust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verificationCode }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          ctx.logger.warn(
            `Failed to confirm coordinator: ${body.error ?? res.status}`
          );
          return true;
        }
        ctx.logger.info(
          'Verification code matched. Coordinator fingerprint confirmed. ' +
            'Swarm sync with the coordinator is now enabled (pending beacon approval).'
        );
      } catch (err) {
        ctx.logger.warn(`Failed to confirm coordinator: ${err}`);
      }
      return true;
    },
  };
}
