import type { FastifyInstance } from 'fastify';
import {
  confirmCoordinatorFingerprint,
  getBeaconVerificationCode,
  getPendingCoordinatorFingerprint,
  isBeaconApproved,
  isCoordinatorTrusted,
} from '../coordinator-trust.js';

export default function coordinatorTrustRoutes(app: FastifyInstance) {
  // Report the current coordinator trust state (used by agents to surface
  // both gate halves to the user). The verification code is the beacon's
  // in-memory copy, which the user compares against the coordinator's web UI.
  app.get('/coordinator/trust', async () => {
    return {
      fingerprintTrusted: isCoordinatorTrusted(),
      beaconApproved: isBeaconApproved(),
      pendingFingerprint: getPendingCoordinatorFingerprint() ?? null,
      verificationCode: getBeaconVerificationCode() ?? null,
    };
  });

  // Compare the verification code transcribed from the coordinator's web UI
  // against the beacon's locally-computed code. A match confirms the pending
  // coordinator fingerprint (human-only, via the agent). This is the
  // compare-only half of the bidirectional handshake.
  app.post<{ Body: { verificationCode: string } }>(
    '/coordinator/trust',
    async (request, reply) => {
      const { verificationCode } = request.body ?? {};
      if (!verificationCode) {
        return reply.code(400).send({ error: 'verificationCode required' });
      }
      const expected = getBeaconVerificationCode();
      if (!expected) {
        return reply.code(400).send({
          error:
            'Beacon has no verification code yet; has it registered with the coordinator?',
        });
      }
      if (verificationCode.trim() !== expected) {
        return reply.code(400).send({
          error:
            'Verification code does not match the one the beacon computed. Check you transcribed the code from the coordinator web UI correctly — a mismatch may indicate a MitM attack.',
        });
      }
      const fp = getPendingCoordinatorFingerprint();
      if (fp) {
        confirmCoordinatorFingerprint(fp);
      }
      return { success: true };
    }
  );
}
